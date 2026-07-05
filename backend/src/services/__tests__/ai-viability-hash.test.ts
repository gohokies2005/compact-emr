// planInputHash must be ORDER-INVARIANT over its array fields. The route-picker cache key is built from
// `sc` (granted-SC anchors) and `problems` (active problems) read from Postgres with NO `ORDER BY`, so the
// compute-Lambda write and the GET-Lambda read can serialize them in a different order → the persisted hash
// never re-matches → the plan recomputes on EVERY card open (~50s + a Sonnet call). CLM-BE673DFF78 wedge.
// These assertions fail RED against an order-sensitive hash and pass GREEN once the array fields are sorted.
import { describe, it, expect } from 'vitest';
import { planInputHash } from '../ai-viability.js';

describe('planInputHash — order-invariant cache key (CLM-BE673DFF78 recompute wedge)', () => {
  const base = { claimed: 'Left shoulder impingement', events: [] as string[], guidance: null, vs: null, docHints: [] as string[] };

  it('is invariant to sc (granted-SC) ordering', () => {
    const a = planInputHash({ ...base, sc: ['Right shoulder DJD', 'PTSD', 'Tinnitus'], problems: [] });
    const b = planInputHash({ ...base, sc: ['PTSD', 'Tinnitus', 'Right shoulder DJD'], problems: [] });
    expect(a).toBe(b);
  });

  it('is invariant to problems ordering', () => {
    const a = planInputHash({ ...base, sc: [], problems: ['Insomnia', 'Chronic pain', 'GERD'] });
    const b = planInputHash({ ...base, sc: [], problems: ['GERD', 'Insomnia', 'Chronic pain'] });
    expect(a).toBe(b);
  });

  it('is invariant to events and docHints ordering', () => {
    const a = planInputHash({ ...base, sc: [], problems: [], events: ['E2', 'E1'], docHints: ['D2', 'D1'] });
    const b = planInputHash({ ...base, sc: [], problems: [], events: ['E1', 'E2'], docHints: ['D1', 'D2'] });
    expect(a).toBe(b);
  });

  it('still DISTINGUISHES different content (the hash is not a constant)', () => {
    const a = planInputHash({ ...base, sc: ['PTSD'], problems: [] });
    const b = planInputHash({ ...base, sc: ['OSA'], problems: [] });
    expect(a).not.toBe(b);
  });

  it('is stable across repeated identical calls', () => {
    const parts = { ...base, sc: ['PTSD', 'OSA'], problems: ['GERD'] };
    expect(planInputHash(parts)).toBe(planInputHash(parts));
  });
});
