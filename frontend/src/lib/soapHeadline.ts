// SOAP overview headline selection (H1 + H4). Pure + unit-testable so the headline/body agreement contract is
// pinned without a full component-query harness.
//
// H1: when the SOAP note is GROUNDED on the route-picker plan (the SAME brain the drafter pleads), the bold
//     headline must be that plan's framing so it matches the Assessment below.
// H4 (adversarial QA 2026-06-21): when the served note is STALE, the BODY is the stored (old-framing) note but
//     `routePickerFraming` is the LIVE plan — so showing the live framing as the headline would CONTRADICT the
//     stale Assessment. The stored note does not persist its framing, so we SUPPRESS the live grounded framing
//     when stale and fall back to the neutral strategy/title headline. Headline and body never disagree.

export interface SoapHeadlineInput {
  /** The SOAP response's `grounded` flag (note Assessment renders the route-picker plan). */
  readonly grounded?: boolean | undefined;
  /** True when the served note is the stored note but its inputs changed since (new info). */
  readonly stale?: boolean | undefined;
  /** The live route-picker plan's framing (only meaningful when grounded). */
  readonly routePickerFraming?: string | null | undefined;
  /** The static strategy engine's primary argument (the legacy/ungrounded headline). */
  readonly strategyPrimaryArgument?: string | null | undefined;
  /** A composed "X — secondary to Y" anchor headline (when a viability best-anchor exists). */
  readonly anchorHeadline?: string | null | undefined;
  /** The deterministic verdict title — the always-available last resort. */
  readonly resultTitle: string;
}

/**
 * The grounded framing to use for the headline, or null when it must NOT be used. Grounded framing is used ONLY
 * when the note is grounded AND NOT stale (H4) — a stale body would contradict a live-framing headline.
 */
export function groundedHeadlineFraming(input: Pick<SoapHeadlineInput, 'grounded' | 'stale' | 'routePickerFraming'>): string | null {
  if (input.grounded === true && input.stale !== true) {
    return input.routePickerFraming ?? null;
  }
  return null;
}

/** The bold headline string: grounded framing (when usable) → strategy → anchor → deterministic title. */
export function soapHeadline(input: SoapHeadlineInput): string {
  return (
    groundedHeadlineFraming(input)
    || input.strategyPrimaryArgument
    || input.anchorHeadline
    || input.resultTitle
  );
}
