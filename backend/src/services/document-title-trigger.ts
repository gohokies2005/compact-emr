// Fire-and-forget async trigger to TITLE a document OFF every request path. EXACT mirror of
// recompute-viability-trigger.ts (the SOAP/viability recompute): the API Lambda invokes ITSELF
// asynchronously (InvocationType:'Event') with a distinct event shape, and the fresh invocation runs
// the ~2s Haiku titling call on its own (120s) budget instead of on the caller's request.
//
// WHY off-request: writeDocumentPages is called in a SYNCHRONOUS per-document FOR-LOOP inside ONE
// intake-assign API-GW request (routes/intakes.ts), so an inline Haiku call per doc on a 10-doc
// intake would risk the API Gateway 29s cap. The dispatch here is a fast async 202 (not the Haiku
// call) and is fully fail-open — a dropped/failed dispatch just leaves the doc untitled (the list
// falls back to the regex classifier; the next OCR or the backfill re-titles).
//
// The self-invoke IAM permission (function:<stack>-* ) + the 120s Lambda timeout + retryAttempts:0
// already exist in api-stack.ts for the recompute path and are resource-scoped, so this new event
// reuses them with NO CDK change. Killable via AI_DOC_TITLE_ENABLED=off (checked here so we don't
// even dispatch when the feature is off).

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

export interface TitleDocumentEvent {
  readonly __titleDocument: true;
  readonly documentId: string;
}

export function isTitleDocumentEvent(e: unknown): e is TitleDocumentEvent {
  return !!e && typeof e === 'object'
    && (e as { __titleDocument?: unknown }).__titleDocument === true
    && typeof (e as { documentId?: unknown }).documentId === 'string';
}

let _client: LambdaClient | null = null;
function client(): LambdaClient {
  if (_client === null) _client = new LambdaClient({});
  return _client;
}

/**
 * Ask the API Lambda to title + persist one document, asynchronously. Returns true if the async
 * invoke was DISPATCHED (not that titling succeeded). Fail-open: returns false on any issue and never
 * throws — the caller (writeDocumentPages) must not gain latency or a failure mode from this.
 */
export async function fireDocumentTitle(documentId: string): Promise<boolean> {
  if (process.env.AI_DOC_TITLE_ENABLED === 'off') return false;
  // The reserved AWS Lambda runtime env var (always set) — our own function name. We avoid a CDK-set
  // name to dodge the CFN self-ref circular dep (same rationale as recompute-viability-trigger.ts).
  const fn = process.env['AWS_LAMBDA_FUNCTION_NAME'];
  if (!fn || !documentId) return false;
  try {
    await client().send(new InvokeCommand({
      FunctionName: fn,
      InvocationType: 'Event', // async — returns immediately, runs on a fresh instance off the request path
      Payload: Buffer.from(JSON.stringify({ __titleDocument: true, documentId } satisfies TitleDocumentEvent)),
    }));
    return true;
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'fireDocumentTitle: failed open', documentId, error: e instanceof Error ? e.message : String(e) }));
    return false;
  }
}
