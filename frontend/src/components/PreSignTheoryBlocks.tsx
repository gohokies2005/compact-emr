import type { PreSignTheory } from './preSignTheory';

// The pre-sign theory blocks shown ABOVE the grader considerations on BOTH the desktop
// (PhysicianLetterReadyPanel) and mobile (PhysicianMobileReviewPage) physician review surfaces
// (Ryan 2026-07-11). One shared component so the two can't drift. Everything is deterministic from
// Case fields (buildPreSignTheory) — no letter-text parse, nothing to hallucinate; fail-open blocks
// with no data simply don't render. Renders nothing when there is no content.
export function PreSignTheoryBlocks({ theory }: { readonly theory: PreSignTheory }) {
  if (!theory.hasContent) return null;
  return (
    <div className="mt-3 space-y-3 border-b border-slate-200 pb-3">
      {/* Block 1 — the veteran's OWN words + what they claimed + what they said it's secondary to */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">What the veteran told us</p>
        {theory.veteranStatement ? (
          <p className="mt-1 whitespace-pre-wrap text-sm italic text-slate-700">&ldquo;{theory.veteranStatement}&rdquo;</p>
        ) : null}
        <p className="mt-1 text-sm text-slate-700">
          <span className="font-medium">Claimed:</span> {theory.veteranClaim ?? '—'}
          {theory.veteranTheory ? (
            <>
              {' · '}
              <span className="font-medium">Their theory:</span> {theory.veteranTheory}
            </>
          ) : null}
        </p>
        {/* Part B (Ryan 2026-07-11): the LLM restatement of the veteran's OWN theory in concise clinical
            terms — shown as its own line (it's a full sentence). Present only in the LLM path; falls back to
            the template/quote above when absent. */}
        {theory.veteranTheoryProse ? (
          <p className="mt-1 text-sm text-slate-700">
            <span className="font-medium">Their theory (in clinical terms):</span> {theory.veteranTheoryProse}
          </p>
        ) : null}
      </div>

      {/* Block 2 — what the drafter/letter actually argues (from the persisted route-picker plan) */}
      {theory.letterTheory ? (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">What the letter argues</p>
          <p className="mt-1 text-sm text-slate-700">
            {theory.letterDx ? (
              <>
                <span className="font-medium">Diagnosis:</span> {theory.letterDx}
                {' · '}
              </>
            ) : null}
            <span className="font-medium">Theory:</span> {theory.letterTheory}
          </p>
        </div>
      ) : null}

      {/* Block 3 — reconciliation: shown ONLY when the two clearly differ (no positive "matches"
          affirmation — a green ✓ on a sign-off surface risks false reassurance). Rendered as a plain
          line in the SAME format as the blocks above (Ryan 2026-07-11: no highlighted box). */}
      {theory.mismatch ? (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Where they differ</p>
          <p className="mt-1 text-sm text-slate-700">
            {theory.mismatch.summary ?? <>The letter&rsquo;s theory differs from the veteran&rsquo;s.</>}
            {theory.mismatch.reason ? <> {theory.mismatch.reason}</> : null}
            {theory.mismatch.suggestEdit ? (
              <> If clinically appropriate, consider a brief surgical edit to address it (your discretion).</>
            ) : null}
          </p>
        </div>
      ) : null}
    </div>
  );
}
