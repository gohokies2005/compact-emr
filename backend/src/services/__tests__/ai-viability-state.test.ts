// AI-viability reliability STATE machine (Ryan 2026-06-21, Zimmelman). Pins the fix for the route-picker
// plan that stayed null forever + showed a misleading "Not supportable" resting verdict:
//   • the read path (compute:false) NO LONGER collapses "no plan", "computing", and "FAILED" into a single
//     null — it returns a discriminated state so the FE shows an honest spinner / retry / grounded plan.
//   • a persisted 'error' for the CURRENT inputs reads back as status:'error' (NOT 'none') so the GET does
//     NOT re-fire the same failing compute on every open (the infinite-loop bug) and the FE shows retry.
//   • a fresh persisted plan whose hash matches the current inputs reads back as 'ready' (the $0 short-circuit;
//     read + write share the SAME hash builder so it is always re-found — kills the permanent-mismatch class).
//   • a stale 'computing' stamp (older than the in-flight window) reads back as 'none' so a crashed compute
//     does not wedge the case in a spinner forever.
//
// The framing/mechanism/anthropic deps are mocked so this exercises the STATE branching without the SDK / a
// real DB. The inputHash is reconstructed here with the SAME serialization the service uses, proving the
// read short-circuit matches the write (the round-trip that guarantees a fresh plan is re-found).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { AppDb } from '../db-types.js';

vi.mock('../case-framing-stamp.js', () => ({
  deriveCaseFramingForCase: vi.fn(async () => ({ grantedScAnchors: [{ condition: 'Allergic rhinitis' }] })),
  loadMechanismFilter: vi.fn(() => null), // unfiltered → deterministic sc set ['Allergic rhinitis']
}));
vi.mock('../letter-surgical-propose.js', () => ({ resolveAnthropicApiKey: vi.fn(async () => 'sk-test') }));

const ORIGINAL_ENV = process.env['AI_ROUTE_PICKER_ENABLED'];
beforeEach(() => { process.env['AI_ROUTE_PICKER_ENABLED'] = 'true'; vi.clearAllMocks(); });
afterAll(() => { if (ORIGINAL_ENV === undefined) delete process.env['AI_ROUTE_PICKER_ENABLED']; else process.env['AI_ROUTE_PICKER_ENABLED'] = ORIGINAL_ENV; });

const { getAiViabilityState, AI_VIABILITY_PLAN_SCHEMA_VERSION } = await import('../ai-viability.js');

const CLAIMED = 'Obstructive sleep apnea';

// The inputHash the service derives for the mocked case (claimed + sc=['Allergic rhinitis'], everything else
// empty). Replicated with the EXACT serialization in buildPlanInputs so planting a status against THIS hash
// means "about the current inputs" — the round-trip proof that the read short-circuit matches the write.
// docHints:[] — the mock db has no `document` delegate, so buildPlanInputs' fail-open yields an empty
// hint list (Ryan 2026-07-04 records-provenance change folded docHints into the inputHash).
const INPUT_HASH = createHash('sha256')
  .update(JSON.stringify({ claimed: CLAIMED, sc: ['Allergic rhinitis'], problems: [], events: [], guidance: null, vs: null, docHints: [] }))
  .digest('hex');

function readyPlan() {
  return {
    source: 'ai_route_picker', schemaVersion: AI_VIABILITY_PLAN_SCHEMA_VERSION, inputClaimed: CLAIMED,
    viability: 'supportable',
    lead: { upstream: 'Allergic rhinitis', claimed: CLAIMED, framing: 'OSA secondary to rhinitis', cfr_basis: '38 CFR 3.310(a)', mechanism: 'nasal obstruction', confidence: 'moderate', rationale: 'r', counterargument: 'c' },
    convergent: [], alternatives: [], excluded: [], missing: [], nuance: '', overall: '',
  };
}

/** A fake case delegate over a single row. The problems sub-query returns []; the plan row returns the seed. */
function makeDb(row: Record<string, unknown>): { db: AppDb } {
  const db = {
    case: {
      findFirst: vi.fn(async (args: { select?: Record<string, unknown> }) => {
        if (args.select && 'veteran' in args.select) return { veteran: { activeProblems: [] } };
        return { ...row };
      }),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => { Object.assign(row, args.data); return { ...row }; }),
    },
  } as unknown as AppDb;
  return { db };
}

function seed(extra: Record<string, unknown>): Record<string, unknown> {
  return { claimedCondition: CLAIMED, veteranStatement: null, inServiceEvent: null, framingChoice: null, upstreamScCondition: null, aiViabilityPlanJson: null, aiViabilityPlanHash: null, aiViabilityPlanStatus: null, aiViabilityPlanError: null, aiViabilityPlanComputedAt: null, ...extra };
}

describe('getAiViabilityState — reliability read map (compute:false)', () => {
  // Each test uses a UNIQUE caseId. The service has a module-level in-process cache keyed by caseId:inputHash
  // (a warm 'ready' card is correctly served $0 for the SAME inputs across reads); distinct ids isolate the
  // state-map assertions from that cache. (In production, identical inputs genuinely share the same plan.)
  let n = 0;
  const cid = () => `C-state-${n++}`;

  it('flag OFF → status:off', async () => {
    process.env['AI_ROUTE_PICKER_ENABLED'] = 'false';
    const { db } = makeDb(seed({}));
    expect((await getAiViabilityState(db, cid(), { compute: false })).status).toBe('off');
  });

  it('cold case (no plan, no status) → status:none', async () => {
    const { db } = makeDb(seed({}));
    expect((await getAiViabilityState(db, cid(), { compute: false })).status).toBe('none');
  });

  it('a fresh persisted plan whose hash matches the current inputs → ready (the $0 short-circuit round-trip)', async () => {
    const { db } = makeDb(seed({ aiViabilityPlanJson: readyPlan(), aiViabilityPlanHash: INPUT_HASH, aiViabilityPlanStatus: 'ready', aiViabilityPlanComputedAt: new Date() }));
    const s = await getAiViabilityState(db, cid(), { compute: false });
    expect(s.status).toBe('ready');
    if (s.status === 'ready') {
      expect(s.card.inputClaimed).toBe(CLAIMED);
      expect(s.card.planHash).toBe(INPUT_HASH); // stamped from the row read (H3)
    }
  });

  it('REGRESSION (Zimmelman): a persisted ERROR whose hash MATCHES the current inputs → status:error (no re-fire; FE shows retry)', async () => {
    const { db } = makeDb(seed({ aiViabilityPlanHash: INPUT_HASH, aiViabilityPlanStatus: 'error', aiViabilityPlanError: 'The analysis timed out (the chart is large). Please retry.', aiViabilityPlanComputedAt: new Date() }));
    const s = await getAiViabilityState(db, cid(), { compute: false });
    expect(s.status).toBe('error');
    if (s.status === 'error') expect(s.error).toMatch(/timed out|retry/i);
  });

  it('a STALE-hash error (about OLD inputs) → none — the current inputs are uncomputed, so a recompute is correct', async () => {
    const { db } = makeDb(seed({ aiViabilityPlanHash: 'STALE-DIFFERENT-HASH', aiViabilityPlanStatus: 'error', aiViabilityPlanError: 'boom', aiViabilityPlanComputedAt: new Date() }));
    expect((await getAiViabilityState(db, cid(), { compute: false })).status).toBe('none');
  });

  it('a FRESH computing stamp (within the window) for the current inputs → computing (spinner)', async () => {
    const { db } = makeDb(seed({ aiViabilityPlanHash: INPUT_HASH, aiViabilityPlanStatus: 'computing', aiViabilityPlanComputedAt: new Date() }));
    expect((await getAiViabilityState(db, cid(), { compute: false })).status).toBe('computing');
  });

  it('a STALE computing stamp (older than the in-flight window) → none — a crashed compute does not wedge a spinner forever', async () => {
    const old = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago, past COMPUTING_STALE_MS (90s)
    const { db } = makeDb(seed({ aiViabilityPlanHash: INPUT_HASH, aiViabilityPlanStatus: 'computing', aiViabilityPlanComputedAt: old }));
    expect((await getAiViabilityState(db, cid(), { compute: false })).status).toBe('none');
  });

  it('a ready plan with a MISMATCHED hash (stale inputs/condition) → none for the current inputs (recompute)', async () => {
    const stalePlan = { ...readyPlan(), inputClaimed: 'Tinnitus' };
    const { db } = makeDb(seed({ aiViabilityPlanJson: stalePlan, aiViabilityPlanHash: 'OLD-CLAIM-HASH', aiViabilityPlanStatus: 'ready', aiViabilityPlanComputedAt: new Date() }));
    expect((await getAiViabilityState(db, cid(), { compute: false })).status).toBe('none');
  });
});
