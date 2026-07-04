import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppDb } from './db-types.js';

vi.mock('./letter-surgical-propose.js', () => ({ resolveAnthropicApiKey: vi.fn(async () => 'test-key') }));
const buildDigestForCase = vi.fn(async () => 'A long-enough extracted-records digest documenting left shoulder rotator cuff tendinosis with impingement and bursitis on MRI.');
vi.mock('../advisory/chartSlice.js', () => ({ buildDigestForCase: (...a: unknown[]) => buildDigestForCase(...(a as [])) }));
const create = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create }; constructor(_: unknown) {} } }));

import { narrowAndPersistClaim } from './aiClaimNarrow.js';

function toolResp(dx: string | null) {
  return { content: [{ type: 'tool_use', name: 'emit_narrowed_claim', input: { specific_diagnosis: dx, confidence: 'high' } }] };
}

interface Over { claim: string; source?: string | null; freshSource?: string | null; sc?: Array<{ condition: string; status: string }> }
function makeDb(over: Over) {
  const row = { claimedCondition: over.claim, claimedConditionSource: over.source ?? 'intake', claimedConditions: [over.claim], veteran: { scConditions: over.sc ?? [] } };
  const findFirst = vi.fn()
    .mockResolvedValueOnce(row) // main read
    .mockResolvedValueOnce({ claimedConditionSource: over.freshSource ?? over.source ?? 'intake' }); // fresh re-check
  const update = vi.fn(async () => ({}));
  return { db: { case: { findFirst, update } } as unknown as AppDb, update };
}

const GENERIC = 'Other Joint (shoulder, Hip, Ankle, Elbow, Wrist)';

describe('narrowAndPersistClaim', () => {
  beforeEach(() => { create.mockReset(); buildDigestForCase.mockClear(); create.mockResolvedValue(toolResp('Left shoulder rotator cuff tendinosis with impingement')); });

  it('SKIPS a manually-set claim (immutable — never overwrites, no LLM call)', async () => {
    const { db, update } = makeDb({ claim: GENERIC, source: 'manual' });
    const r = await narrowAndPersistClaim(db, 'C1');
    expect(r).toEqual({ updated: false, skipped: 'manual' });
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('SKIPS a specific (non-generic) claim (no narrowing needed, no LLM call)', async () => {
    const { db, update } = makeDb({ claim: 'Obstructive sleep apnea', source: 'intake' });
    const r = await narrowAndPersistClaim(db, 'C1');
    expect(r).toEqual({ updated: false, skipped: 'not_generic' });
    expect(update).not.toHaveBeenCalled();
    expect(buildDigestForCase).not.toHaveBeenCalled();
  });

  it('SKIPS when no records are present (nothing to narrow from)', async () => {
    buildDigestForCase.mockResolvedValueOnce('');
    const { db, update } = makeDb({ claim: GENERIC, source: 'intake' });
    const r = await narrowAndPersistClaim(db, 'C1');
    expect(r).toEqual({ updated: false, skipped: 'no_records' });
    expect(update).not.toHaveBeenCalled();
  });

  it('NARROWS a generic label to the record-documented dx (source=ai, both fields set)', async () => {
    const { db, update } = makeDb({ claim: GENERIC, source: 'intake' });
    const r = await narrowAndPersistClaim(db, 'C1');
    expect(r.updated).toBe(true);
    expect(r.diagnosis).toContain('rotator cuff tendinosis');
    expect(update).toHaveBeenCalledTimes(1);
    const data = (update.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data.claimedCondition).toContain('rotator cuff tendinosis');
    expect(data.claimedConditions).toEqual([data.claimedCondition]);
    expect(data.claimedConditionSource).toBe('ai');
    expect(data.aiViabilityPlanJson).toBeNull(); // invalidates the stale plan
  });

  it('ABSTAINS when the model returns null (records do not clearly document one dx)', async () => {
    create.mockResolvedValue(toolResp(null));
    const { db, update } = makeDb({ claim: GENERIC, source: 'intake' });
    const r = await narrowAndPersistClaim(db, 'C1');
    expect(r).toEqual({ updated: false, skipped: 'abstained' });
    expect(update).not.toHaveBeenCalled();
  });

  it('RACE: a manual edit landing while Haiku ran wins — the AI never clobbers it', async () => {
    const { db, update } = makeDb({ claim: GENERIC, source: 'intake', freshSource: 'manual' });
    const r = await narrowAndPersistClaim(db, 'C1');
    expect(r).toEqual({ updated: false, skipped: 'manual_race' });
    expect(update).not.toHaveBeenCalled();
  });

  it('does not re-emit another generic label', async () => {
    create.mockResolvedValue(toolResp('Other shoulder condition'));
    const { db, update } = makeDb({ claim: GENERIC, source: 'intake' });
    const r = await narrowAndPersistClaim(db, 'C1');
    expect(r).toEqual({ updated: false, skipped: 'still_generic' });
    expect(update).not.toHaveBeenCalled();
  });
});
