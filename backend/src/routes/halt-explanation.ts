/**
 * GET /api/v1/cases/:id/halt-explanation (Dr. Kasky 2026-07-02)
 *
 * On-demand, LLM-generated PLAIN-LANGUAGE explanation of why a paused nexus-letter draft halted and what the
 * RN should do to unstick it. Reads the case's live halt state (the SAME data the OpsHeldPanel / Gate2HaltPanel
 * render) + its caseFraming + granted SC conditions + problem list, and hands them to explainHalt().
 *
 * Contract:
 *   { data: { summary, what_to_do, confidence } }  when the case is paused and the LLM produced an explanation
 *   { data: { available: false } }                 when the case is NOT paused, or the LLM was unavailable/failed
 *
 * The panel keeps its existing raw/technical halt message as a collapsible fallback, so `available:false` never
 * loses information — it just means "no plain-language layer this time".
 *
 * LATENCY (ARCHITECTURE §5): explainHalt is a single bounded (≤20s, maxRetries 0) Sonnet call that runs in a
 * few seconds — safe on the synchronous 29s API path. A short-TTL in-memory cache keyed by caseId + a hash of
 * (rawReason + framing) means re-opening the same paused case does not re-bill; it regenerates only when the
 * halt reason or framing changes. No DB migration.
 */

import { Router, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { requireRole } from '../auth/roles.js';
import { deriveCaseFramingForCase } from '../services/case-framing-stamp.js';
import { explainHalt, type HaltExplanation } from '../services/halt-explainer.js';
import type { AppDb } from '../services/db-types.js';

// A case is "paused" (there is a halt to explain) when its status is one of the RN-decision holds, its
// operator state is 'paused', or its latest draft job is in the terminal 'halted' state.
const PAUSED_CASE_STATUSES = new Set<string>(['needs_rn_decision', 'needs_records']);

interface HaltCaseRow {
  readonly id: string;
  readonly veteranId: string;
  readonly status: string;
  readonly operatorState: string | null;
  readonly operatorMessage: string | null;
  readonly claimedCondition: string;
}

interface HaltJobRow {
  readonly state: string;
  readonly currentPhase: string | null;
  readonly errorMessage: string | null;
  readonly haltPayloadJson: unknown;
}

function isCasePaused(c: HaltCaseRow, job: HaltJobRow | null): boolean {
  if (PAUSED_CASE_STATUSES.has(c.status)) return true;
  if (c.operatorState === 'paused') return true;
  if (job !== null && job.state === 'halted') return true;
  return false;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/**
 * The raw, un-truncated halt reason: prefer the drafter's full plain-English halt payload (the RN-facing
 * reason the drafter emitted before pipelinePhase.js clipped it to 200 chars), then the case operator message,
 * then the draft-job error. This is what the LLM translates.
 */
function extractRawReason(c: HaltCaseRow, job: HaltJobRow | null): string {
  const halt = asRecord(job?.haltPayloadJson);
  return (
    str(halt?.['plainEnglish']) ??
    str(halt?.['operatorMessage']) ??
    str(c.operatorMessage) ??
    str(job?.errorMessage) ??
    'The draft was paused for review.'
  );
}

/** The pipeline phase/gate that halted: prefer the halt payload's reasonCode/haltGate, else the job phase. */
function extractPhase(job: HaltJobRow | null): string {
  const halt = asRecord(job?.haltPayloadJson);
  return str(halt?.['reasonCode']) ?? str(halt?.['haltGate']) ?? str(job?.currentPhase) ?? 'unknown';
}

/** CFR-basis hint for a framing theory (internal — the model explains it in plain words to the RN). */
function cfrForTheory(theory: string): string | null {
  if (theory === 'direct') return '38 CFR 3.303';
  if (theory === 'secondary') return '38 CFR 3.310(a)';
  if (theory === 'aggravation') return '38 CFR 3.310(b)';
  return null;
}

/** Normalize a condition name for the already-granted equality check: lowercase, drop any parenthetical
 *  (rating / laterality note), collapse whitespace, trim. */
function normalizeCondition(s: string): string {
  return s.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * DETERMINISTIC already-service-connected check (highest-stakes determination): the granted SC condition whose
 * normalized name EXACTLY matches the claimed condition, or null. Exact-normalized equality (NOT substring) so
 * "sleep apnea" does not falsely match "sleep apnea secondary to X" and vice-versa — a false positive here would
 * wrongly tell the RN to re-route a real nexus case.
 */
function computeAlreadyGrantedMatch(claimed: string, sc: ReadonlyArray<{ name: string }>): string | null {
  const c = normalizeCondition(claimed);
  if (c.length === 0) return null;
  for (const s of sc) {
    if (normalizeCondition(s.name) === c) return s.name;
  }
  return null;
}

// ── LIGHT in-memory TTL cache: keyed by caseId + sha256(rawReason + framing). Re-opening the same paused case
// serves the cached explanation; a changed halt reason or framing produces a new key → a fresh compute.
interface CacheEntry {
  readonly value: HaltExplanation;
  readonly expires: number;
}
const CACHE_TTL_MS = 10 * 60_000;
// Hard cap so the module cache can't grow unbounded: every re-halt / reframe mints a NEW key and orphans the
// old one (expiry is only checked on read of the SAME key), so without a cap the Map leaks slowly over a long-
// lived process. On write we sweep expired entries, then evict oldest (Map is insertion-ordered) until under cap.
const MAX_CACHE_ENTRIES = 500;
const _cache = new Map<string, CacheEntry>();

function cacheGet(key: string): HaltExplanation | null {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    _cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key: string, value: HaltExplanation): void {
  const now = Date.now();
  // Sweep expired first (cheap amortized cleanup on the write path).
  for (const [k, v] of _cache) {
    if (v.expires < now) _cache.delete(k);
  }
  _cache.set(key, { value, expires: now + CACHE_TTL_MS });
  // Evict oldest until under cap.
  while (_cache.size > MAX_CACHE_ENTRIES) {
    const oldest = _cache.keys().next().value;
    if (oldest === undefined) break;
    _cache.delete(oldest);
  }
}

export function createHaltExplanationRouter(db: AppDb): Router {
  const router = Router();

  router.get(
    '/cases/:id/halt-explanation',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);

      const c = (await db.case.findFirst({
        where: { id: caseId },
        select: { id: true, veteranId: true, status: true, operatorState: true, operatorMessage: true, claimedCondition: true },
      })) as HaltCaseRow | null;
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });

      // The latest draft job carries the halt phase + payload (same rows /cases/:id/draft-jobs serves the panels).
      const job = (await db.draftJob.findFirst({
        where: { caseId },
        orderBy: { version: 'desc' },
        select: { state: true, currentPhase: true, errorMessage: true, haltPayloadJson: true },
      })) as HaltJobRow | null;

      if (!isCasePaused(c, job)) {
        res.json({ data: { available: false } });
        return;
      }

      const rawReason = extractRawReason(c, job);
      const phase = extractPhase(job);

      // Framing (theory + upstream) via the ONE shared derivation; null → undetermined framing (fail-open).
      const caseFraming = await deriveCaseFramingForCase(db, caseId).catch(() => null);
      const theory = caseFraming?.framing ?? 'undetermined';
      const upstream = caseFraming?.upstreamScCondition ?? null;
      const grantedScConditions = (caseFraming?.grantedScAnchors ?? []).map((a) => ({ name: a.condition, ratingPct: a.ratingPct }));
      // Deterministic highest-stakes fact: is the claimed condition ALREADY on the granted SC list? (→ re-route,
      // not a nexus letter). Computed here, passed to the model as a stated fact, and part of the cache key.
      const alreadyGrantedMatch = computeAlreadyGrantedMatch(c.claimedCondition, grantedScConditions);

      const cacheKey = `${caseId}:${createHash('sha256')
        .update(JSON.stringify({ rawReason, phase, theory, upstream, sc: grantedScConditions, alreadyGrantedMatch }))
        .digest('hex')}`;
      const cached = cacheGet(cacheKey);
      if (cached) {
        res.json({ data: cached });
        return;
      }

      const problems = await db.activeProblem
        .findMany({ where: { veteranId: c.veteranId }, select: { problem: true } })
        .catch(() => [] as { problem: string }[]);
      const problemList = [...new Set((problems as { problem: string }[]).map((p) => (p.problem ?? '').trim()).filter(Boolean))];

      const explanation = await explainHalt({
        phase,
        rawReason,
        claimedCondition: c.claimedCondition,
        framing: { theory, upstream, cfr: cfrForTheory(theory) },
        grantedScConditions,
        problemList,
        alreadyGrantedMatch,
      });

      if (explanation === null) {
        res.json({ data: { available: false } });
        return;
      }

      cacheSet(cacheKey, explanation);
      res.json({ data: explanation });
    }),
  );

  return router;
}
