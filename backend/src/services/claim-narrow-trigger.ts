// Fire-and-forget async trigger to AI-NARROW a generic "Other …" claim label to a specific documented dx,
// OFF the 29s request path (Ryan 2026-07-04, Drummond). Mirrors recompute-viability-trigger.ts: the API
// Lambda invokes ITSELF asynchronously (InvocationType:'Event') so a ~2s Haiku call never rides the intake
// request. In practice the primary trigger is the existing async recompute job (placeholder-lambda calls
// narrowAndPersistClaim before deriveAiViability, so a card open post-extraction narrows the claim first);
// this dedicated event exists for explicit/standalone narrowing. Fail-open: never throws.

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

export interface NarrowClaimEvent {
  readonly __narrowClaim: true;
  readonly caseId: string;
}

export function isNarrowClaimEvent(e: unknown): e is NarrowClaimEvent {
  return !!e && typeof e === 'object'
    && (e as { __narrowClaim?: unknown }).__narrowClaim === true
    && typeof (e as { caseId?: unknown }).caseId === 'string';
}

let _client: LambdaClient | null = null;
function client(): LambdaClient {
  if (_client === null) _client = new LambdaClient({});
  return _client;
}

/** Ask the API Lambda to AI-narrow a case's generic claim label asynchronously. Returns true if the async
 *  invoke was dispatched (not that the narrow succeeded). Fail-open: returns false on any issue. */
export async function fireNarrowClaim(caseId: string): Promise<boolean> {
  const fn = process.env['AWS_LAMBDA_FUNCTION_NAME'];
  if (!fn || !caseId) return false;
  try {
    await client().send(new InvokeCommand({
      FunctionName: fn,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({ __narrowClaim: true, caseId } satisfies NarrowClaimEvent)),
    }));
    return true;
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'fireNarrowClaim: failed open', caseId, error: e instanceof Error ? e.message : String(e) }));
    return false;
  }
}
