# Drafter checkpoint-resume — design for QA (2026-06-18)

**Status: NOT BUILT. Design only, pre-QA.** The current "Resume" re-runs the whole pipeline from
Gate-2 = a full ~$15 redraft. This spec is for the real fix: a mid-pipeline hiccup must resume at the
failed phase, reusing the paid work.

**Ryan's intent (verbatim):** "resume is when a fargate or vCPU gets overwhelmed and the draft errors
out mid draft — resume picks up there. redraft is the whole $15 thing again … when $14 of the $15 has
been spent already but there is a hiccup, start at that hiccup, not a whole new letter. that could make
me go broke. whole redraft is for massively new files / whole vision change." (Manual/surgical/broad
editing already exists — NOT this; this is crash recovery.)

## Current reality (from live logs CLM-5C98678201 + the aws-cloud-sme pipeline map)
The drafter (claude.js on Fargate, SQS FIFO `compact-emr-staging-draft-job.fifo`) runs these phases,
each writing artifacts to the task's LOCAL `/tmp` job folder (`/frn/cases/emr-<case>-job-<jobId>/drafts/`):
1. Gate-2 (dx/event verify) → 2. Phase 0 index → 3. Phase 0.4 framing gate (`v0_framing.json`) →
4. Phase 0.5 source lock → 5. Phase 1 initial draft (`v1.txt`, ~6.5 min, the big spend) → 6. Phase 2
adversary panel (4 roles) → 7. Phase 3 specialist gate (6 roles) → 8. Phase 4 refine loop (v1→v2) →
9. Phase 4.6a surgical edit (v2→v3) → 10. Phase 4.5 citation scoring → 11. publish/grade/PDF.

**Failure mode:** the Fargate task dies mid-pipeline (vCPU/throttle/overwhelm) → `/tmp` is lost → the
FIFO message redelivers (visibility timeout) → a NEW task picks it up → finds nothing → restarts at
Gate-2 → re-pays every phase. THAT is the money burn.

## Proposed design (to be pressure-tested)
**Principle: persist each completed phase to durable storage; on (re)start, load the manifest, restore
completed-phase artifacts, and skip to the next unfinished phase. Re-enter only the phase that was
interrupted.**

1. **Checkpoint store (durable).** After each phase fully completes (artifact written + validated),
   copy its artifact(s) to S3 PHI bucket under `drafter-checkpoints/<caseId>/<jobId>/<phase>/…` plus a
   `manifest.json` recording `{ lastCompletedPhase, phaseArtifacts[], inputsFingerprintHash }`. Small
   JSON/text — cheap. PHI → PHI bucket + an S3 lifecycle rule (e.g. 7-day expiry) so checkpoints don't
   accumulate chart text.
2. **Resume on start.** When a task starts a job, read `manifest.json` for that jobId. If present AND
   the bundle inputs fingerprint matches (see #5), hydrate the `/tmp` job folder from the checkpoint
   artifacts and set the pipeline cursor to `lastCompletedPhase + 1`. If absent/mismatch → fresh run.
3. **Job identity (the EMR seam).** Automatic crash-recovery already redelivers the SAME jobId on the
   SAME FIFO message — so #1+#2 give AUTOMATIC resume with no human click. The human "Resume" button,
   though, currently calls `POST /draft` which MINTS A NEW jobId/folder → checkpoints wouldn't match.
   Fix: "Resume" must re-enqueue the SAME jobId (resume) — distinct from "Redraft" (new jobId, ignore +
   delete checkpoints). The EMR owns this distinction.
4. **Re-enter the interrupted phase from its start.** We do NOT try to resume mid-phase (a half-streamed
   RUN-1 draft). The interrupted phase re-runs from its beginning; ALL prior completed phases are
   skipped. That alone saves the bulk (framing/source-lock/Phase-1 are the big costs and complete before
   the later gates). Checkpoint ONLY after a phase fully completes — never a partial.
5. **Invalidation / safety.** The manifest stores a fingerprint of the bundle inputs (chart docs,
   claimed condition, framing). If the inputs changed since the checkpoint (new files, vision re-read —
   Ryan's "massively new files" case), the fingerprint mismatches → ignore the checkpoint, full redraft.
   This is the line between "resume" (same inputs, hiccup) and "redraft" (inputs changed).
6. **Loop/cost guard.** FIFO MessageGroupId=caseId already serializes (no parallel tasks on one case) and
   caps redeliveries (~3). Resume must not create a re-pay loop: if the SAME phase fails N times, stop +
   flag for a human (don't infinitely re-pay that phase). Reuse the existing stuck/needs_rn states.

## Lane split
- **DRAFTER window (FRN claude.js):** the phase loop — persist-after-each-phase, the manifest, and
  skip-completed-on-start + re-enter-interrupted-phase. This is the core.
- **EMR window (me):** the S3 checkpoint prefix + lifecycle rule (infra); the "Resume reuses jobId vs
  Redraft mints new" distinction in `POST /draft` + the OpsHeldPanel buttons; the inputs-fingerprint the
  manifest stores.

## Open questions for QA (find what I missed)
- Is per-phase S3 persistence the right granularity, or should checkpoints be coarser/finer?
- Mid-phase failures within the multi-role gates (Phase 2/3 fire 4–6 roles in parallel) — checkpoint
  per-role or per-phase? A 6-role specialist gate that dies after 5 roles re-pays all 6 on resume.
- Fingerprint contents: what exactly must match to call it "same inputs" safely (and not silently reuse
  a stale framing after a chart change)?
- Race: task A dies but its SQS message hasn't redelivered yet while a human clicks "Resume" → two
  resumes of the same jobId? (FIFO should serialize, but confirm.)
- Does resuming a persisted framing/source-lock (LLM outputs) risk any correctness drift vs a fresh run,
  or is reuse strictly better (it's the paid, already-reviewed output)?
- Cleanup/PHI: is a 7-day lifecycle on chart-derived checkpoints acceptable, or tighter?
- Is there a cheaper/simpler architecture than S3-per-phase (e.g., write the job folder to EFS, or
  persist only the 3 expensive artifacts: framing, source-lock, the latest vN.txt)?

## ⚠️ QA VERDICT 2026-06-18 (architect + aws-cloud-sme + anthropic-ai-sme): REWORK→SHIP-WITH-FIXES
**This design had a fatal wrong assumption. Do NOT build it as originally written. Fold into the prior
`flatratenexus-project/docs/DRAFTER_I3_RESUME_SCOPE.md` (more rigorous) + apply these must-fixes:**

1. **🔴 KEY CHECKPOINTS ON (caseId + inputs-fingerprint), NOT jobId.** Design claim #3 is FALSE against
   the live system: the worker extends SQS visibility every heartbeat (30 min), so SQS almost never
   redelivers the same message. Real recovery = the **stuck-job-watcher** (`backend/src/lambdas/
   stuck-job-watcher.ts`, 5-min sweep, 10-min stale-heartbeat) flips the job failed + `enqueueAutoRerunForCase`
   (`draft-auto-rerun.ts:65`) mints a **NEW jobId**. jobId-keyed checkpoints would never match → silent
   full re-pay. The stuck-job-watcher + enqueueAutoRerunForCase are an UNLISTED LANE — they must become
   checkpoint-aware (carry a `resume` signal; consume the (caseId,fingerprint) checkpoint).
2. **🔴 STALE-LETTER HOLE: gate resume on `manifest.phases[id].status === 'ran'`, NOT fs.exists.** A
   half-written artifact from a killed stream is falsely skipped → ships a stale/Frankenstein letter.
   Per-artifact sha256 in the manifest; write artifact→S3 FIRST, advance the cursor LAST (atomic); a
   crash between = re-run the phase. On resume hydrate /tmp ONLY from manifest-listed artifacts (ignore
   loose files). Key convergence phases on (phase, round), not phase alone.
3. **🔴 COMPOUND RESUME GATE — fail toward fresh.** Resume iff `inputsFingerprint == stored AND per-phase
   modelId == stored AND drafterBuildTag == stored`. Any mismatch → full redraft. A new drafter deploy
   INTENTIONALLY invalidates in-flight checkpoints (old framing + new §VII rules = a wrong letter).
   Reuse-the-paid-artifact is a CONSISTENCY requirement (temperature is unset/default ~1.0 → regenerating
   is non-reproducible) — never "refresh" an early phase on resume.
4. **FINGERPRINT = content hash of the MATERIALIZED bundle the drafter actually consumed** (catches a
   re-OCR with no new file): chart-extract output text + canonical claimed/secondary conditions +
   granted-SC list/SC status + RN strategyOverride text + caseFraming SSOT hash + Gate-2 outcome +
   BUNDLE_SCHEMA_VERSION + PIPELINE_PHASE_VERSION. Computed IN THE WORKER (it sees OCR text the EMR
   doesn't). Recompute on resume + compare; never store-and-trust a flag.
5. **MULTI-ROLE GATES (adversary 4 / specialist 6) ARE TRANSACTIONAL — checkpoint per-PHASE, not
   per-role.** A half-complete review set silently under-corrects. Resume re-runs the whole gate (cheap
   phases); downstream asserts the full expected role-set is present before consuming.
6. **PURE CONTENT-ADDRESSED PHASES:** each phase reads a pinned input version, writes a fixed output
   version (never "latest vN") → re-entry is byte-equivalent to first-entry, no compounding double-edits.
7. **RESUME ALWAYS RUNS THE FULL PUBLISH-GATE LINTERS** on the assembled letter (`pipelineLinter.js`) —
   the last net for a Frankenstein / the recurring SSN-VA-file-number preamble leak.
8. **NEW GUARDS (resume can become the next $231):** a manifest `resumeAttempts` cap (K=2; if
   lastCompletedPhase doesn't advance, stop → full-redraft-once → park to needs_rn) + a per-case
   **resume-loop CloudWatch alarm** (the existing NotVisible>=12 spend alarm can't see one stuck case).
9. **INFRA:** checkpoints are PHI → KMS PHI bucket; the task role PUT grant is scoped to
   `drafter-artifacts/*` only (`drafter-stack.ts:126`) → nest checkpoints UNDER `drafter-artifacts/<caseId>/checkpoints/`
   to reuse the grant (a new prefix = AccessDenied). S3-per-completed-phase is correct (NOT EFS). NO
   SIGTERM partial-flush (OOM/SIGKILL give no window; mid-phase state is the malformed-letter risk).
   Lifecycle 48–72h. visibilityTimeout=45min, maxReceiveCount=3 (DLQ) confirmed.
10. **Carry CUMULATIVE COST forward** in the manifest or a resumed run under-reports the very spend this
    project controls.

**Lane:** the pipeline half (persist/skip/manifest/fingerprint/atomic-cursor/transactional-gates) is the
DRAFTER window (FRN claude.js + the I3 scope). EMR owns: stuck-job-watcher checkpoint-awareness, the
resume-vs-redraft signal, the S3 prefix + lifecycle, the resume-loop alarm + cap. Architect-QA owns the
per-phase idempotency/side-effect audit (double-fired /progress|/complete callbacks, §VII double-patch).

## Interim money-guard (EMR, shippable now, NOT the fix)
Until this lands, make the "Resume" confirm HONEST about cost so nobody burns $15 expecting a cheap
continue: "This re-runs the ENTIRE draft (~$15) from the start — checkpoint-resume isn't available yet.
Continue?" Relabel the button "Re-draft (full)" where a completed draft already exists.
