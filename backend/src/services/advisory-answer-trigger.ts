// Fire-and-forget async trigger to compute an Ask Aegis advisory ANSWER OFF the API-Gateway 30s request
// path (Ryan 2026-07-21). The synchronous POST advisory/ask can't finish a 20-40s Opus 4.6 answer under the
// HTTP-API 30s cap (the client 504s and the answer only lands by luck as the Lambda keeps running). Instead
// the ask-async endpoint inserts a `pending` advisoryQuery row and asks the API Lambda to invoke ITSELF
// asynchronously (InvocationType:'Event') to compute + fill that row; the client polls GET .../queries/:id
// until it is terminal. Mirrors recompute-viability-trigger.ts EXACTLY (same self-invoke pattern, reserved
// AWS_LAMBDA_FUNCTION_NAME to dodge the CFN self-ref circular-dep, distinct event shape so no branch clash).
//
// Fail-open: no function-name env, SDK error, or throttle → log and return false; the submit already handed
// the client its queryId, so the poll just times out to a calm message and the next ask re-fires. Never throws.

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

export interface AdvisoryAnswerEvent {
  readonly __advisoryAnswer: true;
  readonly queryId: string;
  readonly caseId: string;
}

export function isAdvisoryAnswerEvent(e: unknown): e is AdvisoryAnswerEvent {
  return !!e && typeof e === 'object'
    && (e as { __advisoryAnswer?: unknown }).__advisoryAnswer === true
    && typeof (e as { queryId?: unknown }).queryId === 'string'
    && typeof (e as { caseId?: unknown }).caseId === 'string';
}

let _client: LambdaClient | null = null;
function client(): LambdaClient {
  if (_client === null) _client = new LambdaClient({});
  return _client;
}

/**
 * Ask the API Lambda to compute + persist the advisory answer for a pending query row, asynchronously.
 * Returns true if the async invoke was dispatched (not that the compute succeeded). Fail-open: false on any issue.
 */
export async function fireAdvisoryAnswer(queryId: string, caseId: string): Promise<boolean> {
  // The reserved AWS Lambda runtime env var (always set) — our own function name. We avoid a CDK-set
  // SELF_FUNCTION_NAME because handler.functionName in the function's own env is a CFN self-ref → circular.
  const fn = process.env['AWS_LAMBDA_FUNCTION_NAME'];
  if (!fn || !queryId || !caseId) return false;
  try {
    await client().send(new InvokeCommand({
      FunctionName: fn,
      InvocationType: 'Event', // async — returns immediately, runs on a fresh instance off the request path
      Payload: Buffer.from(JSON.stringify({ __advisoryAnswer: true, queryId, caseId } satisfies AdvisoryAnswerEvent)),
    }));
    return true;
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'fireAdvisoryAnswer: failed open', queryId, caseId, error: e instanceof Error ? e.message : String(e) }));
    return false;
  }
}
