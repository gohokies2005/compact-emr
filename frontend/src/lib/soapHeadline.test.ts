import { describe, it, expect } from 'vitest';
import { soapHeadline, groundedHeadlineFraming } from './soapHeadline';

const LIVE_FRAMING = 'OSA secondary to service-connected allergic rhinitis (causation)';
const STRATEGY = 'OSA — strategy-engine primary argument';
const ANCHOR = 'OSA — secondary to PTSD';
const TITLE = 'Draft';

describe('soapHeadline — H1 (grounded) + H4 (stale suppression)', () => {
  it('H1: a GROUNDED, fresh note uses the route-picker plan framing as the headline (matches the Assessment)', () => {
    const h = soapHeadline({ grounded: true, stale: false, routePickerFraming: LIVE_FRAMING, strategyPrimaryArgument: STRATEGY, anchorHeadline: ANCHOR, resultTitle: TITLE });
    expect(h).toBe(LIVE_FRAMING);
  });

  it('H4: a GROUNDED but STALE note does NOT use the live framing (it would contradict the stale body)', () => {
    // The body is the stored old-framing note; the live plan framing must be SUPPRESSED so headline ≠ body.
    const h = soapHeadline({ grounded: true, stale: true, routePickerFraming: LIVE_FRAMING, strategyPrimaryArgument: STRATEGY, anchorHeadline: ANCHOR, resultTitle: TITLE });
    expect(h).not.toBe(LIVE_FRAMING); // the live framing is NOT shown over the stale body
    expect(h).toBe(STRATEGY);        // falls back to the neutral strategy headline
  });

  it('H4 with no strategy: a grounded+stale note falls back through anchor → title, never the live framing', () => {
    expect(soapHeadline({ grounded: true, stale: true, routePickerFraming: LIVE_FRAMING, strategyPrimaryArgument: null, anchorHeadline: ANCHOR, resultTitle: TITLE })).toBe(ANCHOR);
    expect(soapHeadline({ grounded: true, stale: true, routePickerFraming: LIVE_FRAMING, strategyPrimaryArgument: null, anchorHeadline: null, resultTitle: TITLE })).toBe(TITLE);
  });

  it('ungrounded note uses strategy → anchor → title, never the (absent) framing', () => {
    expect(soapHeadline({ grounded: false, stale: false, routePickerFraming: null, strategyPrimaryArgument: STRATEGY, anchorHeadline: ANCHOR, resultTitle: TITLE })).toBe(STRATEGY);
    expect(soapHeadline({ grounded: false, stale: false, routePickerFraming: null, strategyPrimaryArgument: null, anchorHeadline: ANCHOR, resultTitle: TITLE })).toBe(ANCHOR);
    expect(soapHeadline({ grounded: false, stale: false, routePickerFraming: null, strategyPrimaryArgument: null, anchorHeadline: null, resultTitle: TITLE })).toBe(TITLE);
  });

  it('OSA fix: an UNGROUNDED note with a READY route-picker card framing uses THAT (not the stale-intake strategy)', () => {
    // Dr. Kasky 2026-06-26: heading said "OSA secondary to Knee" (strategy = stale intake claim) while the
    // body argued depression (the route-picker plan). When ungrounded but the card plan is ready, the card
    // framing — the SAME theory the body argues — beats the static strategy engine.
    const CARD = 'OSA secondary to service-connected depression (causation)';
    const h = soapHeadline({ grounded: false, stale: false, routePickerCardFraming: CARD, strategyPrimaryArgument: STRATEGY, anchorHeadline: ANCHOR, resultTitle: TITLE });
    expect(h).toBe(CARD);
  });

  it('OSA fix: the route-picker card framing is SUPPRESSED when the note is stale (falls back to strategy)', () => {
    const CARD = 'OSA secondary to service-connected depression (causation)';
    const h = soapHeadline({ grounded: false, stale: true, routePickerCardFraming: CARD, strategyPrimaryArgument: STRATEGY, anchorHeadline: ANCHOR, resultTitle: TITLE });
    expect(h).toBe(STRATEGY);
  });

  it('grounded framing still wins over the card framing when both present', () => {
    const CARD = 'card framing';
    expect(soapHeadline({ grounded: true, stale: false, routePickerFraming: LIVE_FRAMING, routePickerCardFraming: CARD, strategyPrimaryArgument: STRATEGY, anchorHeadline: ANCHOR, resultTitle: TITLE })).toBe(LIVE_FRAMING);
  });

  it('groundedHeadlineFraming: usable only when grounded AND not stale', () => {
    expect(groundedHeadlineFraming({ grounded: true, stale: false, routePickerFraming: LIVE_FRAMING })).toBe(LIVE_FRAMING);
    expect(groundedHeadlineFraming({ grounded: true, stale: true, routePickerFraming: LIVE_FRAMING })).toBeNull();
    expect(groundedHeadlineFraming({ grounded: false, stale: false, routePickerFraming: LIVE_FRAMING })).toBeNull();
    expect(groundedHeadlineFraming({ grounded: true, stale: false, routePickerFraming: null })).toBeNull();
  });
});
