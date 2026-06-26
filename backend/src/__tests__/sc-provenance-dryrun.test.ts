import { describe, it, expect } from 'vitest';
import {
  buildScProvenanceDryrun,
  mutationForRow,
  type ScDryrunRowInput,
  type ScDryrunDoc,
} from '../services/sc-provenance-dryrun.js';

// Helpers
const row = (over: Partial<ScDryrunRowInput>): ScDryrunRowInput => ({
  id: 'r1',
  caseId: 'CLM-1',
  veteranId: 'vet-1',
  condition: 'Thing',
  status: 'service_connected',
  ratingPct: 30,
  dcCode: null,
  source: 'extracted',
  sourceDocumentId: 'doc-1',
  sourceAuthorityTier: null,
  scStatusAuthoritative: null,
  ...over,
});
const docs = (m: Record<string, ScDryrunDoc>): Map<string, ScDryrunDoc> => new Map(Object.entries(m));

const WOODLEY_DOC: ScDryrunDoc = {
  filename: 'Woodley_GERD_Misc_4.docx',
  docTag: 'unspecified',
  textSample: 'Goals: 30% – Recurrent esophageal stricture (DC 7203/7346); 10% – GERD',
};
// A REAL VA rating decision whose docTag was NOT classified (unspecified) and whose filename is generic —
// the over-filter trap. filename+docTag alone → 'unknown'; the TEXT SAMPLE must rescue it to va_decision.
const REAL_DECISION_BAD_TAG: ScDryrunDoc = {
  filename: 'scan_017.pdf',
  docTag: 'unspecified',
  textSample:
    'DEPARTMENT OF VETERANS AFFAIRS\nRating Decision\nDECISION: Service connection for tinnitus is granted with an evaluation of 10 percent effective ...',
};

describe('sc-provenance-dryrun — deterministic re-classification', () => {
  it('WOODLEY: a goal-doc-sourced grant WOULD demote (and is NOT over-filter-watch — text does not look like a real decision)', () => {
    const r = buildScProvenanceDryrun(
      [row({ condition: 'Recurrent esophageal stricture', sourceDocumentId: 'doc-1' })],
      docs({ 'doc-1': WOODLEY_DOC }),
    );
    const res = r.rows[0]!;
    expect(res.computedTier).toBe('veteran_or_lay');
    expect(res.authoritative).toBe(false);
    expect(res.wouldDemote).toBe(true);
    expect(res.action).toBe('downgrade');
    expect(res.overFilterWatch).toBe(false); // a goal doc does NOT look like a VA decision
    expect(r.summary.wouldDemoteCount).toBe(1);
    expect(r.summary.overFilterWatchCount).toBe(0);
  });

  it('OVER-FILTER DEFENSE: a REAL VA rating decision with docTag=unspecified + generic filename is RESCUED by the text sample → authoritative, NOT demoted', () => {
    const r = buildScProvenanceDryrun(
      [row({ condition: 'Tinnitus', sourceDocumentId: 'doc-2' })],
      docs({ 'doc-2': REAL_DECISION_BAD_TAG }),
    );
    const res = r.rows[0]!;
    expect(res.computedTier).toBe('va_decision'); // rescued by RE_VA_HEADER + RE_DECISION_SECTION
    expect(res.authoritative).toBe(true);
    expect(res.wouldDemote).toBe(false); // a real grant is NOT stripped
    expect(res.action).toBe('stamp');
    expect(r.summary.wouldDemoteCount).toBe(0);
  });

  it('OVER-FILTER WATCH fires when a wouldDemote row STILL looks like a real decision (e.g. docTag clinical but VA decision text) — surfaces for eyeball', () => {
    // docTag 'progress_notes' is clinical (non-authoritative) and pins the tier (Layer-1 wins over the
    // fingerprint), so it WOULD demote — but the text looks like a real decision → watch-list it.
    const r = buildScProvenanceDryrun(
      [row({ condition: 'Hearing loss', sourceDocumentId: 'doc-3' })],
      docs({
        'doc-3': {
          filename: 'mixed.pdf',
          docTag: 'progress_notes',
          textSample: 'DEPARTMENT OF VETERANS AFFAIRS ... DECISION: service connection for hearing loss is granted',
        },
      }),
    );
    const res = r.rows[0]!;
    expect(res.authoritative).toBe(false);
    expect(res.wouldDemote).toBe(true);
    expect(res.looksLikeRealDecision).toBe(true);
    expect(res.overFilterWatch).toBe(true);
    expect(r.overFilterWatch).toHaveLength(1);
  });

  it('MANUAL rows are immutable (never demoted, never stamped)', () => {
    const r = buildScProvenanceDryrun([row({ source: 'manual', sourceDocumentId: null })], docs({}));
    expect(r.rows[0]!.action).toBe('skip_manual');
    expect(r.rows[0]!.wouldDemote).toBe(false);
    expect(mutationForRow(r.rows[0]!)).toBeNull();
  });

  it('a NO-SOURCE extracted grant cannot be classified → left trusted (never blind-demoted)', () => {
    const r = buildScProvenanceDryrun([row({ sourceDocumentId: null })], docs({}));
    expect(r.rows[0]!.action).toBe('skip_no_source');
    expect(r.rows[0]!.wouldDemote).toBe(false);
    expect(r.summary.noSourceExtractedCount).toBe(1);
    expect(mutationForRow(r.rows[0]!)).toBeNull();
  });

  it('blindDemoteCount counts a wouldDemote with NO text sample (filename/docTag-only, lower confidence)', () => {
    const r = buildScProvenanceDryrun(
      [row({ condition: 'X', sourceDocumentId: 'doc-9' })],
      docs({ 'doc-9': { filename: 'note.pdf', docTag: 'progress_notes', textSample: null } }),
    );
    expect(r.rows[0]!.wouldDemote).toBe(true);
    expect(r.rows[0]!.textSampleUsed).toBe(false);
    expect(r.summary.blindDemoteCount).toBe(1);
  });

  it('mutationForRow mirrors the writer: downgrade sets pending + drops ratingPct + stamps false; authoritative stamps true only', () => {
    const demote = buildScProvenanceDryrun([row({ sourceDocumentId: 'd' })], docs({ 'd': WOODLEY_DOC })).rows[0]!;
    expect(mutationForRow(demote)).toEqual({ id: 'r1', sourceAuthorityTier: 'veteran_or_lay', scStatusAuthoritative: false, newStatus: 'pending', dropRatingPct: true });

    const keep = buildScProvenanceDryrun([row({ condition: 'Tinnitus', sourceDocumentId: 'd' })], docs({ 'd': REAL_DECISION_BAD_TAG })).rows[0]!;
    expect(mutationForRow(keep)).toEqual({ id: 'r1', sourceAuthorityTier: 'va_decision', scStatusAuthoritative: true });
  });

  it('pending/denied grants are not demoted (nothing to strip) but still classify', () => {
    const r = buildScProvenanceDryrun([row({ status: 'pending', sourceDocumentId: 'd' })], docs({ 'd': WOODLEY_DOC }));
    expect(r.rows[0]!.wouldDemote).toBe(false);
    expect(r.rows[0]!.action).toBe('skip_not_sc');
  });
});
