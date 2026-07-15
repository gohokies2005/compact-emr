import { describe, it, expect, vi } from 'vitest';
import {
  extractFirstBalancedJson,
  parseDocTitleResponse,
  slugifyTitle,
  deriveFilenameFromTitle,
  withCollisionSuffix,
  mergeGrantedConditionBackstop,
  isRatingDecision,
  modelAcceptsPrefill,
  generateAndPersistDocumentTitle,
  type DocTitleResult,
} from '../aiDocumentTitle.js';
import type { AppDb } from '../db-types.js';

describe('extractFirstBalancedJson', () => {
  it('returns a clean object unchanged', () => {
    expect(extractFirstBalancedJson('{"a":1}')).toBe('{"a":1}');
  });
  it('stops at the first balanced object and ignores trailing prose', () => {
    // Haiku sometimes appends a sentence after the closing brace.
    expect(extractFirstBalancedJson('{"a":1} Here is why I chose that.')).toBe('{"a":1}');
  });
  it('ignores leading prose before the object', () => {
    expect(extractFirstBalancedJson('Sure! {"a":1}')).toBe('{"a":1}');
  });
  it('handles nested objects', () => {
    const s = '{"a":{"b":2},"c":3}';
    expect(extractFirstBalancedJson(s)).toBe(s);
  });
  it('does not count braces inside strings', () => {
    const s = '{"title":"weird } name {","n":1}';
    expect(extractFirstBalancedJson(s)).toBe(s);
  });
  it('handles escaped quotes inside strings', () => {
    const s = '{"title":"a \\"quoted\\" bit","n":1}';
    expect(extractFirstBalancedJson(s)).toBe(s);
  });
  it('returns null on a truncated (unterminated) object', () => {
    expect(extractFirstBalancedJson('{"title":"OSA granted","conditions":[{"name":"OS')).toBeNull();
  });
  it('returns null when there is no object', () => {
    expect(extractFirstBalancedJson('no json here')).toBeNull();
  });
});

describe('parseDocTitleResponse', () => {
  it('parses a full valid response', () => {
    const raw = JSON.stringify({
      title: 'VA Rating Decision — OSA granted 50%, GERD denied',
      doc_type: 'Rating Decision',
      form_id: null,
      conditions: [
        { name: 'Obstructive Sleep Apnea', outcome: 'granted', percent: 50 },
        { name: 'GERD', outcome: 'denied', percent: null },
      ],
      confidence: 'high',
    });
    const r = parseDocTitleResponse(raw);
    expect(r).not.toBeNull();
    expect(r!.title).toContain('OSA granted 50%');
    expect(r!.doc_type).toBe('Rating Decision');
    expect(r!.conditions).toHaveLength(2);
    expect(r!.conditions[0]).toEqual({ name: 'Obstructive Sleep Apnea', outcome: 'granted', percent: 50 });
    expect(r!.confidence).toBe('high');
  });
  it('strips trailing prose after the closing brace', () => {
    const raw = '{"title":"DD Form 214","doc_type":"Service Record","form_id":"DD Form 214","conditions":[],"confidence":"high"}\nThat is a discharge document.';
    const r = parseDocTitleResponse(raw);
    expect(r).not.toBeNull();
    expect(r!.title).toBe('DD Form 214');
    expect(r!.form_id).toBe('DD Form 214');
  });
  it('works with a prefill-reconstructed object (leading brace re-attached by the caller)', () => {
    // makeDocumentTitler prefixes the completion with the prefilled '{'.
    const completionBody = '"title":"Sleep study","doc_type":"Sleep Study","form_id":null,"conditions":[],"confidence":"medium"}';
    const r = parseDocTitleResponse('{' + completionBody);
    expect(r).not.toBeNull();
    expect(r!.title).toBe('Sleep study');
    expect(r!.confidence).toBe('medium');
  });
  it('returns null on truncated JSON', () => {
    const raw = '{"title":"VA Rating Decision","doc_type":"Rating Decision","conditions":[{"name":"OSA","outcome":"gran';
    expect(parseDocTitleResponse(raw)).toBeNull();
  });
  it('returns null when title is missing or blank', () => {
    expect(parseDocTitleResponse('{"doc_type":"Rating Decision","conditions":[]}')).toBeNull();
    expect(parseDocTitleResponse('{"title":"   ","doc_type":"x"}')).toBeNull();
  });
  it('returns null on non-JSON', () => {
    expect(parseDocTitleResponse('I could not read this document.')).toBeNull();
  });
  it('drops malformed condition rows rather than inventing an outcome', () => {
    const raw = '{"title":"Rating Decision","doc_type":"Rating Decision","conditions":[{"name":"OSA","outcome":"granted","percent":50},{"name":"noop"},{"outcome":"denied"}],"confidence":"high"}';
    const r = parseDocTitleResponse(raw);
    expect(r).not.toBeNull();
    expect(r!.conditions).toHaveLength(1);
    expect(r!.conditions[0]!.name).toBe('OSA');
  });
  it('coerces a percent given as a string', () => {
    const raw = '{"title":"x","doc_type":"y","conditions":[{"name":"OSA","outcome":"granted","percent":"50%"}],"confidence":"low"}';
    const r = parseDocTitleResponse(raw);
    expect(r!.conditions[0]!.percent).toBe(50);
  });
  it('defaults an unknown confidence to low', () => {
    const raw = '{"title":"x","doc_type":"y","conditions":[],"confidence":"pretty sure"}';
    expect(parseDocTitleResponse(raw)!.confidence).toBe('low');
  });
});

describe('slugifyTitle', () => {
  it('lowercases, replaces punctuation/spaces with hyphens, trims', () => {
    expect(slugifyTitle('VA Rating Decision — OSA granted 50%')).toBe('va-rating-decision-osa-granted-50');
  });
  it('caps length ~60 and never trails a hyphen', () => {
    const s = slugifyTitle('a'.repeat(80));
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s.endsWith('-')).toBe(false);
  });
  it('falls back to "document" when nothing survives', () => {
    expect(slugifyTitle('—  %%%  —')).toBe('document');
  });
});

describe('deriveFilenameFromTitle', () => {
  it('builds <LastName>_<slug>.pdf by default', () => {
    expect(deriveFilenameFromTitle('Lozano', 'VA Rating Decision — OSA granted 50%')).toBe('Lozano_va-rating-decision-osa-granted-50.pdf');
  });
  it('preserves a real document extension from the original filename', () => {
    expect(deriveFilenameFromTitle('Woodley', 'Lay statement', 'Woodley_GERD_Misc_4.docx')).toBe('Woodley_lay-statement.docx');
  });
  it('defaults an unknown/absent extension to pdf', () => {
    expect(deriveFilenameFromTitle('Frank', 'Sleep study', 'scan')).toBe('Frank_sleep-study.pdf');
  });
  it('sanitizes the last name and falls back to Veteran', () => {
    expect(deriveFilenameFromTitle(null, 'Intake summary')).toBe('Veteran_intake-summary.pdf');
    expect(deriveFilenameFromTitle("O'Brien", 'Intake summary')).toBe('OBrien_intake-summary.pdf');
  });
  it('slugs the concise docType, NOT the rich multi-condition title, when docType is given', () => {
    // The rich title stays for DISPLAY; the filename stays short (Ryan 2026-07-01).
    const richTitle = 'VA Rating Decision — Lumbosacral 10%, Plantar Fasciitis 10%, Migraine 0%, MDD 50%, OSA 50%, nerve paralysis denied';
    expect(deriveFilenameFromTitle('Margo', richTitle, 'Margo_Migraine_Misc_4.pdf', 'VA Rating Decision')).toBe('Margo_va-rating-decision.pdf');
  });
  it('falls back to the title slug when docType is empty/absent', () => {
    expect(deriveFilenameFromTitle('Frank', 'Sleep study', 'x.pdf', '')).toBe('Frank_sleep-study.pdf');
    expect(deriveFilenameFromTitle('Frank', 'Sleep study', 'x.pdf')).toBe('Frank_sleep-study.pdf');
  });
  it('strips a leading veteran-name echo so the LastName_ prefix is not doubled', () => {
    // Model sometimes embeds the name; the LastName_ prefix already identifies the vet.
    expect(deriveFilenameFromTitle('Margo', 'x', 'x.pdf', 'Margo — Nexus Letter')).toBe('Margo_nexus-letter.pdf');
  });
});

describe('withCollisionSuffix', () => {
  it('returns the name unchanged when it does not collide', () => {
    expect(withCollisionSuffix('Lozano_osa.pdf', new Set())).toBe('Lozano_osa.pdf');
  });
  it('numbers a collision before the extension', () => {
    expect(withCollisionSuffix('Lozano_osa.pdf', new Set(['Lozano_osa.pdf']))).toBe('Lozano_osa_2.pdf');
  });
  it('skips already-taken numbered variants', () => {
    expect(withCollisionSuffix('Lozano_osa.pdf', new Set(['Lozano_osa.pdf', 'Lozano_osa_2.pdf']))).toBe('Lozano_osa_3.pdf');
  });
});

describe('isRatingDecision', () => {
  const base: DocTitleResult = { title: 't', doc_type: 'Rating Decision', form_id: null, conditions: [], confidence: 'high' };
  it('detects a rating decision doc_type', () => {
    expect(isRatingDecision(base)).toBe(true);
    expect(isRatingDecision({ ...base, doc_type: 'VA Rating Decision letter' })).toBe(true);
  });
  it('is false for other doc types', () => {
    expect(isRatingDecision({ ...base, doc_type: 'Sleep Study' })).toBe(false);
  });
});

describe('mergeGrantedConditionBackstop', () => {
  const decision: DocTitleResult = {
    title: 'VA Rating Decision — GERD denied',
    doc_type: 'Rating Decision',
    form_id: null,
    conditions: [{ name: 'GERD', outcome: 'denied', percent: null }],
    confidence: 'high',
  };
  it('appends a grounded granted condition the model missed, and surfaces it in the title', () => {
    const r = mergeGrantedConditionBackstop(decision, ['Obstructive Sleep Apnea']);
    expect(r.conditions).toHaveLength(2);
    expect(r.conditions.some((c) => c.name === 'Obstructive Sleep Apnea' && c.outcome === 'granted')).toBe(true);
    expect(r.title).toContain('Obstructive Sleep Apnea granted');
  });
  it('is a no-op when the granted condition is already listed (normalized match)', () => {
    const withOsa: DocTitleResult = { ...decision, conditions: [{ name: 'OSA (obstructive sleep apnea)', outcome: 'granted', percent: 50 }] };
    const r = mergeGrantedConditionBackstop(withOsa, ['OSA obstructive sleep apnea']);
    expect(r).toBe(withOsa); // unchanged reference
  });
  it('is a no-op with no granted rows', () => {
    expect(mergeGrantedConditionBackstop(decision, [])).toBe(decision);
  });
  it('dedupes repeated granted names', () => {
    const r = mergeGrantedConditionBackstop(decision, ['Tinnitus', 'tinnitus', 'TINNITUS']);
    expect(r.conditions.filter((c) => /tinnitus/i.test(c.name))).toHaveLength(1);
  });
  it('dedupes word-order variants (does not double-append)', () => {
    // Model listed the condition one way; the grounded SC row names it reordered.
    const withReordered: DocTitleResult = { ...decision, conditions: [{ name: 'Sleep Apnea, Obstructive', outcome: 'granted', percent: 50 }] };
    const r = mergeGrantedConditionBackstop(withReordered, ['Obstructive Sleep Apnea']);
    expect(r).toBe(withReordered); // unchanged reference — recognized as the same condition
  });
});

// ── system-artifact guard (dup-mint incident 2026-07-14): the titler renaming the generated
// Intake_Summary.pdf defeated the assign-time filename-equality idempotency guard → duplicate mints.
// Our own generated artifacts (reserved s3Key shapes) must NEVER be retitled. ──
describe('generateAndPersistDocumentTitle — system-artifact guard', () => {
  function dbWithDoc(doc: Record<string, unknown> | null, update?: ReturnType<typeof vi.fn>) {
    return {
      document: {
        findUnique: vi.fn(async () => doc),
        findMany: vi.fn(async () => []),
        update: update ?? vi.fn(async () => ({})),
      },
    } as unknown as AppDb;
  }
  const baseDoc = { id: 'doc-1', filename: 'Intake_Summary.pdf', autoTitle: null, caseId: 'CLM-1', case: null };

  it('skips the generated Intake_Summary.pdf (reserved s3Key suffix) — never retitled, no model call', async () => {
    const update = vi.fn(async () => ({}));
    const db = dbWithDoc({ ...baseDoc, s3Key: 'cases/CLM-1/i1-Intake_Summary.pdf' }, update);
    const r = await generateAndPersistDocumentTitle(db, 'doc-1');
    expect(r).toEqual({ documentId: 'doc-1', updated: false, skipped: 'system_artifact' });
    expect(update).not.toHaveBeenCalled();
  });

  it('skips a Doctor_Pack artifact by s3Key substring', async () => {
    const db = dbWithDoc({ ...baseDoc, filename: 'pack.pdf', s3Key: 'cases/CLM-1/Doctor_Pack_v2.pdf' });
    const r = await generateAndPersistDocumentTitle(db, 'doc-1');
    expect(r.skipped).toBe('system_artifact');
    expect(r.updated).toBe(false);
  });

  it('skips even under force (a system artifact is never retitleable)', async () => {
    const db = dbWithDoc({ ...baseDoc, s3Key: 'cases/CLM-1/i1-Intake_Summary.pdf' });
    const r = await generateAndPersistDocumentTitle(db, 'doc-1', { force: true });
    expect(r.skipped).toBe('system_artifact');
  });

  it('does NOT over-match a normal document (falls through to the already_titled path)', async () => {
    // A real uploaded record with a normal key + an existing title proceeds PAST the artifact guard
    // and hits the already_titled skip — proving the guard only matches reserved key shapes.
    const db = dbWithDoc({ ...baseDoc, filename: 'Lozano_sleep-study.pdf', s3Key: 'cases/CLM-1/3f2a9c1e-Lozano_records.pdf', autoTitle: 'Sleep study' });
    const r = await generateAndPersistDocumentTitle(db, 'doc-1');
    expect(r.skipped).toBe('already_titled');
  });

  it('a veteran-uploaded "<Last>_Intake_Summary.pdf" is NOT blocked (key ends "_Intake…", not the reserved "-Intake…")', async () => {
    // The guard keys on the reserved '-Intake_Summary.pdf' s3Key suffix only the GENERATED summary
    // carries. A real uploaded record named Lozano_Intake_Summary.pdf gets the key
    // `<uuid>-Lozano_Intake_Summary.pdf` — its suffix is '_Intake_Summary.pdf' (underscore), so the
    // guard does not match and the doc proceeds (here to already_titled). Mirrors chart-readiness's
    // reserved-suffix distinction.
    const db = dbWithDoc({ ...baseDoc, filename: 'Lozano_Intake_Summary.pdf', s3Key: 'cases/CLM-1/3f2a9c1e-Lozano_Intake_Summary.pdf', autoTitle: 'existing' });
    const r = await generateAndPersistDocumentTitle(db, 'doc-1');
    expect(r.skipped).toBe('already_titled');
  });
});

describe('modelAcceptsPrefill', () => {
  it('is true for 4.5-tier models (prefill + temperature OK)', () => {
    expect(modelAcceptsPrefill('claude-haiku-4-5-20251001')).toBe(true);
    expect(modelAcceptsPrefill('claude-haiku-4-5')).toBe(true);
    expect(modelAcceptsPrefill('claude-sonnet-4-5')).toBe(true);
    expect(modelAcceptsPrefill('claude-opus-4-5')).toBe(true);
    expect(modelAcceptsPrefill('claude-3-5-haiku-latest')).toBe(true);
  });
  it('is false for the 4.6+/5 family (prefill + temperature 400)', () => {
    expect(modelAcceptsPrefill('claude-opus-4-6')).toBe(false);
    expect(modelAcceptsPrefill('claude-opus-4-7')).toBe(false);
    expect(modelAcceptsPrefill('claude-opus-4-8')).toBe(false);
    expect(modelAcceptsPrefill('claude-sonnet-4-6')).toBe(false);
    expect(modelAcceptsPrefill('claude-sonnet-5')).toBe(false);
    expect(modelAcceptsPrefill('claude-fable-5')).toBe(false);
  });
});
