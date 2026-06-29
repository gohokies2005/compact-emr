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
  /**
   * The READY route-picker card's chosen framing (one-brain, #72/#89). Used when the note is not
   * grounded-by-the-SOAP-response but the route-picker PLAN is ready (e.g. inputHash drift made the
   * SOAP read ungrounded while the card plan is still ready). This is the SAME theory the Assessment
   * body argues, so it beats the static strategy engine's headline (which reads the stale intake claim
   * — the OSA "secondary to Knee" vs depression mismatch, Dr. Kasky 2026-06-26). Suppressed when stale.
   */
  readonly routePickerCardFraming?: string | null | undefined;
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

/**
 * TITLE HUMANIZER (Dr. Kasky 2026-06-28). The route-picker framing fields can carry a RAW enum token instead
 * of prose — a lowercase axis word ("direct") or a snake_case event key ("in_service_onset") — which leaked
 * into the bold headline. humanizeFraming rewrites ONLY a bare enum token (all-lowercase, snake_case, no
 * spaces or sentence punctuation) into spaced Title Case: "direct" → "Direct", "in_service_onset" → "In
 * Service Onset". Real framing prose ("OSA secondary to service-connected rhinitis (causation)") already has
 * spaces/capitals/punctuation, fails the bare-enum guard, and is returned untouched (collapsed whitespace
 * only) so a human-written headline is never mangled. Pure; null/empty → ''.
 */
export function humanizeFraming(s: string | null | undefined): string {
  const raw = (s ?? '').replace(/\s+/g, ' ').trim();
  if (raw.length === 0) return raw;
  // A "bare enum token": starts lowercase, only [a-z0-9] segments joined by single underscores, no spaces or
  // punctuation. This is precisely the shape an un-rendered enum leaks as; prose never matches it.
  const isBareEnum = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(raw);
  if (!isBareEnum) return raw;
  return raw.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * The bold headline string: grounded framing (when usable) → the READY route-picker card framing (the
 * one-brain theory the body argues, when not stale) → static strategy → anchor → deterministic title.
 * The route-picker card framing is placed ABOVE the static strategy so the heading follows the chosen
 * theory (e.g. depression) instead of the stale intake claim (e.g. "secondary to Knee"). The selected
 * candidate is passed through humanizeFraming so a raw enum token never reaches the user as the headline.
 */
export function soapHeadline(input: SoapHeadlineInput): string {
  return humanizeFraming(
    groundedHeadlineFraming(input)
    || (input.stale !== true ? (input.routePickerCardFraming ?? null) : null)
    || input.strategyPrimaryArgument
    || input.anchorHeadline
    || input.resultTitle,
  );
}
