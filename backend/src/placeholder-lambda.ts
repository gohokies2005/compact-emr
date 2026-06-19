import serverless from 'serverless-http';
import { createApp } from './server.js';
import { prisma } from './db/client.js';
import { deriveAiViability } from './services/ai-viability.js';
import { isRecomputeViabilityEvent } from './services/recompute-viability-trigger.js';
import type { AppDb } from './services/db-types.js';

const expressHandler = serverless(createApp());

// The API Lambda also serves an OFF-REQUEST async self-invoke (InvocationType:'Event') that computes the
// AI route-picker plan for a case and persists it — see recompute-viability-trigger.ts. This invocation
// owns the whole 29s window with nothing else on it, so the picker runs with a higher timeout (~26s) and
// actually completes + persists (the synchronous GET path can't). Fail-open: any error is logged, never
// thrown (an async invoke has no client to surface it to). The event shape is distinct from an API
// Gateway proxy event, so a normal HTTP request never hits this branch.
export const handler = async (event: unknown, context: unknown): Promise<unknown> => {
  if (isRecomputeViabilityEvent(event)) {
    const t0 = Date.now();
    try {
      const plan = await deriveAiViability(prisma as unknown as AppDb, event.caseId, { compute: true, timeoutMs: 26_000 });
      console.warn(JSON.stringify({ msg: 'ai-viability recompute done', caseId: event.caseId, computed: plan !== null, ms: Date.now() - t0 }));
    } catch (e) {
      console.warn(JSON.stringify({ msg: 'ai-viability recompute failed open', caseId: event.caseId, error: e instanceof Error ? e.message : String(e) }));
    }
    return { ok: true };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (expressHandler as (e: unknown, c: unknown) => unknown)(event, context);
};
