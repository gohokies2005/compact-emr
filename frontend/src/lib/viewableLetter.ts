// "Does a real, openable letter exist for this case?" — the SINGLE signal the claim page uses to
// decide whether to offer the letter affordances (View PDF / Open editor / Send to doctor / the RN
// editor-entry / the Delivery verify button). Hoisted out of CaseDetailPage so it is pure + unit-
// testable and so every consumer reads the SAME truth.
//
// CLM-A158C00C07 (Michael Dick, 2026-06-29): a Gate-2 dx-verification halt fired PRE-DRAFT — NO letter
// artifact was ever rendered (all DraftJob artifact keys NULL, S3 drafter-artifacts/<caseId>/ empty,
// Case.currentVersion=0). The OLD predicate returned `hasPdfKey || state==='done' || state==='failed'`,
// so the terminal halt job matched on STATE ALONE and the panel advertised "…but it produced a letter"
// with View-PDF / Open-editor / Send-to-doctor buttons — all of which 404'd: GET /cases/:id/letter ran
// resolveCurrentForRead(0), which returns null for currentVersion < 1, then found nothing in S3.
//
// THE FIX: a letter is "viewable" only when a real, RESOLVABLE artifact exists — mirroring what
// GET /cases/:id/letter (resolveCurrentForRead) can actually serve:
//   - a present .pdf artifact key on the job (opens directly), OR
//   - Case.currentVersion >= 1 — the read pointer resolves a txt at the current version. This covers
//     (a) a halt-with-letter that persisted a txt key + advanced the pointer (the legit "halt produced
//     a letter" path — task #96), and (b) the stuck-watcher race where the job's key column was lost
//     but the artifact rendered AND the pointer advanced (the case the old state-only fallback existed
//     for). A pre-draft halt leaves currentVersion=0 with null keys → NOT viewable.
import type { DraftJob } from '../types/prisma';

// Minimal structural shape the resolver reads — keeps the helper pure (any DraftJob satisfies it).
export type ViewableLetterJobLike = Pick<DraftJob, 'state' | 'version'> & {
  readonly artifactPdfS3Key?: string | null;
};

/**
 * The newest draft job whose letter can ACTUALLY be opened, or undefined when no resolvable letter
 * exists. `draftJobs` is expected version-desc (API order), so the first match is the latest letter.
 *
 * @param draftJobs     the case's draft jobs (version-desc)
 * @param currentVersion Case.currentVersion — the read pointer GET /cases/:id/letter resolves against
 */
export function resolveViewableLetterJob<J extends ViewableLetterJobLike>(
  draftJobs: readonly J[] | undefined,
  currentVersion: number | null | undefined,
): J | undefined {
  // currentVersion >= 1 is the EXACT mirror of resolveCurrent()'s `currentVersion < 1 → null` gate:
  // when it holds, the read path can resolve (or stranded-recover) a txt at the pointer.
  const pointerResolves = typeof currentVersion === 'number' && currentVersion >= 1;

  return (draftJobs ?? []).find((job) => {
    const pdfKey = typeof job.artifactPdfS3Key === 'string' ? job.artifactPdfS3Key : null;
    // DB-corruption sanity gate (Seam-B rows held a .txt key in the PDF field — CLM-BBFCB3F8CE): a
    // non-.pdf key in the PDF field can never open as a PDF; skip this job (find continues) rather than
    // dead-ending a click. Unchanged from the prior inline predicate.
    if (pdfKey !== null && pdfKey.length > 0 && !pdfKey.toLowerCase().endsWith('.pdf')) return false;
    const hasPdfKey = pdfKey !== null && pdfKey.length > 0;
    // A present PDF key proves an openable artifact outright. Otherwise the job is the latest-letter
    // candidate ONLY when it is terminal AND a letter is resolvable at the current pointer — never on
    // terminal state alone (that was the pre-draft-halt false affordance, CLM-A158C00C07).
    return hasPdfKey || (pointerResolves && (job.state === 'done' || job.state === 'failed'));
  });
}
