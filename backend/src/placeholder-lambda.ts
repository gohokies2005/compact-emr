import serverless from 'serverless-http';
import { createApp } from './server.js';
import { prisma } from './db/client.js';
import { getAiViabilityState } from './services/ai-viability.js';
import { precomputeSoapNoteForCase } from './services/soap-context-assembler.js';
import { isRecomputeViabilityEvent } from './services/recompute-viability-trigger.js';
import { isTitleDocumentEvent } from './services/document-title-trigger.js';
import { generateAndPersistDocumentTitle } from './services/aiDocumentTitle.js';
import { isNarrowClaimEvent } from './services/claim-narrow-trigger.js';
import { narrowAndPersistClaim } from './services/aiClaimNarrow.js';
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
      // CLAIM-NARROW FIRST (Ryan 2026-07-04): if the claim is a generic "Other …" dropdown label, narrow it to
      // the specific documented dx BEFORE the picker runs, so viability + SOAP compute on the real diagnosis
      // (not the catch-all the drafter would refuse). No-ops fast (a cheap findFirst + regex) for the ~99% of
      // cases whose claim is already specific or is 'manual'. Fail-open; never blocks the recompute.
      const narrowed = await narrowAndPersistClaim(prisma as unknown as AppDb, event.caseId);
      if (narrowed.updated) console.warn(JSON.stringify({ msg: 'ai-claim-narrow updated', caseId: event.caseId, diagnosis: narrowed.diagnosis }));
      // ONE async job, BOTH artifacts (Ryan 2026-06-22, Zimmelman): first the picker plan (the verdict the
      // card + drafter use), then — grounded on that SAME plan — the SOAP note, persisted under its
      // server-derived fingerprint so the next sync open serves it for $0. The picker budget is bounded
      // smaller so the note has room within the 110s Lambda budget; the note gets the remaining time.
      // The discriminated STATE (not the null-collapsing deriveAiViability) so this job can tell "another
      // invocation is already mid-compute" ('computing', the in-flight guard short-circuit) apart from a
      // genuine result — see the skip below.
      const planState = await getAiViabilityState(prisma as unknown as AppDb, event.caseId, { compute: true, timeoutMs: 75_000 });
      const planMs = Date.now() - t0;
      // DUPLICATE-WRITE GUARD (Ryan 2026-07-14, "2 ungrounded Sonnet writes per edit"). When the plan compute
      // was SKIPPED because another invocation holds the in-flight guard (getAiViabilityState returned
      // 'computing' without running the LLM), the plan this invocation would ground the SOAP on does not exist
      // YET — running the SOAP precompute now would burn a Sonnet call on an UNGROUNDED context and the
      // in-flight invocation will write the real grounded note itself moments later. Skip both artifacts and
      // let the owner invocation finish the job.
      if (planState.status === 'computing') {
        console.warn(JSON.stringify({ msg: 'ai-viability recompute skipped — compute already in flight', caseId: event.caseId, planMs, ms: Date.now() - t0 }));
        return { ok: true, skipped: 'in_flight' };
      }
      // Generate the SOAP note with the REMAINING budget (Lambda timeout 120s, leave headroom). Fail-open:
      // a note failure never affects the plan that already persisted.
      const noteBudget = Math.max(15_000, 110_000 - planMs);
      const noteOk = await precomputeSoapNoteForCase(prisma as unknown as AppDb, event.caseId, noteBudget);
      console.warn(JSON.stringify({ msg: 'ai-viability recompute done', caseId: event.caseId, computed: planState.status === 'ready', soapPrecomputed: noteOk, planMs, ms: Date.now() - t0 }));
    } catch (e) {
      console.warn(JSON.stringify({ msg: 'ai-viability recompute failed open', caseId: event.caseId, error: e instanceof Error ? e.message : String(e) }));
    }
    return { ok: true };
  }
  // OFF-REQUEST async self-invoke to AI-narrow a generic "Other …" claim label (claim-narrow-trigger.ts).
  // Standalone path (the primary path runs inside the recompute job above); fail-open + guarded (no-op unless
  // the claim is generic AND source != 'manual' AND records are present).
  if (isNarrowClaimEvent(event)) {
    try {
      const r = await narrowAndPersistClaim(prisma as unknown as AppDb, event.caseId);
      console.warn(JSON.stringify({ msg: 'ai-claim-narrow done', caseId: event.caseId, updated: r.updated, diagnosis: r.diagnosis ?? null, skipped: r.skipped ?? null }));
    } catch (e) {
      console.warn(JSON.stringify({ msg: 'ai-claim-narrow failed open', caseId: event.caseId, error: e instanceof Error ? e.message : String(e) }));
    }
    return { ok: true };
  }
  // OFF-REQUEST async self-invoke for AI document titling (InvocationType:'Event', see
  // document-title-trigger.ts). Runs the ~2s Haiku titling call here instead of on the intake request.
  // Fail-open + idempotent (the orchestrator skips already-titled docs); AI_DOC_TITLE_ENABLED=off is a
  // second guard (the trigger already short-circuits when off).
  if (isTitleDocumentEvent(event)) {
    if (process.env.AI_DOC_TITLE_ENABLED === 'off') return { ok: true, skipped: 'flag_off' };
    try {
      const r = await generateAndPersistDocumentTitle(prisma as unknown as AppDb, event.documentId);
      console.warn(JSON.stringify({ msg: 'ai-document-title done', documentId: event.documentId, updated: r.updated, skipped: r.skipped ?? null }));
    } catch (e) {
      console.warn(JSON.stringify({ msg: 'ai-document-title failed open', documentId: event.documentId, error: e instanceof Error ? e.message : String(e) }));
    }
    return { ok: true };
  }
  return (expressHandler as (e: unknown, c: unknown) => unknown)(event, context);
};
