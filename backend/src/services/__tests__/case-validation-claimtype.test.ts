import { describe, it, expect } from 'vitest';
import { parseCaseCreate } from '../case-validation.js';

// Regression: Wayne Mosely (2026-06-05) — the intake layer + Jotform worker emit 'appeal', but the
// case ClaimType enum canonicalized on 'appeal_bva'. parseCaseCreate used to 400 on 'appeal', so
// creating a case from an intake that pre-filled 'appeal' failed 3× until manually switched. The
// boundary now normalizes legacy aliases to the canonical enum.
describe('parseCaseCreate claimType normalization', () => {
  const base = { id: 'CLM-1', claimedCondition: 'PTSD' };

  it("normalizes legacy 'appeal' to 'appeal_bva' (was a 400)", () => {
    expect(parseCaseCreate({ ...base, claimType: 'appeal' }).claimType).toBe('appeal_bva');
  });

  it('accepts the other legacy aliases', () => {
    expect(parseCaseCreate({ ...base, claimType: 'board_appeal' }).claimType).toBe('appeal_bva');
    expect(parseCaseCreate({ ...base, claimType: 'NOD' }).claimType).toBe('appeal_bva');
    expect(parseCaseCreate({ ...base, claimType: 'hlr_request' }).claimType).toBe('hlr');
  });

  it('passes through canonical values unchanged', () => {
    for (const ct of ['initial', 'supplemental', 'hlr', 'appeal_bva'] as const) {
      expect(parseCaseCreate({ ...base, claimType: ct }).claimType).toBe(ct);
    }
  });

  it('still rejects genuinely invalid claim types', () => {
    expect(() => parseCaseCreate({ ...base, claimType: 'garbage' })).toThrow();
  });
});
