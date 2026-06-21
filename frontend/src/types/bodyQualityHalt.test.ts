import { describe, expect, it } from 'vitest';
import { isBodyQualityHalt, type Gate2HaltPayload } from './prisma';

/**
 * isBodyQualityHalt discriminates a BODY-QUALITY park (letter held for re-draft) from a dx/event
 * verification hold. It must be forward/backward compatible: match BOTH the dedicated
 * 'body_quality_critical' reasonCode AND the current legacy emission (haltGate 'body_quality'
 * carrying a borrowed 'verify_error' code, sent until the FRN drafter image redeploys).
 */
describe('isBodyQualityHalt', () => {
  it('matches the dedicated body_quality_critical reasonCode', () => {
    expect(isBodyQualityHalt({ reasonCode: 'body_quality_critical', haltGate: 'body_quality' })).toBe(true);
  });

  it('matches the legacy verify_error code when haltGate is body_quality (FRN pre-redeploy)', () => {
    expect(isBodyQualityHalt({ reasonCode: 'verify_error', haltGate: 'body_quality' })).toBe(true);
  });

  it('does NOT match a genuine dx/event verification hold', () => {
    const dx: Gate2HaltPayload = { reasonCode: 'dx_not_found', haltGate: 'dx_verification' };
    expect(isBodyQualityHalt(dx)).toBe(false);
  });

  it('does NOT match a real verify_error that is NOT a body-quality park', () => {
    expect(isBodyQualityHalt({ reasonCode: 'verify_error', haltGate: 'dx_verification' })).toBe(false);
  });

  it('is safe on null / undefined / empty payloads', () => {
    expect(isBodyQualityHalt(null)).toBe(false);
    expect(isBodyQualityHalt(undefined)).toBe(false);
    expect(isBodyQualityHalt({})).toBe(false);
  });
});
