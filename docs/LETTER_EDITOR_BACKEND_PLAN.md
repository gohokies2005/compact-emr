# Cloud Letter-Editor Backend — build plan + status (compact-emr-work)

**Decided 2026-05-30 (Ryan + code-architect-qa review).** The in-EMR letter editor lives in the cloud
(compact-EMR) — RNs (ops_staff), 1099 physicians, and admin all edit/sign one hosted letter from a browser.
Contract + look/feel: FRN repo `docs/EMR_LETTER_EDITOR_BRIEF.md`. This doc is the cloud build plan.

## Locked decisions
1. **Renderer is already dumb** (FRN `pdfgen.js`/`docxgen.js` render the TXT verbatim + chrome; inline bold).
   It reaches the cloud automatically — the drafter image is built from the FRN repo (drafter15 rebuild).
2. **Render-after-edit = a dedicated render Lambda (container image built FROM the FRN repo, like the
   drafter), invoked SYNCHRONOUSLY from the API Lambda.** NOT Fargate render-mode (2-4min cold start kills
   WYSIWYG UX), NOT in the API Lambda (bundle bloat). Render is pure TXT→{pdfBuffer,docxBuffer}, ~2-6s.
3. **Editor save = a NEW `LetterRevision` row, NOT `DraftJob`.** DraftJob carries pipeline state/grade/cost/
   heartbeat and the stuck-job watcher would sweep a fake row; Correction is billable VA-feedback. Editor
   save is neither. (Schema model added this session — see below.)
4. **UNIFIED single source of truth (Ryan 2026-05-30 — SAFETY-CRITICAL).** Ryan's hard requirement: the
   PDF must NEVER render the AI draft when a physician edit exists. Guarantee, three parts:
   (a) **`Case.currentVersion` is THE pointer** to the most recent version — both writers advance it (the
   drafter on `/complete`, the editor on save). (b) **An edit always creates a higher version + sets
   `currentVersion` to it** → a physician edit is always "current" the instant they save. (c) **Render /
   GET / approve / deliver ALL resolve via `currentVersion`** + the verbatim renderer (proven RED→GREEN)
   renders that version's exact text. → rendering a stale AI draft is structurally impossible.
   - **`LetterRevision` is the UNIFIED timeline:** editor saves write directly; the drafter MIRRORS each
     completion in (`source:'drafter_run'`). Reads = the single LetterRevision row at `currentVersion`
     (no max()-across-two-tables ambiguity — that was the bug surface Ryan rightly rejected).
     ⚠ REQUIRES the drafter window to add a ~3-line mirror write to `drafter.ts /complete` — now REQUIRED,
     not optional. Spec'd in `shared/inbox/2026-05-30_REQUIRED_drafter_complete_mirror_letter_revision.md`.
   - **MECHANICAL GUARD (belt-and-suspenders):** approve/deliver refuses to ship unless the rendered
     artifact's version === `Case.currentVersion` (hard-fail, not silent). A future coding mistake can't
     deliver a stale render. Add as a route check + a DB-invariant linter.
   - Transition safety (pre-mirror): if `LetterRevision` has no row at `currentVersion` (a drafted-but-
     never-edited case before the mirror ships), fall back to the `DraftJob` row at `currentVersion`.
     Still keyed off the single `currentVersion` pointer.
5. **Manual editor first; surgical-AI = Phase 2, GREENLIT, model `claude-opus-4-8` (Opus 4.8).** Ryan OK'd
   metered Anthropic spend (small bounded edit, high-stakes physician-facing → most-capable model). Cloud
   surgical-AI meters the key (no free Claude-Max lane in a Lambda); cost-instrument it (record costUsd).
   Still build GET/PUT/approve/decline first; surgical-AI is the last step.

## Build order + status
1. ✅ **Prisma: `LetterRevision` model + `LetterRevisionSource` enum + `Case.letterRevisions`** — added,
   `prisma validate` PASS. ⏳ Migration SQL not yet generated — run `npm run db:migrate` (needs local
   Postgres up) to create `prisma/migrations/<ts>_letter_revisions/`. `editorRole` is a String (cognito
   group), NOT an enum — there is no `AppRole` enum in this schema.
2. ✅ **`s3-key-safety.ts`: `isLetterRevisionS3Key` + `buildLetterRevisionKey`** — added, typechecks clean.
   Keys: `letter-revisions/<caseId>/v<N>/letter.{txt,pdf,docx}` (distinct prefix from drafter-artifacts/).
3. **Render Lambda port (THE RISK — front-load).** Split into 3a (done) / 3b-3c (next):
   - ✅ **3a — renderers are now Lambda-renderable (the disk risk, retired).** Added `options.returnBuffer`
     to FRN `pdfgen.generateLetterPdf` + `docxgen.generateLetterDocx`: returns `{buffer, size}`, **zero disk
     write, no cases/ tree, no version-from-disk detection**. Proven by `renderer-verbatim.test.js` buffer-
     path block (RED→GREEN, 17/17): buffer content is byte-verbatim AND nothing is written under cases/.
     This is the chosen fix over "/tmp outputDir" — cleaner, and ships to cloud with the renderer.
   - ⏭ **3b — render Lambda handler** (compact-emr-work): invoke payload `{caseData, letterText, version,
     draft}` → call the FRN renderers with `returnBuffer:true` → `PutObject` to S3 (`buildLetterRevisionKey`)
     → return `{txtKey, pdfKey, docxKey}`. caseData comes from the invoke payload (RDS row), NOT SQLite. No
     artifacts-table write (the LetterRevision row IS the registration).
   - ⏭ **3c — container image built FROM the FRN repo** (like the drafter): Dockerfile COPYs
     `app/services/{pdfgen,docxgen,conditionFormat,claimedConditionGuard,envelope,logger}.js` + the
     gitignored `samples/R_Kasky_signature.png` (COPY at build, never commit) + pdfkit/docx deps. 🔴 Verify
     the signature PNG bundles, else signatures silently vanish (pdfgen returns null + renders without it).
4. ⏭ `letter-render-invoke.ts` (sync InvokeCommand) + `letter-sanity.ts` (port warn-only checks).
5. ⏭ `routes/letter.ts` GET + PUT (the MVP — open/edit/save/see re-rendered PDF). Optimistic lock: 409 on
   stale base_version + `@@unique([caseId,version])` P2002 → 409 on concurrent save. Role guard
   `requireRole(['admin','ops_staff','physician'])` + physician-assignment gate (copy sign-offs.ts:51-66).
   DRAFT watermark on saves (draft:true); pass the ~10KB txt inline (no S3 bundle needed).
6. ⏭ `approve` (physician; final render draft:false → no watermark → SignOff + status physician_review→
   delivered) + `decline` (physician; reason → status →correction_requested → RN queue).
7. ⏭ CDK: render Lambda (own stack or workers-stack) — phiBucket read + grantPut `letter-revisions/*` +
   documentsKey grantEncryptDecrypt; API Lambda gets `renderLambda.grantInvoke` + RW `letter-revisions/*`.
   No VPC for the render Lambda (S3+KMS only).
8. ⏭ `surgical-ai` — LAST, only after Ryan OKs metered Anthropic spend; cost-instrumented day one.

## Linters to add (mechanical enforcement)
- DB invariant: editor saves land in `letter_revisions`, never `draft_jobs`.
- CI grep: render Lambda handler must not write to a non-`/tmp` `cases/` path (catches the disk regression).
- Surgical-AI must record `costUsd` (no silent metering).

## Cross-window
- Renderer ships to cloud via drafter15 rebuild (FYI sent to drafter window).
- Consider adding pdfgen/docxgen to the C0 gated fileset (future v1.1 amendment).
- Optional future: unified-timeline mirror in drafter.ts `/complete` (drafter window owns; not required now).
