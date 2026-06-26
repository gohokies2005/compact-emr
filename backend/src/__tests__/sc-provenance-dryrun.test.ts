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

  it('CONSERVATIVE: an UNCONFIRMED grant (clinical/unknown — e.g. an image or Misc file) is KEPT + flagged for verification, NOT demoted', () => {
    // The over-filter fix: a real-looking grant whose source the classifier cannot confirm (tier
    // 'unknown' here — a .png image) must NOT be stripped. It is kept and flagged for human verification.
    const r = buildScProvenanceDryrun(
      [row({ condition: 'Sleep Apnea Syndromes', ratingPct: 50, sourceDocumentId: 'doc-img' })],
      docs({ 'doc-img': { filename: 'Dorf_OSA_Misc_10.png', docTag: 'unspecified', textSample: 'rated 50 percent' } }),
    );
    const res = r.rows[0]!;
    expect(res.computedTier).toBe('unknown');
    expect(res.authoritative).toBe(false);
    expect(res.wouldDemote).toBe(false); // NOT stripped — this is the over-filter fix
    expect(res.needsVerification).toBe(true);
    expect(res.action).toBe('keep_flag_unverified');
    expect(r.summary.wouldDemoteCount).toBe(0);
    expect(r.summary.needsVerificationCount).toBe(1);
    // The apply MUST NOT change status (no newStatus) — it only stamps the tier+false for the verify flag.
    expect(mutationForRow(res)).toEqual({ id: 'r1', sourceAuthorityTier: 'unknown', scStatusAuthoritative: false });
  });

  it('CONSERVATIVE: a clinical-note grant (C&P/progress note) is also KEPT + flagged, not demoted', () => {
    const r = buildScProvenanceDryrun(
      [row({ condition: 'low back pain', ratingPct: 10, sourceDocumentId: 'doc-c' })],
      docs({ 'doc-c': { filename: 'note.pdf', docTag: 'progress_notes', textSample: 'assessment: low back pain, service-connected per veteran' } }),
    );
    const res = r.rows[0]!;
    expect(res.computedTier).toBe('clinical');
    expect(res.wouldDemote).toBe(false);
    expect(res.needsVerification).toBe(true);
    expect(res.action).toBe('keep_flag_unverified');
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

  it('blindDemoteCount counts a PROVEN-junk wouldDemote with NO text sample (a .docx goal-doc classified by extension alone)', () => {
    const r = buildScProvenanceDryrun(
      [row({ condition: 'X', sourceDocumentId: 'doc-9' })],
      docs({ 'doc-9': { filename: 'Veteran_Goals.docx', docTag: 'unspecified', textSample: null } }),
    );
    expect(r.rows[0]!.computedTier).toBe('veteran_or_lay'); // .docx → veteran_or_lay by extension
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
