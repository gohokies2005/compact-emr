import type { ReactNode } from 'react';
import { useHaltExplanation } from '../hooks/useHaltExplanation';

/**
 * "Why this paused (plain language)" (Dr. Kasky 2026-07-02). Renders a prominent LLM-generated plain-language
 * explanation of a draft halt + the concrete next step, above the panel's existing raw/technical halt message.
 *
 * Fallback discipline (nothing is ever lost):
 *   • while loading  → a quiet "Explaining…" line + the raw `technicalDetail` shown normally.
 *   • explanation OK → the plain-language block is prominent; the raw `technicalDetail` is DEMOTED into a
 *                      collapsed <details> "Technical detail" (available but out of the way).
 *   • unavailable / failed → nothing extra; the raw `technicalDetail` renders exactly as it does today.
 *
 * `technicalDetail` is the panel's existing reason JSX — passed in so this component owns only the new layer.
 */
export function HaltPlainLanguage({
  caseId,
  enabled = true,
  technicalDetail,
}: {
  readonly caseId: string;
  readonly enabled?: boolean;
  readonly technicalDetail: ReactNode;
}) {
  const { explanation, isLoading } = useHaltExplanation(caseId, { enabled });

  if (isLoading && !explanation) {
    return (
      <div>
        <p className="mt-2 text-sm text-steel">Explaining this pause in plain language…</p>
        {technicalDetail}
      </div>
    );
  }

  if (!explanation) return <>{technicalDetail}</>;

  // Confidence is the human backstop for the anti-fabrication rules (the model can still guess an upstream cause
  // or a re-route). Anything below 'high' shows a visible "verify before acting" flag; the raw technical detail
  // is one click away below. 'high' shows no extra affordance.
  const needsVerify = explanation.confidence !== 'high';

  return (
    <div>
      <div className="mt-2 rounded-xl border border-aegis bg-ivory p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-navyDeep">Why this paused (plain language)</p>
          {needsVerify ? (
            <span
              className="inline-flex flex-none items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800"
              title="The automated explanation may be uncertain — confirm against the record before acting on it."
            >
              ⚠ Verify before acting
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-sm text-navyDeep">{explanation.summary}</p>
        <p className="mt-2 text-sm text-navyDeep">
          <span className="font-semibold">What to do:</span> {explanation.what_to_do}
        </p>
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-slate-400">Technical detail</summary>
        <div className="mt-1">{technicalDetail}</div>
      </details>
    </div>
  );
}
