import { describe, expect, it } from 'vitest';
import { haltShouldCarryDraft } from '../routes/drafter.js';

/**
 * auditHaltPreservesDraft (cheap guard, 2026-06-22). The /halt receiver only tries to PRESERVE a
 * produced draft (persist artifactTxtS3Key + advance currentVersion) for halt classes where a FULL
 * letter was actually produced — i.e. a body-quality park. This pins the classifier so a future edit
 * can't silently re-classify a dx/event hold as draft-carrying (which would advance currentVersion
 * onto a non-existent letter) or DROP body-quality (which would re-bury the held letter). It is the
 * server twin of the frontend isBodyQualityHalt(); the two MUST agree.
 */
describe('haltShouldCarryDraft (server twin of isBodyQualityHalt)', () => {
  it('TRUE for the dedicated body_quality_critical reasonCode', () => {
    expect(haltShouldCarryDraft('body_quality_critical', 'body_quality')).toBe(true);
    expect(haltShouldCarryDraft('body_quality_critical', 'dx_verification')).toBe(true); // code alone is enough
  });

  it('TRUE for the legacy verify_error carrying haltGate body_quality (pre-redeploy emission)', () => {
    expect(haltShouldCarryDraft('verify_error', 'body_quality')).toBe(true);
  });

  it('FALSE for every dx/event/records verification hold (no letter was produced)', () => {
    for (const code of ['dx_not_found', 'event_not_found', 'dx_and_event_not_found', 'no_records_text', 'verify_error', 'verify_parse_error', 'verify_unavailable']) {
      expect(haltShouldCarryDraft(code, 'dx_verification')).toBe(false);
    }
  });
});
