# Lower-priority backlog (running list — Ryan-ordered 2026-06-11)

Items explicitly deferred to a future push. Add here instead of losing them in handoffs; remove when shipped.

## Next ECR/api push
1. **"Invoiced" visibility on the Cases list** (Ryan 2026-06-11, Yorde first live invoice): after the RN
   sends the invoice email, NOTHING on /cases shows it — status stays "Ready for delivery" by design
   (we deliberately did NOT invent a new case status; reconciliation to paid is the admin transition).
   Fix = a derived chip/badge on the list row: `Invoiced` when a `letter_500` Payment row with
   status='invoiced' exists (and/or the delivery Email row is status='sent'), `Paid` already covered by
   case status. Backend: include a cheap exists-flag in the /cases list payload; frontend: chip next to
   STATUS. Do NOT add a new case status.
2. **RN card consumes `anchorMechanism.recommendedAction()`** (Aegis Phase-3a brief item 5) — key the UI
   off `band`, not just `{action,route}` (redirect vs unknown share route:'physician'). Card is dark
   (`case_viability_enabled=false`) so no live effect until the flag flips.
3. **Aegis-sees-drafts** (brief item 6, companion note `2026-06-12_to_EMR_aegis_must_see_drafted_letters.md`):
   include the latest drafted letter (prefer approved_final, else currentVersion) in the Ask-Aegis
   case-context payload, labeled "FRN-drafted letter (our work product), version N". Live-pull only,
   never embedded. (chartSlice.ts — buildChartSlice needs s3+bucket deps threaded from routes/advisory.ts.)

## Needs a Ryan policy call
0. **Redraft during physician_review bypasses the RN edit-lock** (adversarial audit 2026-06-12 #1):
   POST /cases/:id/draft has no status guard and `canRedraft` deliberately shows in
   physician_review (Ryan 2026-06-04 "lost the ability to redraft"). A redraft replaces the letter
   AND pulls the case back to rn_review — overt (case visibly leaves the doctor's queue), but it
   contradicts the 2026-06-11 lock. Decide: exclude physician_review from Redraft too, or document
   it as the sanctioned escape hatch. (Also: the drafter's completion write physician_review→
   rn_review isn't in CASE_STATUS_TRANSITIONS — legalize or guard.)

## Whenever
4. `IN_FLIGHT_STATUSES` hand-copied + drifted in routes/physicians.ts:16 + users.ts:14 (missing
   rn_review/needs_rn_decision/needs_records) — a provider with parked cases could be deactivated.
   Dedupe into a shared const. (Architect 🟡, 2026-06-11.)
5. TopNav dead physician entries (Inbox :13, Queue/Letters :23-24) — remove or annotate.
6. InboxPage orphaned sub-line `<p>` in the old header row (cosmetic).
7. "Move to ready for delivery" button wording (staff-only, clunky).
8. pgvector `advisory.ref_chunk` holds ~156 STALE rows from the pre-2026-06-12 corpus regeneration
   (loader is INSERT-only by design) — needs an Aegis-window decision + a one-off DELETE WHERE id NOT IN
   current-corpus pass (extend the loader with an optional prune mode).
9. ScCondition variant explosion beyond the PTSD-class dedup guard (Perez: ~5 lumbar variants, 3 HTN
   variants from one statement) — fold into the ICD-10/DC-keyed chart model phase.
10. `previouslyDenied` not API-patchable (Perez has it wrong: false despite two prior decisions in
    chart) — add to parseCasePatch allowed fields + a chart-vs-field consistency nudge.
11. Express `trust proxy` not configured (server.ts) — the portal IP throttle reads the right-most XFF
    hop manually as the workaround; setting trust proxy properly would let req.ip be correct everywhere.
12. SES production-access appeal (case 178094063100860) — prerequisites first: CloudTrail (audit INF-1),
    bounce/complaint SNS wiring, DKIM/MAIL-FROM check; then the appeal letter. Gmail transport is
    primary regardless.
13. Deploy workflow "Smoke test - Lambda cold start" step fails on EVERY run (pre-existing) — workflow
    always reads red; fix the smoke (payload/permissions) so green means green.
14. `window.open` after `await` in openSourceDocument/openPendingFile — popup blockers (Safari
    always, Chrome on slow presigns) silently eat the open; pre-open about:blank or check the
    return (audit 2026-06-12 #7; pre-existing pattern, now also physician-facing).
15. Invoiced Payment rows never reconcile to a terminal state (Stripe settle creates a NEW paid
    row) — fine for the chip, a footgun for future revenue reports summing by payment status.
16. Watcher give-up increments the `generatingFailed` counter for queued rows (metric mislabel) +
    each drained duplicate message logs a 'double-failure' line (noise, no PHI).
17. Untrack `workers/ocr/__pycache__/*.pyc` (tracked compiled artifacts churn in every diff) +
    add __pycache__ to .gitignore.
18. Review follow-up automation candidate: surface a "send review follow-up" draft task N days after
    delivery (DRAFT-only discipline per feedback_never_send_veteran_email_autonomously.md). Playbook:
    flatratenexus-project/docs/REVIEW_ASK_PLAYBOOK.md.

## Doctor-pack round 2 (PCP re-review 2026-06-12 — verdict USABLE-WITH-CHART-CHECKS; these reach SIGNABLE)
A. CONTENT-HASH dedup in pack assembly (pipeline-blocking per PCP): the same MHV export uploaded under
   two filenames produced 16 duplicate pages (Misc_6=Misc_8, Misc_9=Misc_10); dedup manifest entries on
   document content sha, not filename.
B. Residual notification-letter boilerplate (5pp survived): add kill-list patterns for VALife /
   VSignals survey / VA Form 20-0998 QR appeal page / monthly-entitlement table / commissary-travel
   enclosure; the dup QR page also dies with A.
C. Include the veteran lay/timeline statement (the case veteranStatement field) as a rendered pack
   page — or cover-sheet flag when absent.
D. One-page cover index: each doc, date, why included (esp. non-obvious pages like a non-SC hip denial).
E. Order medicine-first: dx note -> PCP note -> rating decision -> radiology -> DD-214.
