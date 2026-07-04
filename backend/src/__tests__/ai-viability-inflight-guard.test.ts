// ai-viability getAiViabilityState — the compute:true IN-FLIGHT GUARD (Ryan 2026-06-22, Zimmelman cost).
//
// A cold case open can fan out multiple compute triggers (the GET fires the async recompute on 'none', and
// the FE's /compute auto-fire + Retry also fire it). Without a guard, several async invocations each run a
// ~5¢ Sonnet picker call for the SAME inputs. These pin the guard:
//   (a) a FRESH 'computing' stamp for THESE EXACT inputs → short-circuit to {status:'computing'}, NO LLM call.
//   (b) a STALE 'computing' stamp (older than COMPUTING_STALE_MS) → the guard does NOT short-circuit; the
//       compute proceeds (a crashed prior compute must be recoverable).
//   (c) the $0 'ready' short-circuit (hash + shape match) → returns the persisted plan, NO LLM call (reloads
//       never recompute).
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { AppDb } from '../services/db-types.js';

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { create }; },
  // the module is also imported for its types (Anthropic.Tool etc.) — a bare default class is enough at runtime
}));
vi.mock('../services/letter-surgical-propose.js', () => ({ resolveAnthropicApiKey: vi.fn(async () => 'sk-test') }));
// Deterministic framing + NO mechanism filter so the test can replicate the inputHash exactly.
vi.mock('../services/case-framing-stamp.js', () => ({
  deriveCaseFramingForCase: vi.fn(async () => ({ grantedScAnchors: [{ condition: 'PTSD' }] })),
  loadMechanismFilter: vi.fn(() => undefined),
}));

const { getAiViabilityState, AI_VIABILITY_PLAN_SCHEMA_VERSION } = await import('../services/ai-viability.js');

const CLAIMED = 'Obstructive sleep apnea';
const CASE_ID = 'CASE-1';

// Replicate buildPlanInputs' hash exactly: sc from framing, problems from the active-problems row, events
// from inServiceEvent, guidance from framingChoice/upstreamScCondition, vs from veteranStatement.
function expectedInputHash(row: { veteranStatement: string | null; inServiceEvent: string | null; framingChoice: string | null; upstreamScCondition: string | null; }, problems: string[]): string {
  const sc = ['PTSD'];
  const events = row.inServiceEvent ? [row.inServiceEvent] : [];
  const guidanceBits: string[] = [];
  if (row.framingChoice) guidanceBits.push(`framing preference: ${row.framingChoice}`);
  if (row.upstreamScCondition) guidanceBits.push(`suggested upstream anchor: ${row.upstreamScCondition}`);
  const guidance = guidanceBits.join('; ') || null;
  // docHints:[] — mock db has no `document` delegate → buildPlanInputs fail-opens to [] (Ryan 2026-07-04).
  return createHash('sha256').update(JSON.stringify({ claimed: CLAIMED, sc, problems, events, guidance, vs: row.veteranStatement, docHints: [] })).digest('hex');
}

/** Build a mock AppDb whose case row carries the given plan-status fields. The two findFirst shapes the code
 *  uses are distinguished by the presence of a `veteran` select (the problems read). */
function makeDb(rowFields: Record<string, unknown>, problems: string[]) {
  const baseRow = {
    claimedCondition: CLAIMED, veteranStatement: null, inServiceEvent: null, framingChoice: null,
    upstreamScCondition: null, aiViabilityPlanHash: null, aiViabilityPlanJson: null,
    aiViabilityPlanStatus: null, aiViabilityPlanError: null, aiViabilityPlanComputedAt: null, ...rowFields,
  };
  const update = vi.fn(async () => ({}));
  const findFirst = vi.fn(async (args: { select?: Record<string, unknown> }) => {
    // the problems read selects `veteran`; everything else gets the plan row
    if (args?.select && 'veteran' in args.select) {
      return { veteran: { activeProblems: problems.map((problem) => ({ problem })) } };
    }
    return baseRow;
  });
  const db = { case: { findFirst, update } } as unknown as AppDb;
  return { db, update, baseRow };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env['AI_ROUTE_PICKER_ENABLED'] = 'true';
});

describe('getAiViabilityState compute:true — in-flight guard (cost dedup)', () => {
  it('(a) a FRESH computing stamp for THESE inputs short-circuits to computing with NO LLM call and NO re-stamp', async () => {
    const rowFields = { aiViabilityPlanStatus: 'computing', aiViabilityPlanComputedAt: new Date() };
    const problems: string[] = [];
    const hash = expectedInputHash({ veteranStatement: null, inServiceEvent: null, framingChoice: null, upstreamScCondition: null }, problems);
    const { db, update } = makeDb({ ...rowFields, aiViabilityPlanHash: hash }, problems);

    const state = await getAiViabilityState(db, CASE_ID, { compute: true, timeoutMs: 110_000 });

    expect(state.status).toBe('computing');
    expect(create).not.toHaveBeenCalled();          // NO ~5¢ Sonnet call — a compute is already in flight
    expect(update).not.toHaveBeenCalled();           // and it did NOT re-stamp 'computing'
  });

  it('(b) a STALE computing stamp does NOT short-circuit — the compute proceeds (crashed prior is recoverable)', async () => {
    const old = new Date(Date.now() - 5 * 60_000); // 5 min ago, well past COMPUTING_STALE_MS (90s)
    const problems: string[] = [];
    const hash = expectedInputHash({ veteranStatement: null, inServiceEvent: null, framingChoice: null, upstreamScCondition: null }, problems);
    const { db } = makeDb({ aiViabilityPlanStatus: 'computing', aiViabilityPlanComputedAt: old, aiViabilityPlanHash: hash }, problems);
    // a valid tool result so the compute completes to 'ready'
    create.mockResolvedValueOnce({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'emit_argument_plan', input: { viability: 'supportable', primary_anchor: { upstream: 'PTSD', claimed: CLAIMED, framing: 'OSA secondary to PTSD', cfr_basis: '38 CFR 3.310(a)', dominant_mechanism: 'm', confidence: 'moderate', rationale: 'r', strongest_counterargument: 'c' } } }] });

    const state = await getAiViabilityState(db, CASE_ID, { compute: true, timeoutMs: 110_000 });

    // The picker prompt is the only thing that can block this in a test env (vendored .cjs may be absent →
    // 'error'). Either way the KEY assertion is that the guard did NOT short-circuit on the stale stamp:
    expect(state.status).not.toBe('computing');
  });

  it('(c) the $0 ready short-circuit: a persisted plan matching the inputs returns ready with NO LLM call (reloads never recompute)', async () => {
    const problems: string[] = [];
    const hash = expectedInputHash({ veteranStatement: null, inServiceEvent: null, framingChoice: null, upstreamScCondition: null }, problems);
    const persisted = {
      source: 'ai_route_picker', schemaVersion: AI_VIABILITY_PLAN_SCHEMA_VERSION, inputClaimed: CLAIMED,
      viability: 'supportable', lead: { upstream: 'PTSD', claimed: CLAIMED, framing: 'OSA secondary to PTSD', cfr_basis: '38 CFR 3.310(a)', mechanism: 'm', confidence: 'moderate', rationale: 'r', counterargument: 'c' },
      convergent: [], alternatives: [], excluded: [], missing: [], nuance: '', overall: '',
    };
    const { db } = makeDb({ aiViabilityPlanStatus: 'ready', aiViabilityPlanHash: hash, aiViabilityPlanJson: persisted }, problems);

    // even with compute:true requested, a fresh persisted plan short-circuits before any LLM call
    const state = await getAiViabilityState(db, CASE_ID, { compute: true, timeoutMs: 110_000 });

    expect(state.status).toBe('ready');
    expect(create).not.toHaveBeenCalled();
  });
});
