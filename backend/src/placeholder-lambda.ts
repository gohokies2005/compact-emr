import serverless from 'serverless-http';
import { createApp } from './server.js';
import { prisma } from './db/client.js';
import { deriveAiViability } from './services/ai-viability.js';
import { precomputeSoapNoteForCase } from './services/soap-context-assembler.js';
import { isRecomputeViabilityEvent } from './services/recompute-viability-trigger.js';
import type { AppDb } from './services/db-types.js';

const expressHandler = serverless(createApp());

// The API Lambda also serves an OFF-REQUEST async self-invoke (InvocationType:'Event') that computes the
// AI route-picker plan for a case and persists it — see recompute-viability-trigger.ts. This invocation
// is NOT behind API Gateway, so it is bounded only by the Lambda's own timeout (120s, raised from 29s for
// exactly this path — api-stack.ts). The picker therefore runs with a long 110s budget and actually
// completes + persists on large charts (Zimmelman); the synchronous GET/compute paths can't (they stay
// bounded by their own 26s timeoutMs under the ~30s API-Gateway cap). Fail-open: any error is logged, never
// thrown (an async invoke has no client to surface it to). The event shape is distinct from an API
// Gateway proxy event, so a normal HTTP request never hits this branch.
export const handler = async (event: unknown, context: unknown): Promise<unknown> => {
  if (isRecomputeViabilityEvent(event)) {
    const t0 = Date.now();
    try {
      // ONE async job, BOTH artifacts (Ryan 2026-06-22, Zimmelman): first the picker plan (the verdict the
      // card + drafter use), then — grounded on that SAME plan — the SOAP note, persisted under its
      // server-derived fingerprint so the next sync open serves it for $0. The picker budget is bounded
      // smaller so the note has room within the 110s Lambda budget; the note gets the remaining time.
      const plan = await deriveAiViability(prisma as unknown as AppDb, event.caseId, { compute: true, timeoutMs: 75_000 });
      const planMs = Date.now() - t0;
      // Generate the SOAP note with the REMAINING budget (Lambda timeout 120s, leave headroom). Fail-open:
      // a note failure never affects the plan that already persisted.
      const noteBudget = Math.max(15_000, 110_000 - planMs);
      const noteOk = await precomputeSoapNoteForCase(prisma as unknown as AppDb, event.caseId, noteBudget);
      console.warn(JSON.stringify({ msg: 'ai-viability recompute done', caseId: event.caseId, computed: plan !== null, soapPrecomputed: noteOk, planMs, ms: Date.now() - t0 }));
    } catch (e) {
      console.warn(JSON.stringify({ msg: 'ai-viability recompute failed open', caseId: event.caseId, error: e instanceof Error ? e.message : String(e) }));
    }
    return { ok: true };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (expressHandler as (e: unknown, c: unknown) => unknown)(event, context);
};
