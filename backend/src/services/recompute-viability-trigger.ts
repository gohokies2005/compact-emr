// Fire-and-forget async trigger to compute the AI route-picker plan OFF the 29s request path
// (Ryan 2026-06-19). The synchronous GET /viability-card can't run the ~22-25s picker call under the API
// Gateway 29s cap, so when no fresh persisted plan exists it asks the API Lambda to invoke ITSELF
// asynchronously (InvocationType:'Event'). That fresh invocation owns the whole 29s window with nothing
// else on it, so the picker runs with a higher timeout, completes, and persists — then every later GET
// reads the persisted plan for $0/instant (the short-circuit in deriveAiViability).
//
// Fail-open: no SELF_FUNCTION_NAME env, SDK error, or throttle → we just log and move on; the card keeps
// showing the static panels and the next open re-fires. Never throws (a card GET must not fail on this).

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

export interface RecomputeViabilityEvent {
  readonly __recomputeViability: true;
  readonly caseId: string;
}

export function isRecomputeViabilityEvent(e: unknown): e is RecomputeViabilityEvent {
  return !!e && typeof e === 'object'
    && (e as { __recomputeViability?: unknown }).__recomputeViability === true
    && typeof (e as { caseId?: unknown }).caseId === 'string';
}

let _client: LambdaClient | null = null;
function client(): LambdaClient {
  if (_client === null) _client = new LambdaClient({});
  return _client;
}

/**
 * Ask the API Lambda to compute + persist the viability plan for a case, asynchronously. Returns true if
 * the async invoke was dispatched (not that the compute succeeded). Fail-open: returns false on any issue.
 */
export async function fireRecomputeViability(caseId: string): Promise<boolean> {
  // The reserved AWS Lambda runtime env var (always set) — our own function name. We avoid a CDK-set
  // SELF_FUNCTION_NAME because handler.functionName in the function's own env is a CFN self-ref → circular.
  const fn = process.env['AWS_LAMBDA_FUNCTION_NAME'];
  if (!fn || !caseId) return false;
  try {
    await client().send(new InvokeCommand({
      FunctionName: fn,
      InvocationType: 'Event', // async — returns immediately, runs on a fresh instance off the request path
      Payload: Buffer.from(JSON.stringify({ __recomputeViability: true, caseId } satisfies RecomputeViabilityEvent)),
    }));
    return true;
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'fireRecomputeViability: failed open', caseId, error: e instanceof Error ? e.message : String(e) }));
    return false;
  }
}
