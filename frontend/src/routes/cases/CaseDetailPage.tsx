import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../../layout/AppShell';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { CaseStatusBadge } from '../../components/ui/CaseStatusBadge';
import { TabSection } from '../../components/ui/TabSection';
import { DataRow } from '../../components/ui/DataRow';
import { StatusChip, type ChipTone } from '../../components/ui/StatusChip';
import { RowAction } from '../../components/ui/RowAction';
import { TabBar, type TabItem } from '../../components/ui/TabBar';
import { SignOffPopup } from '../../components/SignOffPopup';
import { InFlightDrafterPanel, type InFlightDraftJob } from '../../components/InFlightDrafterPanel';
import { SendToDrafterPanel } from '../../components/SendToDrafterPanel';
import { ExtractionCoveragePanel } from '../../components/ExtractionCoveragePanel';
import { ChartRecoveryBanner } from '../../components/ChartRecoveryBanner';
import { PhysicianLetterReadyPanel } from '../../components/PhysicianLetterReadyPanel';
import { SendToDoctorModal } from '../../components/SendToDoctorModal';
import { ReturnToPhysicianModal } from '../../components/ReturnToPhysicianModal';
import { ReviseLetterModal } from '../../components/ReviseLetterModal';
import { ReviewChangesPopup } from '../../components/ReviewChangesPopup';
import { DeliveryPanel } from '../../components/DeliveryPanel';
import { OpsHeldPanel } from '../../components/OpsHeldPanel';
import { Gate2HaltPanel } from '../../components/Gate2HaltPanel';
import { DecisionsOverridesPanel } from '../../components/DecisionsOverridesPanel';
import { AdvisoryPanel } from '../../components/AdvisoryPanel';
import { DoctorPackPanel } from '../../components/DoctorPackPanel';
import { DocumentUploadPanel } from '../../components/DocumentUploadPanel';
import { CaseAssignmentPanel } from '../../components/CaseAssignmentPanel';
import { CaseMessagesPanel } from '../../components/CaseMessagesPanel';
import { joinCaseLabel } from '../../components/messaging/caseLabel';
import { EmailLogPanel } from '../../components/EmailLogPanel';
import { ChartNotesPanel } from '../veterans/ChartNotesPanel';
import { getLatestQuickNote, createChartNote, patchChartNote } from '../../api/chart-notes';
import { ConditionsPanel, MedicationsPanel, ProblemsPanel } from '../../components/ClinicalChartPanels';
import { listCaseEmails } from '../../api/emails';
import { getArtifactPdfUrl, postDraft, cancelDraftJob, getDraftConcurrency, uploadAndImportLetter, type DraftConcurrencyResult } from '../../api/drafter';
import { getLetter } from '../../api/letter';
import { deleteDocument, getVeteran, listDocuments, reocrDocument } from '../../api/veterans';
import { PdfViewerModal, type ViewableDoc } from '../../components/PdfViewerModal';
import { formatConditionLabel } from '../../lib/conditionLabel';
import { Gate1ChecklistModal } from '../../components/Gate1ChecklistModal';
import { useAuth } from '../../auth/useAuth';
import { ConflictError, describeApiError } from '../../api/client';
import { letterFilename } from '../../lib/letterFilename';
import { allowedNextStatusesForRole, CASE_STATUS_LABELS } from '../../lib/caseStatus';
import { NOTES_TAB, SHARED_TABS, type SharedTabId } from '../../lib/caseTabs';
import { resolveCaseTopPanels, CHART_WORKING_STATUSES, deriveLatestHaltSignals, type DraftJobHaltShape } from '../../lib/caseTopPanels';
import { resolveViewableLetterJob } from '../../lib/viewableLetter';
import { StrategyPreviewCard } from '../../components/StrategyPreviewCard';
// CaseViabilityCard mount REMOVED from this page (Ryan 2026-06-20, item #64): the static M/E
// (mechanism/evidence) "Anchor viability" ratings card is erased from the case UI entirely.
// RecommendedPlanCard mount REMOVED from this page (Ryan 2026-06-29): its deterministic verdict chip
// ("Draft"/"Contact veteran"/"Not supportable") from recommendedPlan() was a SECOND pre-draft verdict
// surface that could contradict the SOAP/viability card — the single pre-draft signal now. The
// component file + its standalone tests are kept (recommendedPlan() still serves other lanes); only
// the mount + import are gone here.
import { SoapOverviewCard } from '../../components/SoapOverviewCard';
// PreDraftSanityImpression was RETIRED 2026-06-25 (Ryan, item #68): the pre-draft AI Sanity Check card
// was a separate skeptical Opus call that re-derived the theory and produced a misleading wrong-theory
// note (argued a strong DIRECT case as secondary). The SOAP overview already does the holistic read, so
// the card was redundant noise that contradicted it. Only the POST-draft impression line remains.
import { PostDraftSanityImpression } from '../../components/SanityImpressionLine';
import { useChartReadiness, type UseChartReadiness } from '../../hooks/useChartReadiness';
import { formatRelativeTime } from '../../lib/date';
import { formatFileSize, formatPageCount } from '../../lib/fileMeta';
import { documentDisplayName } from '../../lib/docName';
import { formatDateOnly, formatPhone, formatNameLastFirst, formatPhysicianLastName } from '../../lib/format';
import {
  archiveCase, deleteCase, getCase, listDraftJobs, patchCase, restoreCase, returnCaseToPhysician, transitionCaseStatus,
  reviseLetter, publishCorrection,
  type CaseDetail, type PatchCaseInput, type TransitionInput,
} from '../../api/cases';
import type { CaseStatus, Role } from '../../types/prisma';

// Phase 8.1 G2: extracted as a pure function so the polling decision is unit-testable
// without fighting React Query + fake timers in component tests.
export function decidePollIntervalMs(status: CaseStatus | undefined): number | false {
  if (status === 'records' || status === 'viability' || status === 'drafting') return 8000;
  // Poll while PARKED at a Gate-2 halt so the open page stays truthful: it picks up the halt payload,
  // a resume that flips the case back to 'drafting' (from this or another tab/device), or any status
  // change — instead of going dead and stranding the RN on a stale halt panel. Visible-tab-only
  // (refetchIntervalInBackground=false), so a walked-away RN burns nothing. (Gate-2 architect QA 🔴#1.)
  if (status === 'needs_rn_decision' || status === 'needs_records') return 15000;
  return false;
}

// Activity (never-built placeholder) + Corrections (backing table is never written) removed to
// declutter (Ryan 2026-06-06). Clarifications tab removed too (UI sweep P2b, Ryan item 12) — the
// panel/route/api client all stay (backend `clarifications` route is still mounted), only the tab +
// its mount are gone from this page.
// The case is a claim ON a veteran, so the case page also surfaces the veteran's clinical chart
// (SC Conditions / Active Problems / Medications / Staff Notes) — the SAME add/edit/delete panels
// the veteran chart uses, operating on the same veteran data via the same API. The vet-scoped tail
// (Documents + the clinical sections) is sourced from the shared SHARED_TABS list so the claim page and
// the veteran chart can't drift; the claim page prepends Overview + its claim-scoped tabs.
// Order is Ryan-specified: Action, Summary, Ask Aegis, Draft jobs, Staff Notes, Email, Messages, then
// the shared tail (Documents, SC Conditions, Active Problems, Medications), Decisions last.
// Ask Aegis (advisory Q&A) and Decisions & overrides used to render as ALWAYS-ON page sections
// below the tab card, so they appeared on every tab (Ryan 2026-06-12: "everywhere, in every tab").
// They are now their OWN tabs inside the switch. Doctor Pack was removed from this page entirely — it
// auto-generates when the case is sent to the physician and lives on the physician review page.
//
// CASE-PAGE RESTRUCTURE (Ryan 2026-06-20): the old single "Overview" tab is split into two:
//   • ACTION (renamed from Overview) — the OPERATIONAL view: assignments, draft jobs, chart-extraction
//     status, the verdict/next-action, delivery. The drafter/review panel set + the abridged-docs card
//     live here, unchanged (same gates).
//   • SUMMARY (new) — a clean CLINICAL read: the AI SOAP note at the TOP, then framing + opinion + cost,
//     then "Pertinent service-connected problems" (the granted-SC conditions) and "Other pertinent
//     medical history" (active problems NOT service-connected). No actions — a calm narrative surface.
type TabId = 'action' | 'summary' | 'advisory' | 'drafts' | 'notes' | 'emails' | 'messages' | SharedTabId | 'decisions';
const TABS: readonly TabItem<TabId>[] = [
  { id: 'action', label: 'Action' },
  { id: 'summary', label: 'Summary' },
  { id: 'advisory', label: 'Ask Aegis' },
  { id: 'drafts', label: 'Draft jobs' },
  NOTES_TAB,
  { id: 'emails', label: 'Email' },
  { id: 'messages', label: 'Messages' },
  ...SHARED_TABS,
  { id: 'decisions', label: 'Decisions' },
];

function serverErrorMessage(err: unknown): string | undefined {
  return (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message;
}

export function CaseDetailPage() {
  const { id } = useParams();
  const caseId = id ?? '';
  const navigate = useNavigate();
  const { user } = useAuth();
  const role: Role = user?.role ?? 'ops_staff';
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabId>('action');
  const [pendingTo, setPendingTo] = useState<CaseStatus | null>(null);
  const [signOffOpen, setSignOffOpen] = useState(false);
  const [redraftGate1Open, setRedraftGate1Open] = useState(false); // Gate-1 checklist before a redraft

  // Phase 8.1 G2 (Ryan's RN-self-service audit): poll the main case query every 8s while
  // the case is in pre-draft states so Textract OCR callbacks (FileReadStatus flips to
  // manual_summary_required) and DraftJob state changes surface without manual refresh.
  // refetchIntervalInBackground=false so hidden tabs don't burn API.
  const caseQuery = useQuery({
    queryKey: ['case', caseId],
    queryFn: () => getCase(caseId),
    enabled: caseId.length > 0,
    refetchInterval: (query) => decidePollIntervalMs(query.state.data?.data?.status),
    refetchIntervalInBackground: false,
  });
  // Queue-position concurrency for the in-flight panel. Seeded from the POST /draft 201 (written into
  // this cache by the redraft / Send-to-Drafter mutations) and refreshed via GET /draft-concurrency on
  // the SAME visible-tab poll the case page already runs — no new poll loop. Enabled only while a draft
  // is queued/running (status 'drafting'); idle otherwise so it costs nothing post-draft.
  const draftActive = caseQuery.data?.data?.status === 'drafting';
  const concurrencyQuery = useQuery({
    queryKey: ['case', caseId, 'draft-concurrency'],
    queryFn: () => getDraftConcurrency(caseId),
    enabled: caseId.length > 0 && draftActive,
    refetchInterval: draftActive ? 8000 : false,
    refetchIntervalInBackground: false,
  });
  const liveConcurrency = concurrencyQuery.data?.data.concurrency ?? null;

  // Phase 2 readiness lift (2026-06-16): the PAGE owns the chart-readiness query (the guaranteed
  // always-mounted observer) so the 8s build-poll survives SendToDrafterPanel unmounting when a draft
  // goes in-flight. Enabled across the staff working window; idle on terminal statuses. The standalone
  // Argument + viability sections read `ready`/`completeness` from here; SendToDrafterPanel calls the
  // SAME hook (RQ dedupes → one fetch) for its gating + auto-resume.
  const readinessStatus = caseQuery.data?.data?.status;
  const chartReadiness = useChartReadiness(caseId, {
    enabled: readinessStatus !== undefined && CHART_WORKING_STATUSES.includes(readinessStatus),
  });

  const refetch = () => qc.invalidateQueries({ queryKey: ['case', caseId] });

  const patch = useMutation({
    mutationFn: (input: PatchCaseInput) => patchCase(caseId, input),
    onSuccess: () => refetch(),
    onError: async (err) => { if (err instanceof ConflictError) { await refetch(); window.alert('This case was modified elsewhere. Reloaded the latest version — please retry your edit.'); } },
  });

  // (Retired 2026-06-21: the overwritable case scratchpad state/mutation lived here. Quick notes are
  // now persistent chart-notes-stream entries; the header surfaces the latest via LatestQuickNoteLine,
  // and new ones are added from the chart Staff Notes panel.)

  const del = useMutation({
    mutationFn: () => deleteCase(caseId),
    onSuccess: () => refetch(),
    // Audit 2026-06-07: a failed soft-delete used to no-op silently — the admin believed the case was
    // rejected when nothing happened. Surface the real reason (reload on a version conflict).
    onError: async (err: unknown) => {
      if (err instanceof ConflictError) {
        await refetch();
        window.alert('This case was modified elsewhere — reloaded the latest version. Please retry.');
      } else {
        window.alert(`Could not reject the case — ${err instanceof Error ? err.message : 'please retry.'}`);
      }
    },
  });

  // Archive (soft-delete, reversible) — RN/admin (C6 lifecycle, 2026-06-13). Distinct from Reject:
  // Archive hides a mis-filed/duplicate claim from the active list (kept + restorable), it does NOT
  // mark the claim rejected. Wired to DELETE /cases/:id (sets archivedAt). After archiving the claim
  // drops out of the active Cases list; this detail page is still reachable and shows Reopen.
  const archive = useMutation({
    mutationFn: () => archiveCase(caseId),
    onSuccess: () => refetch(),
    onError: (e: unknown) => window.alert(`Could not archive this claim — ${describeApiError(e)}.`),
  });
  // Reopen (un-archive) — clears archivedAt via POST /cases/:id/restore. Shown only on an archived
  // claim. The claim returns to the active list at whatever status it held (status is untouched).
  const reopen = useMutation({
    mutationFn: () => restoreCase(caseId),
    onSuccess: () => refetch(),
    onError: (e: unknown) => window.alert(`Could not reopen this claim — ${describeApiError(e)}.`),
  });

  // Redraft (re-run the drafter). RATIFIED LIFECYCLE (Ryan 2026-06-12): redraft LOCKS when the
  // RN sends the case to the doctor — ops_staff can redraft post-draft (rn_review,
  // correction_review, a held 'drafting') but NOT in physician_review; the doctor's "Send back
  // to RN" reopens it. Admin keeps the affordance everywhere. This REVERSES the 2026-06-04
  // "lost the ability to redraft" decision that deliberately allowed re-running a
  // physician_review letter. The backend enforces the same rule on POST /draft with
  // 409 {reason:'locked_physician_review'} (same envelope as the letter editor's RN lock), so a
  // stale tab can't slip past canRedraft below.
  const redraft = useMutation({
    mutationFn: (guidance?: string) => postDraft(caseId, guidance ? { strategyOverride: guidance } : {}),
    onSuccess: async (res) => {
      // Seed the queue-position panel from the 201's concurrency block so the RN sees their place in
      // line immediately, before the first GET /draft-concurrency poll lands.
      const concurrency = res.data.concurrency ?? null;
      qc.setQueryData<{ data: DraftConcurrencyResult }>(['case', caseId, 'draft-concurrency'], { data: { concurrency } });
      await Promise.all([refetch(), qc.invalidateQueries({ queryKey: ['case', caseId, 'draft-jobs'] })]);
    },
    // Surface the REAL reason (status + server message), never a canned guess — the redraft
    // endpoint's HttpErrors aren't logged server-side, so this alert is the only place the reason
    // appears. The G1 redraft lock (locked_physician_review) gets its own precise message — it
    // can reach here on a stale tab where canRedraft still showed the button. A generic 409
    // honestly covers both "already in flight" and "chart not ready yet" (we don't claim a
    // specific one). Everything else shows the server's own message. (Ryan: error-proof.)
    onError: (e: unknown) => {
      const reason = e instanceof ConflictError ? (e.current as { reason?: string } | undefined)?.reason : undefined;
      window.alert(
        reason === 'locked_physician_review'
          ? 'Redraft is locked while the case is with the doctor. It reopens if the doctor sends the case back to the RN.'
          : e instanceof ConflictError
            ? 'Cannot redraft right now — a drafter run may already be in flight, or the chart is not ready yet. Reload the case and check its status.'
            : `Could not start a redraft — ${describeApiError(e)}. Please retry or flag to Dr. Ryan.`,
      );
    },
  });

  // Cancel an in-flight draft (stops the ~$15 spend). (Ryan 2026-06-05.)
  const cancelDraft = useMutation({
    mutationFn: (jobId: string) => cancelDraftJob(caseId, jobId),
    onSuccess: async () => { await Promise.all([refetch(), qc.invalidateQueries({ queryKey: ['case', caseId, 'draft-jobs'] })]); },
    onError: (e: unknown) => window.alert(`Could not cancel — ${describeApiError(e)}`),
  });

  // Send to doctor for review: <current status> -> physician_review. Completed drafts no longer auto-route
  // to the doctor — the RN reviews/edits, then explicitly sends. (Ryan 2026-06-04.) The send now
  // always opens SendToDoctorModal for an optional handoff message (Ryan 2026-06-24). `from` reads the
  // LIVE status (2026-07-01) so this one mutation serves BOTH the rn_review send (identical to the old
  // hardcoded 'rn_review') and the correction-round send (correction_requested/correction_review ->
  // physician_review) — the corrected letter's forward door.
  const [sendToDoctorOpen, setSendToDoctorOpen] = useState(false);
  const sendToDoctor = useMutation({
    mutationFn: () => {
      const cur = caseQuery.data?.data;
      if (!cur) throw new Error('Case not loaded');
      return transitionCaseStatus(caseId, { from: cur.status, to: 'physician_review', version: cur.version });
    },
    onSuccess: async () => { await Promise.all([refetch(), qc.invalidateQueries({ queryKey: ['case', caseId, 'draft-jobs'] })]); },
    // Errors are surfaced by SendToDoctorModal (which awaits mutateAsync) — no window.alert here, or
    // the user would get a double error (modal banner + alert).
  });

  // Return to physician (Item 1, 2026-06-28): the RN catches an error on a FINALIZED (Ready for delivery)
  // letter and sends it BACK to the assigned physician's review queue with a MANDATORY explanation. The
  // dedicated route writes the delivered->physician_review flip + the case message atomically. Errors are
  // surfaced by ReturnToPhysicianModal (which awaits mutateAsync) — no window.alert here.
  const [returnToPhysicianOpen, setReturnToPhysicianOpen] = useState(false);
  const returnToPhysician = useMutation({
    mutationFn: (message: string) => {
      const cur = caseQuery.data?.data;
      if (!cur) throw new Error('Case not loaded');
      return returnCaseToPhysician(caseId, { version: cur.version, message });
    },
    onSuccess: async () => {
      await Promise.all([
        refetch(),
        qc.invalidateQueries({ queryKey: ['case', caseId, 'draft-jobs'] }),
        qc.invalidateQueries({ queryKey: ['case-messages', caseId] }),
      ]);
    },
  });

  // "Revise letter" (Ryan 2026-07-03): reopen a delivered/paid letter into the RN-editable correction state
  // for a surgical edit (mandatory note). Unlike return-to-physician (which lands in physician_review where
  // the RN is locked out), this lands in correction_requested so the RN can edit + then send to the doctor.
  const [reviseLetterOpen, setReviseLetterOpen] = useState(false);
  const reviseLetterMut = useMutation({
    mutationFn: (message: string) => {
      const cur = caseQuery.data?.data;
      if (!cur) throw new Error('Case not loaded');
      return reviseLetter(caseId, { version: cur.version, message });
    },
    onSuccess: async () => {
      await Promise.all([
        refetch(),
        qc.invalidateQueries({ queryKey: ['case', caseId, 'draft-jobs'] }),
        qc.invalidateQueries({ queryKey: ['case-messages', caseId] }),
      ]);
    },
  });

  // "Publish corrected letter" (Ryan 2026-07-03): after a correction is re-signed, re-issue the customer's
  // secure download link to the corrected version (expires the stale one, emails a fresh link). No re-charge.
  // Idempotent-safe: if the customer already has the current version the backend returns 'already_current'.
  const publishCorrectionMut = useMutation({
    mutationFn: () => publishCorrection(caseId),
    onSuccess: async (res) => {
      await Promise.all([refetch(), qc.invalidateQueries({ queryKey: ['case', caseId, 'delivery'] })]);
      const s = res.data.status;
      if (s === 'already_current') {
        window.alert('The customer already has the current version of this letter — nothing to publish.');
      } else if (s === 'reissued_email_pending') {
        window.alert('The corrected letter was published (a new secure download link was created), but the notification email did not send. It can be re-sent.');
      } else {
        window.alert('Corrected letter published — the customer has been emailed a new secure download link to the updated letter, and the old link no longer works.');
      }
    },
    onError: (e: unknown) => window.alert(`Could not publish the corrected letter — ${describeApiError(e)}.`),
  });

  // Import final letter (2026-06-14): drop an already-finished letter PDF (rig-origin draft or
  // externally-signed) onto the case so it lands in the RN review queue and flows RN -> physician
  // -> delivery. No re-render — exact PDF bytes preserved. The hidden file input is triggered by
  // the header button; on pick we presign -> PUT -> commit, then invalidate the case so the page
  // reflects rn_review + the new letter.
  const importFileRef = useRef<HTMLInputElement | null>(null);
  const importLetter = useMutation({
    mutationFn: (file: File) => uploadAndImportLetter(caseId, file),
    onSuccess: async () => {
      await Promise.all([refetch(), qc.invalidateQueries({ queryKey: ['case', caseId, 'draft-jobs'] })]);
    },
    onError: (e: unknown) => window.alert(`Could not import the letter — ${describeApiError(e)}. Please retry or flag to Dr. Ryan.`),
  });

  if (caseQuery.isLoading) return <AppShell><div className="text-sm text-slate-500">Loading case…</div></AppShell>;
  if (!caseQuery.data) return <AppShell><EmptyState title="Case not found" message="The requested case could not be loaded." /></AppShell>;
  const c = caseQuery.data.data;
  // Only offer transitions a human should actually DRIVE from the header. Everything else here is either a
  // bare status flip (no real action) or a machine-only state, so it's redundant/misleading (Ryan 2026-06-08):
  //   - physician_review: the RN-review panel's "Send to doctor for review" is the SINGLE correct path, and
  //     it requires a completed draft — a bare header button is meaningless (esp. with no draft).
  //   - drafting: a bare flip; Redraft / Send to Drafter / the Gate-2 resume are the real paths.
  //   - needs_records / needs_rn_decision: machine-only — the drafter's Gate-2 /halt parks the case there.
  //     A human flags a records gap with an "Awaiting records" note, not a status move.
  //   - records / viability: VESTIGIAL pre-draft stepping. "Send to Drafter" sets the case straight to
  //     'drafting' from ANY prior status (drafter.ts: case.update status:'drafting'), so the manual
  //     intake->records->viability advance is bypassed — the only real pre-draft actions are Send to
  //     Drafter / Reject / Archive. "Move to records" was just confusing clutter (Ryan 2026-06-14: "what
  //     does this even mean?"). Records is tracked by the "Awaiting records" note, not a status flip.
  //   - rn_review: a DRAFTING case auto-moves to rn_review when the draft /complete fires; manually
  //     flipping it mid-draft is harmful, not helpful, and "Move to rn review" on a drafting case just
  //     looks wrong (Ryan 2026-06-14: "looks shitty, remove"). A completed/stuck draft is handled by the
  //     OpsHeld panel + auto-rerun; the physician's "send back to RN" is its own path on the review page.
  const HUMAN_MOVE_DENYLIST: readonly CaseStatus[] = ['physician_review', 'drafting', 'records', 'viability', 'rn_review', 'needs_records', 'needs_rn_decision'];
  const nextStatuses = allowedNextStatusesForRole(role, c.status).filter((to) => !HUMAN_MOVE_DENYLIST.includes(to));
  // Archive / Reopen lifecycle (C6 lifecycle, 2026-06-13). RN + admin only. An archived claim shows
  // ONLY Reopen (the workflow buttons are suppressed — there's nothing to drive while it's archived);
  // a live claim shows the Archive button alongside its workflow actions.
  const isArchived = c.archivedAt != null;
  const canArchiveOrReopen = role === 'admin' || role === 'ops_staff';
  // CDS retired from the workflow (Ryan 2026-06-03): it no longer gates sign-off. A stale
  // cdsVerdict='reject' must NOT hide the sign-off button (the CDS panel is gone, so there'd be no
  // explanation and no way to recover — an RN/physician dead-end). (architect MF-2)
  const canShowSignOff =
    c.status === 'physician_review' && (role === 'admin' || role === 'physician');
  const draftInFlight = (c.draftJobs?.[0] as InFlightDraftJob | undefined)?.state === 'queued'
    || (c.draftJobs?.[0] as InFlightDraftJob | undefined)?.state === 'running';
  // G1 redraft lock: ops_staff loses the Redraft affordance while the case sits in the doctor's
  // queue (physician_review). Admin keeps it everywhere. See the redraft mutation comment above.
  const canRedraft = (role === 'admin' || (role === 'ops_staff' && c.status !== 'physician_review'))
    && (c.draftJobs ?? []).length > 0 && !draftInFlight;

  // Import final letter (2026-06-14): admin/ops_staff can drop a finished PDF onto the case at any
  // point before it's with the doctor or already delivered. Hidden while a draft is in flight (the
  // import would collide with the running attempt) and while archived. NOT physician (they don't
  // import) and NOT during physician_review/delivered/paid (the letter is past RN's hands).
  const canImportLetter = (role === 'admin' || role === 'ops_staff')
    && !draftInFlight
    && c.status !== 'physician_review' && c.status !== 'delivered' && c.status !== 'paid';

  // The newest draft-job whose letter can ACTUALLY be opened — the single signal that gates every
  // letter affordance (View PDF / Open editor / Send to doctor / RN editor-entry / Delivery verify).
  // A letter is viewable only when a real, RESOLVABLE artifact exists (a present .pdf key OR
  // currentVersion >= 1 — what GET /cases/:id/letter can serve). A PRE-DRAFT halt (Gate-2 dx hold)
  // leaves currentVersion=0 with null keys → NOT viewable, so the panel never advertises letter
  // actions that 404 (CLM-A158C00C07, Michael Dick). Logic lives in resolveViewableLetterJob (pure +
  // unit-tested); the OLD inline `state==='done'||'failed'` fallback was the false-affordance bug.
  const viewableLetterJob = resolveViewableLetterJob(c.draftJobs, c.currentVersion) as InFlightDraftJob | undefined;

  // SOAP-note placement (Ryan 2026-06-21): the SOAP card lives on the ACTION tab while the case is pre-draft /
  // in-review (the RN's go/no-go read BEFORE drafting), and MOVES to the SUMMARY tab once a completed draft /
  // letter exists (the clinical narrative becomes a reference record, not the next-action surface). Completed
  // draft = any 'done' draft job OR a viewable letter on file (covers imported finals). Threaded into both tab
  // renders so the card shows in exactly one place; defined AFTER viewableLetterJob (avoids a TDZ reference).
  const hasCompletedDraft = (c.draftJobs ?? []).some((job) => job.state === 'done') || !!viewableLetterJob;

  async function openLetterPdf() {
    if (!viewableLetterJob) return;
    try {
      // Read the PDF from the SAME source the DOCX uses — GET /cases/:id/letter (resolveCurrent at
      // currentVersion) — so the physician's PDF and DOCX are ALWAYS the same version. The old
      // getArtifactPdfUrl was job-pinned (viewableLetterJob.version) and could open an OLD version's
      // PDF while the editor showed currentVersion → a physician could sign a version they never saw.
      const { data } = await getLetter(c.id);
      if (!data.rendered.pdfUrl) { window.alert('The letter PDF is not ready yet. If it persists, flag this case to Dr. Ryan.'); return; }
      window.open(data.rendered.pdfUrl, '_blank', 'noopener,noreferrer');
    } catch (e: unknown) {
      // Surface the server's REAL reason (e.g. the structured 404 "Letter artifact missing from
      // storage for v<N>…") — the bare generic here was one of the CLM-BBFCB3F8CE dead-ends.
      window.alert(`Could not open the letter PDF — ${describeApiError(e)}. If it keeps failing, flag this case to Dr. Ryan.`);
    }
  }

  return <AppShell><div className="space-y-6">
    {/* Archived banner (C6 lifecycle, 2026-06-13): an archived claim is reachable by direct link but
        hidden from the active list — make that obvious, and offer Reopen inline for RN/admin. */}
    {isArchived ? (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-300 bg-slate-100 px-5 py-3 text-sm text-slate-700">
        <span><span className="font-semibold">Archived</span> — this claim is hidden from the active Cases list (it lives under the Closed tab). It is kept and can be reopened.</span>
        {canArchiveOrReopen ? (
          <Button variant="secondary" size="sm" loading={reopen.isPending} disabled={reopen.isPending}
            onClick={() => { if (window.confirm('Reopen this claim? It returns to the active Cases list at its current status.')) reopen.mutate(); }}
          >Reopen</Button>
        ) : null}
      </div>
    ) : null}
    {c.status === 'delivered' || c.status === 'paid' ? (
      <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-5 py-3 text-sm font-semibold text-emerald-900">
        ✓ Physician signed off — letter finalized{c.status === 'paid' ? ' and paid' : ' and ready for delivery'}.
      </div>
    ) : null}
    {/* LAST-RESORT recovery banner (document auto-recovery loop, ADDITION B, 2026-06-14): ONE obvious
        spot, pinned in the persistent header area so it shows on EVERY tab — when auto-recovery is
        exhausted (a record still can't be read, no override), the staff member gets a plain directive +
        actions, never an invisible dead-end on a non-Overview tab. Staff-only (physicians don't drive
        the draft door); the component self-hides unless the genuine blocking state holds. */}
    {role === 'admin' || role === 'ops_staff' ? (
      <ChartRecoveryBanner caseId={caseId} status={c.status} canDraft={!!c.assignedPhysician && !!c.assignedRn} />
    ) : null}
    <div className="rounded-2xl border border-aegis bg-ivory px-6 py-5 shadow-aegis-panel">
      <div className="flex flex-col justify-between gap-4 lg:flex-row">
        <div>
          {/* The veteran name links to that veteran's main chart (/veterans/:id, id = the MRN /
              c.veteranId — same route as the "chart" link below). Underline-on-hover keeps it
              clearly clickable without shouting. (Ryan 2026-06-08.) */}
          <h1 className="text-2xl font-semibold tracking-tight text-navyDeep">
            <Link to={`/veterans/${encodeURIComponent(c.veteranId)}`} className="rounded decoration-2 underline-offset-4 hover:text-navy hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-navy" title="Open this veteran's chart">
              {formatNameLastFirst(c.veteran?.firstName, c.veteran?.lastName, c.veteranId)}
            </Link>
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-base text-slate-700"><EditableClaimCondition c={c} onSave={(v) => patch.mutate({ version: c.version, claimedCondition: v })} /><CaseStatusBadge status={c.status} /></div>
          {(() => {
            const v = c.veteran;
            const age = v?.dob ? Math.floor((Date.now() - Date.parse(v.dob)) / 31557600000) : null;
            const ht = v?.heightIn != null ? `${Math.floor(v.heightIn / 12)}'${v.heightIn % 12}"` : null;
            const htwt = [ht, v?.weightLb != null ? `${v.weightLb} lb` : null].filter(Boolean).join(' ');
            const svc = [v?.branch, v?.serviceStartYear ? `${v.serviceStartYear}–${v.serviceEndYear ?? ''}` : null].filter(Boolean).join(' ');
            const bits = [
              v?.dob ? `DOB ${formatDateOnly(v.dob)}${age != null ? ` (age ${age})` : ''}` : null,
              svc || null,
              htwt || null,
              v?.phone ? formatPhone(v.phone) : null,
              v?.address || null,
            ].filter(Boolean);
            // Email leads the line, hyperlinked to a Gmail compose window (Ryan 2026-06-13, David
            // Porter: "put his email at the top, hyperlinked so Gmail opens"). Staff are on Workspace
            // Gmail, so the compose-URL is the right target (mailto would open a random local client).
            // authuser pins the compose to the FRN team inbox (info@) instead of Gmail's /u/0 default
            // (whichever Google account was logged in first in the browser — Ryan 2026-06-14: "I cannot
            // tell what account I am on"). su prefills a subject so the compose isn't blank; the full
            // §VII/payment-link body is Email Chunk E.
            const emailLink = v?.email ? (
              <a
                href={`https://mail.google.com/mail/?view=cm&fs=1&authuser=${encodeURIComponent('info@flatratenexus.com')}&to=${encodeURIComponent(v.email)}&su=${encodeURIComponent(`Flat Rate Nexus — your nexus letter case${c.veteran?.firstName ? ` (${c.veteran.firstName})` : ''}`)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-navy hover:underline"
                title="Compose an email to this veteran from info@flatratenexus.com in Gmail"
              >
                {v.email}
              </a>
            ) : null;
            return emailLink || bits.length ? (
              <>
                <p className="mt-2 text-sm text-steel">
                  {emailLink}
                  {emailLink && bits.length ? '  ·  ' : ''}
                  {bits.join('  ·  ')}
                </p>
                {/* Gmail's compact compose hides the From row (no URL param controls it), so name the
                    sending account here — the link is pinned to info@ via authuser (Ryan 2026-06-16:
                    "I cannot even see what account this is sending from"). */}
                {emailLink ? (
                  <p className="mt-0.5 text-xs italic text-steel">Opens a Gmail compose sending from info@flatratenexus.com</p>
                ) : null}
              </>
            ) : null;
          })()}
          {/* Latest QUICK NOTE in the customer heading (Dr. Kasky 2026-06-24, restored): it sits BELOW
              the email/DOB/phone line and ABOVE the "Case CLM-… · chart · updated" line. The latest
              PERSISTENT quick note (chart-notes stream) is viewable AND addable/editable right here;
              older quick notes stay in the Staff Notes tab as history. */}
          <div className="mt-2">
            <LatestQuickNoteLine veteranId={c.veteranId} />
          </div>
          <p className="mt-1 text-xs text-harbor">Case {c.id} · {c.claimType} · <Link className="text-navy" to={`/veterans/${encodeURIComponent(c.veteranId)}`}>chart</Link> · updated {formatRelativeTime(c.updatedAt)} · row v{c.version}</p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {isArchived ? (
            // Archived claim: the only meaningful action is Reopen (un-archive). Workflow buttons are
            // hidden — there's nothing to drive while the claim is out of the active list.
            canArchiveOrReopen ? (
              <Button variant="primary" size="sm" loading={reopen.isPending} disabled={reopen.isPending}
                onClick={() => { if (window.confirm('Reopen this claim? It returns to the active Cases list at its current status.')) reopen.mutate(); }}
              >Reopen claim</Button>
            ) : null
          ) : (
            <>
              {/* View letter only when the review panel (which has its own "Open PDF") isn't showing —
                  no duplicate view button (Ryan 2026-06-05). */}
              {viewableLetterJob && c.status !== 'rn_review' && c.status !== 'physician_review' ? <Button variant="secondary" size="sm" onClick={openLetterPdf}>View letter</Button> : null}
              {/* Return to physician (Item 1; widened 2026-06-28): on a FINALIZED letter, send it back to the
                  doctor's review queue with a mandatory note — the recovery path when an error is caught after
                  signing. From 'delivered' (Ready-for-delivery / Invoiced) → admin/ops/physician; from 'paid'
                  (billed/closed) → admin/physician ONLY (an RN can't reopen a paid case). The billing warning
                  for an invoiced/paid letter lives in the modal. */}
              {((c.status === 'delivered' && (role === 'admin' || role === 'ops_staff' || role === 'physician'))
                || (c.status === 'paid' && (role === 'admin' || role === 'physician'))) ? (
                <Button variant="secondary" size="sm" onClick={() => setReturnToPhysicianOpen(true)}>Return to physician</Button>
              ) : null}
              {/* Revise letter (Ryan 2026-07-03): reopen a delivered/paid letter for a SURGICAL edit instead
                  of a redraft — it lands in the RN-editable correction state (mandatory note, no re-charge,
                  physician re-signs). RN-ONLY: only ops_staff gets the follow-through editor+send-to-doctor
                  card (canShowRnEditorEntry), so offering this to admin/physician would strand them in a
                  correction state they can't drive. Admin/physician use "Return to physician" instead
                  (physician_review, which they CAN edit directly). */}
              {((c.status === 'delivered' || c.status === 'paid') && role === 'ops_staff') ? (
                <Button variant="secondary" size="sm" onClick={() => setReviseLetterOpen(true)}>Revise letter</Button>
              ) : null}
              {/* Publish corrected letter (Ryan 2026-07-03): re-issue the customer's secure download to the
                  corrected, re-signed version. Shown once a letter has been PAID-delivered (a token was minted);
                  idempotent-safe (no-op if the customer already has the current version). */}
              {((c.status === 'delivered' || c.status === 'paid') && (role === 'admin' || role === 'ops_staff')
                && (c.payments ?? []).some((p) => (p.kind === 'letter_500' || p.kind === 'letter_350') && p.status === 'paid')) ? (
                <Button variant="secondary" size="sm" loading={publishCorrectionMut.isPending} disabled={publishCorrectionMut.isPending}
                  onClick={() => { if (window.confirm('Publish the corrected letter to the customer? This re-issues their secure download link to the current signed version, disables the old link, and emails them. No re-charge.')) publishCorrectionMut.mutate(); }}
                >Publish corrected letter</Button>
              ) : null}
              {canRedraft ? <Button variant="secondary" size="sm" loading={redraft.isPending} disabled={redraft.isPending} onClick={() => setRedraftGate1Open(true)}>Redraft</Button> : null}
              {canImportLetter ? (
                <>
                  {/* Hidden picker for "Import final letter" — preserves exact PDF bytes (no re-render). */}
                  <input
                    ref={importFileRef}
                    type="file"
                    accept="application/pdf"
                    className="hidden"
                    aria-label="Import final letter PDF"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (file) importLetter.mutate(file);
                    }}
                  />
                  <Button variant="secondary" size="sm" loading={importLetter.isPending} disabled={importLetter.isPending} onClick={() => importFileRef.current?.click()}>Import final letter</Button>
                </>
              ) : null}
              {canShowSignOff ? <Button variant="primary" size="sm" onClick={() => setSignOffOpen(true)}>Sign off</Button> : null}
              {nextStatuses.map((to) => <Button key={to} variant="secondary" size="sm" onClick={() => setPendingTo(to)}>{to === 'rejected' ? 'Reject claim' : `Move to ${CASE_STATUS_LABELS[to].toLowerCase()}`}</Button>)}
              {/* Archive (RN/admin): soft-delete a mis-filed/duplicate claim. Reversible via Reopen.
                  Distinct from "Reject claim" (a status move that keeps the claim, marked rejected). */}
              {canArchiveOrReopen ? <Button variant="secondary" size="sm" loading={archive.isPending} disabled={archive.isPending}
                onClick={() => { if (window.confirm(`Archive this claim? It's hidden from the active Cases list but kept and can be Reopened from the Closed tab.`)) archive.mutate(); }}
              >Archive</Button> : null}
              {role === 'admin' ? <Button variant="destructive" size="sm" onClick={() => { if (window.confirm('Reject and soft-delete this case? It will be marked rejected.')) del.mutate(); }} loading={del.isPending}>Reject + soft delete</Button> : null}
            </>
          )}
        </div>
      </div>
    </div>

    {/* Return-to-physician modal (Item 1): mandatory-message handoff back to the doctor for a finalized
        letter. The transition + message are written atomically by the dedicated route. */}
    <ReturnToPhysicianModal
      open={returnToPhysicianOpen}
      onClose={() => setReturnToPhysicianOpen(false)}
      // Billing-safety warning inputs (2026-06-28): returning an already-billed letter does NOT cancel the
      // invoice or refund the payment. isPaid = the case is 'paid' (closed). isInvoiced = an invoice email
      // was sent (a letter_500 Payment row sits at status='invoiced'); derived from the detail payments list.
      isPaid={c.status === 'paid'}
      isInvoiced={(c.payments ?? []).some((p) => p.kind === 'letter_500' && p.status === 'invoiced')}
      onSubmit={async (message) => { await returnToPhysician.mutateAsync(message); }}
    />

    {/* Revise-letter modal (Ryan 2026-07-03): reopen a delivered/paid letter for a surgical edit with a
        mandatory note. The dedicated route moves it to the RN-editable correction state (no re-draft). */}
    <ReviseLetterModal
      open={reviseLetterOpen}
      onClose={() => setReviseLetterOpen(false)}
      isPaid={c.status === 'paid'}
      isInvoiced={(c.payments ?? []).some((p) => p.kind === 'letter_500' && p.status === 'invoiced')}
      onSubmit={async (message) => { await reviseLetterMut.mutateAsync(message); }}
    />

    {/* Refund signal moved INTO the chart (UI sweep P2c, Ryan item 13): Refunds left the staff nav,
        so this amber strip is where ops/admin learn a case is refund-relevant. refundEligible is set
        only via an explicit case PATCH (there is NO automatic wiring from the reject flow), so the
        banner appears only on deliberately marked cases. Physicians don't handle money, so it is
        staff-only. The /refunds page itself is admin-only by URL now — only the admin gets the
        link, ops sees the plain banner. */}
    {c.refundEligible && (role === 'admin' || role === 'ops_staff') ? (
      <div className="rounded-lg border border-amber-300 bg-amber-50 px-5 py-3 text-sm text-amber-900">
        <span className="font-semibold">Refund-eligible:</span> this case is marked refund-eligible — check before promising or processing anything.
        {role === 'admin' ? <> <Link to="/refunds" className="font-medium underline underline-offset-2 hover:text-amber-950">Open refunds</Link></> : null}
      </div>
    ) : null}

    {/* P2 case-page tab/header restructure, 2026-06-14 (Ryan, Wayne Moseley layout): the tab bar
        moves UP directly under the persistent patient header (above), and everything that used to
        render BETWEEN the header and the tab card — the abridged-notes card, the C8c drafter/review
        top-panel set, the delivery panel, and Assignments — now lives INSIDE the Overview tab. So the
        page is: [persistent patient header + banners] → [sticky tab bar] → [tab content], where
        Overview is the action+summary surface and the other tabs swap in below. The patient header,
        the archived/signed-off/refund banners, and the header action buttons stay pinned above the
        tab bar so they render IDENTICALLY on every tab. NOTHING about WHEN a panel shows changed —
        every gate/condition is byte-identical, the panels just moved into the Overview branch. */}
    <div className="rounded-2xl border border-aegis bg-ivory shadow-aegis-card">
      <TabBar tabs={TABS} active={tab} onChange={setTab} />
      <div className="p-4">
        {tab === 'action' ? (
          <div className="space-y-6">
            {/* (Latest quick note now lives in the persistent patient header above the tab bar — Ryan
                "top of chart" 2026-06-21 — so it shows on every tab and isn't duplicated here.) */}
            {/* Abridged notes and records — the curated chart abridgement (Ryan 2026-06-12, renamed
                from "Doctor Pack"). Auto-generates when the records finish parsing; the Regenerate
                button inside is RN/admin-only (physician sees view-only). Now the first card in the
                Overview tab. */}
            <DoctorPackPanel caseId={caseId} />

            {/* CDS panel retired from the workflow (Ryan 2026-06-03). Backend route is flag-guarded
                off (CDS_ENABLED); the engine code is kept. Re-add this panel if CDS is re-enabled. */}

            {/* C8c panel stability, 2026-06-14: the drafter/review panels. Previously a keyless `&&`
                cascade inside an IIFE returning a fragment — on every status/poll transition the
                region re-evaluated and, because the children were positional (keyless), a flip of one
                earlier sibling re-paired EVERY later sibling against a different fiber and React
                UNMOUNTED/remounted them (state lost, flicker, layout jump). Fix (stability only,
                behavior byte-identical):
                  (1) the gate booleans are hoisted into the pure, unit-tested resolveCaseTopPanels(...)
                      — same gates, just testable and computed once;
                  (2) the region is ONE always-mounted container (reserves the slot in the column so a
                      no-op poll can't make the whole region appear/disappear); and
                  (3) each conditional child carries a STABLE key, so reconciliation is identity-based
                      — a poll that doesn't change a panel's visibility re-renders it IN PLACE.
                The panels are intentionally NOT mutually exclusive (drafting+failed shows BOTH the
                interrupted OpsHeld panel AND Send-to-Drafter — the watcher copy says "click Send to
                Drafter again"), so each keeps its own gate; we did NOT collapse them into a single
                primary slot. (P2 restructure 2026-06-14: relocated from above the tab card into the
                Overview tab — gates unchanged.) */}
            {(() => {
              // Phase 8: physician/ops drafter panels. Derived from latest DraftJob + Case state.
              const latestDraftJob = c.draftJobs?.[0] as InFlightDraftJob | undefined;
              // Halt signals derive from the NEWEST job ONLY (deriveLatestHaltSignals) — NOT a
              // .some()/.find() over the whole history. A resumed-then-cancelled draft leaves an OLD
              // halted job + its haltPayloadJson behind; reading those over all jobs made a cancelled
              // case wrongly render the Gate-2 dx card (the resume→cancel residual bug, 2026-06-30).
              // c.draftJobs is enqueuedAt DESC (backend cases.ts) so index 0 is the newest.
              const haltSignals = deriveLatestHaltSignals(c.draftJobs as readonly DraftJobHaltShape[] | undefined);
              // The CURRENT halt is always the latest job (any newer job moved the case off the halt),
              // so the Gate-2 panel reads its `job` prop from the latest job when it is halted.
              const haltedJob = haltSignals.hasHaltedJob ? latestDraftJob : undefined;
              const p = resolveCaseTopPanels({
                status: c.status,
                role,
                latestDraftState: latestDraftJob?.state,
                hasLatestDraftJob: !!latestDraftJob,
                hasCompletedDraft: (c.draftJobs ?? []).some((job) => job.state === 'done'),
                hasHaltedJob: haltSignals.hasHaltedJob,
                // A persisted Gate-2 halt payload / 'halted' state on the NEWEST job = a REAL dx/event
                // verification halt. Newest-only (see deriveLatestHaltSignals) so a cancelled/watcher-
                // reconciled draft (needs_rn_decision + paused, latest job failed) stays OFF the dx
                // card and on the calm OpsHeld panel even when an OLDER job carried a halt payload.
                hasHaltPayload: haltSignals.hasHaltPayload,
                hasViewableLetterJob: !!viewableLetterJob,
                runComplete: c.runComplete,
                shipRecommendation: c.shipRecommendation,
                operatorState: c.operatorState,
              });

              return (
                <div className="space-y-6" data-region="case-top-panels">
                  {p.inFlightDraft && latestDraftJob ? (
                    <InFlightDrafterPanel key="inflight" job={latestDraftJob} onCancel={() => cancelDraft.mutate(latestDraftJob.id)} cancelling={cancelDraft.isPending} concurrency={liveConcurrency} />
                  ) : null}

                  {/* PHASE 3 (2026-06-16, Ryan) — the pre-draft case "story", read top-to-bottom like a
                      SOAP note: Background/argument → what we extracted → assessment → recommended plan →
                      assignments → send. Each is an INDEPENDENT, stably-keyed slot (NOT a shared fragment):
                      React renders in source order, gated-out slots collapse, so the pre-draft view reads
                      1→6 and other states degrade sensibly (Extraction + Assignments have wider gates and
                      float up when the pre-draft slots are absent). Keys ride the outermost element so a
                      poll-driven visibility flip never remounts siblings (the L525 stability discipline). */}

                  {/* SOAP-note Overview (Ryan 2026-06-21): while the case is PRE-DRAFT / in-review (no
                      completed draft yet) the SOAP read leads the ACTION tab — it's the RN's go/no-go read
                      before drafting. Once a completed draft/letter exists it MOVES to the Summary tab (it
                      becomes a reference record, not the next action). hasCompletedDraft gates the move so the
                      card is in exactly one tab at a time. */}
                  {!hasCompletedDraft ? (
                    <SoapOverviewCard
                      key="soap-overview"
                      caseId={c.id}
                      claimedCondition={c.claimedCondition}
                      veteranStatement={c.veteranStatement ?? null}
                      hasUnreadPages={chartReadiness.hasGaps || chartReadiness.blockingFiles.length > 0}
                    />
                  ) : null}

                  {/* Chart extraction (objective — "what we actually read") stays visible; it also carries
                      the reprocess/re-OCR actions. Wider gate so it shows during drafting / halt / rn_review. */}
                  {p.canSeeExtractionCoverage ? <ExtractionCoveragePanel key="extraction-coverage" caseId={caseId} /> : null}

                  {/* The dense engine panel is kept one click away as raw data + the live fallback if an
                      API call is down. Children mount even when collapsed, so the sanity cache + the
                      readiness overlay still warm. The clinical SOAP-note read now lives on the Summary tab.
                      The static M/E "Anchor viability" card (CaseViabilityCard) was REMOVED here entirely
                      (Ryan 2026-06-20, item #64). The deterministic RecommendedPlanCard verdict chip was
                      REMOVED here too (Ryan 2026-06-29) — it was a second pre-draft verdict that could
                      contradict the SOAP card; the SOAP/viability card is the single pre-draft signal.
                      StrategyPreviewCard remains as a QUIET argument/theory summary (no ✓/⚠ verdict). */}
                  {p.canSendFirstDraft ? (
                    <details key="full-analysis" className="mb-4 rounded-lg border border-slate-200 bg-white">
                      <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-medium text-slate-600 hover:text-slate-800">
                        View full analysis
                      </summary>
                      <div className="space-y-4 px-2 pb-3">
                        <StrategyPreviewCard key="strategy" caseId={caseId} chartReady={chartReadiness.ready} completeness={chartReadiness.completeness} />
                        {/* RecommendedPlanCard (deterministic verdict chip) retired from this page 2026-06-29 — redundant/contradictory second verdict; SOAP card owns the pre-draft go/no-go. */}
                        {/* PreDraftSanityImpression (the "AI Sanity Check" card) retired 2026-06-25 (Ryan #68) — redundant with the SOAP overview's holistic read; removed to stop the misleading note + the per-mount Opus call. */}
                      </div>
                    </details>
                  ) : null}

                  {/* 5. Assignments — moved INTO the story (was below the region). Staff only; floats in
                      review/halt states too (a physician must be assigned before send-to-doctor). */}
                  {role === 'admin' || role === 'ops_staff' ? (
                    <CaseAssignmentPanel key="assignments" caseId={c.id} version={c.version} assignedPhysician={c.assignedPhysician ?? null} assignedRn={c.assignedRn ?? null} />
                  ) : null}

                  {/* 6. Send to Drafter — last. */}
                  {p.canSendFirstDraft ? (
                    <SendToDrafterPanel key="send-first" caseId={caseId} claimType={c.claimType} claimedCondition={c.claimedCondition} draftAttempt={(c.currentVersion ?? 0) + 1} physicianAssigned={!!c.assignedPhysician} rnAssigned={!!c.assignedRn} />
                  ) : null}

                  {!p.inFlightDraft && p.canSeePhysicianReadyPanel && latestDraftJob ? (
                    <PhysicianLetterReadyPanel
                      key="phys-ready"
                      c={c}
                      job={latestDraftJob}
                      canSendBack={role === 'admin' || role === 'physician'}
                      onOpenPdf={openLetterPdf}
                      onEditText={() => navigate(`/cases/${encodeURIComponent(c.id)}/letter`)}
                      onOpenSignOff={() => setSignOffOpen(true)}
                      // GPT chunk 2: invalidate both queries on case-changing mutations so the
                      // panel + the draft-jobs tab both refetch.
                      onChanged={async () => {
                        await Promise.all([
                          refetch(),
                          qc.invalidateQueries({ queryKey: ['case', caseId, 'draft-jobs'] }),
                        ]);
                      }}
                    />
                  ) : null}

                  {!p.inFlightDraft && p.canSeeRnReviewPanel && latestDraftJob ? (
                    <PhysicianLetterReadyPanel
                      key="rn-review"
                      c={c}
                      job={latestDraftJob}
                      canSendBack={false}
                      onOpenPdf={openLetterPdf}
                      onEditText={() => navigate(`/cases/${encodeURIComponent(c.id)}/letter`)}
                      onSendToDoctor={() => setSendToDoctorOpen(true)}
                      sendToDoctorBlockedReason={c.assignedPhysician ? undefined : 'Assign a physician below before sending.'}
                      sending={sendToDoctor.isPending}
                      onChanged={async () => {
                        await Promise.all([refetch(), qc.invalidateQueries({ queryKey: ['case', caseId, 'draft-jobs'] })]);
                      }}
                    />
                  ) : null}

                  {/* Send-to-doctor handoff: ALWAYS offers an optional message to the reviewing
                      physician (Ryan 2026-06-24). Empty message = behaves like the old bare confirm. */}
                  <SendToDoctorModal
                    caseId={caseId}
                    open={sendToDoctorOpen}
                    onClose={() => setSendToDoctorOpen(false)}
                    onConfirm={async () => { await sendToDoctor.mutateAsync(); }}
                  />

                  {/* Post-draft sanity impression — the auto-fired Opus gut-check on the FINISHED letter,
                      a quiet "Overall impression" line beneath whichever letter-ready panel is showing. */}
                  {!p.inFlightDraft && latestDraftJob && (p.canSeePhysicianReadyPanel || p.canSeeRnReviewPanel) ? (
                    <PostDraftSanityImpression key="sanity-post" caseId={caseId} claimedCondition={c.claimedCondition} />
                  ) : null}

                  {!p.inFlightDraft && p.canSeeOpsHeldPanel ? (
                    // OpsHeldPanel.job is optional under exactOptionalPropertyTypes — spread it only
                    // when present (TS rejects passing explicit undefined to an optional prop).
                    <OpsHeldPanel
                      key="ops-held"
                      c={c}
                      {...(latestDraftJob ? { job: latestDraftJob } : {})}
                      isAdmin={role === 'admin'}
                      hasLetter={!!viewableLetterJob}
                      onViewLetter={openLetterPdf}
                      onOpenEditor={() => navigate(`/cases/${encodeURIComponent(c.id)}/letter`)}
                    />
                  ) : null}

                  {/* Gate-2 dx/event verification halt — the case is parked for the RN's decision.
                      Never a dead-end: override / switch / proceed / pause, all logged. */}
                  {p.isGate2Halt ? (
                    <Gate2HaltPanel
                      key="gate2-halt"
                      c={c}
                      {...(haltedJob ? { job: haltedJob as never } : {})}
                      onOpenEditor={() => navigate(`/cases/${encodeURIComponent(c.id)}/letter`)}
                      onChanged={async () => { await Promise.all([refetch(), qc.invalidateQueries({ queryKey: ['case', caseId, 'draft-jobs'] }), qc.invalidateQueries({ queryKey: ['case', caseId, 'draft-decisions'] })]); }}
                    />
                  ) : null}

                  {/* RN LOCK during physician review (Ryan 2026-06-11 — REVERSES the 2026-06-04
                      RN-can-edit decision after Perez: while the doctor has the case, the letter is
                      locked from RN edits, both hand-edit and surgical-AI; the backend enforces the
                      same on both routes (409 locked_physician_review). Physician + admin retain
                      their tools. */}
                  {p.isRnLockBanner ? (
                    <div key="rn-lock" className="rounded-lg border border-sky-200 bg-sky-50 px-5 py-3 text-sm text-sky-900">
                      This case is in {c.assignedPhysician ? `Dr. ${formatPhysicianLastName(c.assignedPhysician.fullName)}'s` : "the physician's"} queue. The letter is locked from edits until the doctor acts — if something needs changing, message the doctor or wait for the case to come back.
                    </div>
                  ) : null}

                  {/* RN letter-edit entry. The physician/admin reach the editor via the ready panel
                      above; an RN (ops_staff) otherwise has no entry to it. Shown when a letter
                      exists, the run is not in flight, and the status is RN-editable: drafting /
                      correction_requested / correction_review — physician_review is LOCKED for
                      ops_staff (Ryan 2026-06-11; backend mirrors this). correction_requested is the
                      doctor's "send back to RN" (decline) — the RN must be able to HAND-FIX it in the
                      full editor, not just Redraft (Dr. Kasky 2026-06-24). Editing creates a NEW
                      version; the version-safety in /draft + currentVersion pointer ensure the doctor
                      always reviews the newest version. */}
                  {/* Suppress this RN-editor-entry when OpsHeldPanel is showing — that panel already
                      carries "Open letter editor" + "Send to doctor", so rendering both produced TWO
                      "Open letter editor" buttons on one page (Ryan 2026-06-23). Keep it for the
                      no-ops-panel RN-editable states (correction_requested / correction_review). */}
                  {p.canShowRnEditorEntry && !p.canSeeOpsHeldPanel ? (
                    <div key="rn-editor-entry" className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
                      <h2 className="text-base font-semibold text-slate-900">Edit {letterFilename(c.veteran?.lastName, c.veteran?.firstName, c.claimedCondition, c.currentVersion ?? c.version)}</h2>
                      {/* The doctor's correction note (the /letter/decline reason, stored on
                          Case.operatorMessage) — surfaced so the RN sees WHAT to fix, not just that the
                          letter came back. Shown only on the send-back state with a note present. */}
                      {c.status === 'correction_requested' && typeof c.operatorMessage === 'string' && c.operatorMessage.trim().length > 0 ? (
                        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                          <div className="text-sm font-semibold text-amber-900">The doctor sent this back with a correction note</div>
                          <p className="mt-1 whitespace-pre-wrap text-sm text-amber-800">{c.operatorMessage.trim()}</p>
                        </div>
                      ) : null}
                      <p className="mt-2 text-sm text-slate-600">
                        If a change is needed, you can revise the letter — by hand or with an AI surgical
                        edit, the same tools the physician has. Saving creates a new version, and the doctor
                        always reviews the newest version.
                      </p>
                      <div className="mt-4 flex flex-wrap gap-2">
                        {/* View letter lives in the page header — not duplicated here. */}
                        <Button variant="secondary" size="sm" onClick={() => navigate(`/cases/${encodeURIComponent(c.id)}/letter`)}>Open letter editor</Button>
                        {/* Send corrected letter to doctor (2026-07-01): the correction-round forward door.
                            Shown ONLY on the correction states (NOT 'drafting' — a pre-review edit must not
                            be sendable). Independent of whether any edit was made — "no edits" and "trivial
                            edits" both send (the transition requires no diff). Opens the same optional-message
                            SendToDoctorModal already rendered above; the status-aware sendToDoctor mutation
                            reads the live status as `from`. Disabled with an assign-physician hint when no
                            physician is assigned (a truthful caution, not a hard block — a declined case
                            always has one, so this won't actually fire). The doctor still reviews + signs off
                            via /letter/approve before delivery. */}
                        {c.status === 'correction_requested' || c.status === 'correction_review' ? (
                          <Button
                            variant="primary"
                            size="sm"
                            loading={sendToDoctor.isPending}
                            disabled={sendToDoctor.isPending || !c.assignedPhysician}
                            title={c.assignedPhysician ? undefined : 'Assign a physician below before sending.'}
                            onClick={() => setSendToDoctorOpen(true)}
                          >
                            Send corrected letter to doctor
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })()}

            {/* Post-approval RN delivery panel — invoice email + cover memo + Stripe link. Shows only
                at delivered/paid, by which point the drafting/review panels above have cleared.
                Admin/ops_staff only. (P2 restructure 2026-06-14: relocated into the Action tab —
                gate unchanged.) */}
            {(c.status === 'delivered' || c.status === 'paid') && (role === 'admin' || role === 'ops_staff') ? (
              <DeliveryPanel caseId={caseId} onVerifyLetter={openLetterPdf} hasLetterPdf={!!viewableLetterJob} />
            ) : null}

            {/* Assignments moved INTO the case-top-panels story region (slot 5, 2026-06-16). */}
            {/* The framing / opinion / cost summary fields + the clinical SC vs. medical-history read
                MOVED to the new Summary tab (Ryan 2026-06-20 restructure) — the Action tab is purely the
                operational surface. */}
          </div>
        ) : null}
        {tab === 'summary' ? (
          <SummaryTab
            c={c}
            chartReadiness={chartReadiness}
            showSoap={hasCompletedDraft}
            saving={patch.isPending}
            onSave={(field, value) => patch.mutate({ version: c.version, [field]: value })}
          />
        ) : null}
        {tab === 'advisory' ? <AdvisoryPanel caseId={caseId} alwaysOpen /> : null}
        {tab === 'drafts' ? <DraftJobsTab caseId={caseId} /> : null}
        {tab === 'documents' ? <DocumentsTab veteranId={c.veteranId} caseId={c.id} role={role} /> : null}
        {tab === 'emails' ? <EmailLogPanel queryKey={['case', caseId, 'emails']} fetcher={() => listCaseEmails(caseId)} scope="claim" caseId={caseId} /> : null}
        {tab === 'messages' ? (
          <CaseMessagesPanel
            caseId={caseId}
            caseLabel={joinCaseLabel(formatNameLastFirst(c.veteran?.firstName, c.veteran?.lastName, ''), formatConditionLabel(c.claimedCondition), caseId)}
            assignedRn={c.assignedRn ?? null}
            assignedPhysician={c.assignedPhysician ?? null}
          />
        ) : null}
        {/* Clinical chart tabs — same veteran data + same panels as the veteran chart page. The case
            carries the veteran id (c.veteranId); the clinical sections fetch the veteran detail and
            mutate it directly, so edits here and on the veteran chart are the same records. */}
        {tab === 'conditions' ? <VeteranClinicalTab veteranId={c.veteranId} section="conditions" /> : null}
        {tab === 'problems' ? <VeteranClinicalTab veteranId={c.veteranId} section="problems" /> : null}
        {tab === 'medications' ? <VeteranClinicalTab veteranId={c.veteranId} section="medications" /> : null}
        {tab === 'notes' ? <ChartNotesPanel veteranId={c.veteranId} /> : null}
        {tab === 'decisions' ? <DecisionsOverridesPanel caseId={caseId} caseVersion={c.version} /> : null}
      </div>
    </div>

    {pendingTo ? <TransitionModal caseId={caseId} from={c.status} to={pendingTo} version={c.version} onClose={() => setPendingTo(null)} onDone={async () => { setPendingTo(null); await refetch(); }} /> : null}
    <SignOffPopup caseId={caseId} open={signOffOpen} onClose={() => setSignOffOpen(false)} onSignedOff={refetch} />

    {/* "Came back for a revision" pop-up (Ryan 2026-07-03) — auto-shows for the PHYSICIAN/admin when a case
        an RN corrected has unsigned changes, so the reason + the diff are front-and-center on open. Gated to
        physician/admin: the RN who made the edit doesn't need it. Self-gates on there being real changes. */}
    {(role === 'physician' || role === 'admin') ? <ReviewChangesPopup caseId={caseId} /> : null}
    {redraftGate1Open ? (
      <Gate1ChecklistModal
        caseId={caseId}
        claimType={c.claimType}
        claimedCondition={c.claimedCondition}
        draftAttempt={(c.currentVersion ?? 0) + 1}
        onClose={() => setRedraftGate1Open(false)}
        onConfirmed={(guidance) => { setRedraftGate1Open(false); redraft.mutate(guidance); }}
      />
    ) : null}
  </div></AppShell>;
}

// The claimed condition is click-to-edit HERE on the claim's own page (Ryan 2026-06-06) — the
// veteran-chart claim row OPENS the claim instead. Saving PATCHes claimedCondition; the backend syncs
// claimedConditions[] for single-condition claims so the next drafter run uses the corrected dx.
function EditableClaimCondition({ c, onSave }: { readonly c: CaseDetail; readonly onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.claimedCondition);
  function commit() { const t = draft.trim(); if (t && t !== c.claimedCondition) onSave(t); setEditing(false); }
  if (!editing) {
    return <button type="button" className="rounded px-1 font-medium decoration-dotted hover:bg-amber-50 hover:underline" title="Click to edit the claimed condition" onClick={() => { setDraft(c.claimedCondition); setEditing(true); }}>{formatConditionLabel(c.claimedCondition)}</button>;
  }
  return (
    <span className="inline-flex items-center gap-1">
      <input className="input h-7 w-64 py-0 text-sm" value={draft} autoFocus onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }} />
      <button type="button" className="text-xs font-medium text-indigo-600" onClick={commit}>Save</button>
      <button type="button" className="text-xs text-slate-400" onClick={() => setEditing(false)}>Cancel</button>
    </span>
  );
}

type EditableField = 'framingChoice' | 'upstreamScCondition' | 'veteranStatement' | 'inServiceEvent';

// SUMMARY TAB (Ryan 2026-06-20 restructure) — a clean CLINICAL read, no actions. Top-to-bottom:
//   1. the AI-synthesized SOAP-note Overview (once strategy/chart data exists);
//   2. the framing / opinion-statement / cost summary fields (editable inline, the old Overview tail);
//   3. "Pertinent service-connected problems" — the veteran's GRANTED-SC conditions;
//   4. "Other pertinent medical history" — active problems that are NOT service-connected.
// The SC-vs-problem split reuses the SAME veteran data the chart uses (getVeteran): scConditions with
// status 'service_connected' are the SC list; activeProblems is the medical-history list. Read-only
// here (edits happen on the SC Conditions / Active Problems tabs); this surface is for reading.
function SummaryTab({ c, chartReadiness, showSoap, onSave, saving }: {
  readonly c: CaseDetail;
  readonly chartReadiness: UseChartReadiness;
  /** The SOAP card lives here only once a completed draft/letter exists; pre-draft it leads the Action tab
   *  (Ryan 2026-06-21). Gated so the card never renders in both tabs at once. */
  readonly showSoap: boolean;
  readonly onSave: (field: EditableField, value: string) => void;
  readonly saving: boolean;
}) {
  return (
    <div className="space-y-6">
      {/* 1. The AI SOAP note leads — the clinical narrative (Subjective / Objective / Assessment / Plan)
          with the deterministic verdict traffic-light + next action as the always-instant fallback. Shown
          here ONLY once a completed draft/letter exists (pre-draft it leads the Action tab). */}
      {showSoap ? (
        <SoapOverviewCard
          caseId={c.id}
          claimedCondition={c.claimedCondition}
          veteranStatement={c.veteranStatement ?? null}
          hasUnreadPages={chartReadiness.hasGaps || chartReadiness.blockingFiles.length > 0}
        />
      ) : null}

      {/* 2. Framing / opinion / cost — the case summary fields. */}
      <CaseSummaryFields c={c} saving={saving} onSave={onSave} />

      {/* 3 + 4. The clinical SC-vs-medical-history read, sourced from the shared veteran chart data. */}
      <SummaryClinicalLists veteranId={c.veteranId} />
    </div>
  );
}

function CaseSummaryFields({ c, onSave, saving }: { readonly c: CaseDetail; readonly onSave: (field: EditableField, value: string) => void; readonly saving: boolean }) {
  // Authoritative total from the backend aggregate over ALL DraftJobs (c.draftingCostUsd) — the
  // old client-side sum over the truncated take:5 c.draftJobs list missed older cost-bearing runs
  // and showed "—" (Ryan 2026-06-04). null === no recorded cost on any job → honest "—".
  const draftingCost = c.draftingCostUsd ?? null;
  return <div className="divide-y divide-aegis">
    <InlineEditRow label="Framing" value={c.framingChoice ?? ''} saving={saving} onSave={(v) => onSave('framingChoice', v)} />
    <InlineEditRow label="Upstream SC condition" value={c.upstreamScCondition ?? ''} saving={saving} onSave={(v) => onSave('upstreamScCondition', v)} />
    <InlineEditRow label="Veteran statement" value={c.veteranStatement ?? ''} multiline saving={saving} onSave={(v) => onSave('veteranStatement', v)} />
    <InlineEditRow label="In-service event" value={c.inServiceEvent ?? ''} multiline saving={saving} onSave={(v) => onSave('inServiceEvent', v)} />
    <div className="py-3">
      <div className="flex items-center justify-between gap-4">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Drafting cost (API)</span>
        <span className="text-sm font-medium text-slate-800">{draftingCost === null ? '—' : `$${draftingCost.toFixed(2)}`}</span>
      </div>
    </div>
  </div>;
}

// Read-only clinical lists for the Summary tab — pulls the SAME veteran detail the chart uses
// (['veteran', veteranId]; RQ dedupes with the clinical tabs) and splits it into the two product
// sections Ryan asked for. "Pertinent service-connected problems" = scConditions whose status is
// 'service_connected' (granted SC); "Other pertinent medical history" = the active problems list
// (conditions the veteran has that are NOT service-connected). Editing is on the dedicated tabs.
function SummaryClinicalLists({ veteranId }: { readonly veteranId: string }) {
  const veteran = useQuery({ queryKey: ['veteran', veteranId], queryFn: () => getVeteran(veteranId), enabled: veteranId.length > 0 });
  if (veteran.isLoading) return <div className="text-sm text-slate-500">Loading chart…</div>;
  const v = veteran.data?.data;
  const scConnected = (v?.scConditions ?? []).filter((r) => r.status === 'service_connected');
  const otherHistory = v?.activeProblems ?? [];
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <TabSection title="Pertinent service-connected problems">
        {scConnected.length === 0 ? (
          <EmptyState title="None recorded" message="No service-connected conditions are on this veteran's chart yet." />
        ) : (
          scConnected.map((r) => {
            const meta = [r.dcCode ? `DC ${r.dcCode}` : null, r.ratingPct != null ? `${r.ratingPct}%` : null].filter(Boolean).join(' · ');
            return <DataRow key={r.id} lead={formatConditionLabel(r.condition)} {...(meta ? { meta } : {})} trailing={<StatusChip tone="good">Service-connected</StatusChip>} />;
          })
        )}
      </TabSection>
      <TabSection title="Other pertinent medical history">
        {otherHistory.length === 0 ? (
          <EmptyState title="None recorded" message="No non-service-connected active problems are on this veteran's chart yet." />
        ) : (
          otherHistory.map((r) => <DataRow key={r.id} lead={formatConditionLabel(r.problem)} {...(r.notes ? { meta: r.notes } : {})} />)
        )}
      </TabSection>
    </div>
  );
}

function InlineEditRow({ label, value, multiline = false, saving, onSave }: { readonly label: string; readonly value: string; readonly multiline?: boolean; readonly saving: boolean; readonly onSave: (value: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  function start() { setDraft(value); setEditing(true); }
  function save() { onSave(draft); setEditing(false); }
  return <div className="py-3">
    <div className="flex items-start justify-between gap-4">
      <span className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</span>
      {editing
        ? <div className="flex gap-2"><RowAction className="text-steel hover:text-slateInk" onClick={() => setEditing(false)}>Cancel</RowAction><RowAction onClick={save} disabled={saving}>Save</RowAction></div>
        : <RowAction aria-label={`Edit ${label}`} onClick={start}>Edit</RowAction>}
    </div>
    {editing
      ? (multiline
          ? <textarea className="input mt-2 min-h-24" value={draft} onChange={(e) => setDraft(e.target.value)} />
          : <input className="input mt-2" value={draft} onChange={(e) => setDraft(e.target.value)} />)
      : <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{value || <span className="text-slate-400">—</span>}</p>}
  </div>;
}

// Latest QUICK NOTE in the chart header (Dr. Kasky 2026-06-24, restored add/edit). Reads the most-recent
// flagged quick note from the chart-notes stream via the dedicated latest-quick endpoint. It is viewable
// AND addable/editable right here: when none exists it shows a quiet "+ quick note" affordance; when one
// exists it shows the note with an Edit pencil. Add POSTs a new persistent quick note (isQuickNote: true);
// edit PATCHes the existing note (version-checked). Older quick notes stay in the Staff Notes tab.
function LatestQuickNoteLine({ veteranId }: { readonly veteranId: string }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<'view' | 'add' | 'edit'>('view');
  const q = useQuery({
    queryKey: ['chart-notes-latest-quick', veteranId],
    queryFn: () => getLatestQuickNote(veteranId),
    enabled: veteranId.length > 0,
  });
  const note = q.data?.data;
  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ['chart-notes-latest-quick', veteranId] });
    void qc.invalidateQueries({ queryKey: ['chart-notes', veteranId] }); // Staff Notes history list
    void qc.invalidateQueries({ queryKey: ['cases'] }); // Cases-list Note column
  };
  const addMut = useMutation({
    mutationFn: (body: string) => createChartNote(veteranId, body, true),
    onSuccess: () => { refresh(); setMode('view'); },
    onError: (e: unknown) => window.alert(`Could not save the quick note — ${describeApiError(e)}`),
  });
  const editMut = useMutation({
    mutationFn: ({ id, version, body }: { id: string; version: number; body: string }) => patchChartNote(id, { version, body }),
    onSuccess: () => { refresh(); setMode('view'); },
    onError: (e: unknown) => window.alert(`Could not update the quick note — ${describeApiError(e)}`),
  });

  if (mode === 'add' || (mode === 'edit' && note)) {
    const editing = mode === 'edit' ? note : undefined;
    return (
      <QuickNoteHeaderEditor
        initial={editing?.body ?? ''}
        saving={addMut.isPending || editMut.isPending}
        onCancel={() => setMode('view')}
        onSave={(body) => editing ? editMut.mutate({ id: editing.id, version: editing.version, body }) : addMut.mutate(body)}
      />
    );
  }

  if (!note) {
    return (
      <button type="button" className="text-xs font-medium text-amber-700 hover:text-amber-900" onClick={() => setMode('add')}>+ quick note</button>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <span className="mt-px rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">Quick note</span>
      <span className="whitespace-pre-wrap">{note.body}
        <span className="ml-1 text-xs text-amber-700/70">— {note.createdByName ?? note.createdBy} · {formatRelativeTime(note.createdAt)}</span>
      </span>
      <button type="button" className="ml-auto shrink-0 text-xs font-medium text-amber-700 hover:text-amber-900" aria-label="Edit quick note" onClick={() => setMode('edit')}>Edit</button>
    </div>
  );
}

// Inline editor for the chart-header quick note — used for both add and edit (Dr. Kasky 2026-06-24).
function QuickNoteHeaderEditor({ initial, saving, onCancel, onSave }: {
  readonly initial: string;
  readonly saving: boolean;
  readonly onCancel: () => void;
  readonly onSave: (body: string) => void;
}) {
  const [body, setBody] = useState(initial);
  const submit = (): void => { const t = body.trim(); if (t.length > 0) onSave(t); };
  return (
    <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
      <input
        autoFocus
        className="input h-8 flex-1 px-2 py-1 text-sm"
        aria-label="Quick note"
        placeholder="Quick note…"
        value={body}
        disabled={saving}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); else if (e.key === 'Escape') onCancel(); }}
      />
      <button type="button" className="text-sm font-medium text-amber-800 hover:text-amber-900 disabled:opacity-50" disabled={saving || body.trim().length === 0} onClick={submit}>Save</button>
      <button type="button" className="text-sm text-slate-400 hover:text-slate-600" aria-label="Cancel quick note" disabled={saving} onClick={onCancel}>✕</button>
    </div>
  );
}

function TransitionModal({ caseId, from, to, version, onClose, onDone }: { readonly caseId: string; readonly from: CaseStatus; readonly to: CaseStatus; readonly version: number; readonly onClose: () => void; readonly onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: (): Promise<unknown> => {
      const input: TransitionInput = { from, to, version, ...(reason.trim() && { transitionReason: reason.trim() }) };
      return transitionCaseStatus(caseId, input);
    },
    onSuccess: () => onDone(),
    onError: (e) => {
      if (e instanceof ConflictError) { setErr('This case was modified since you loaded it. Close this dialog and retry.'); return; }
      setErr(serverErrorMessage(e) ?? 'The status change could not be saved.');
    },
  });
  return <div className="fixed inset-0 z-50 bg-slate-900/40 p-6"><div className="mx-auto mt-24 max-w-md rounded-lg bg-white p-6 shadow-xl">
    <h2 className="text-lg font-semibold text-slate-900">Move to {CASE_STATUS_LABELS[to].toLowerCase()}</h2>
    <p className="mt-1 text-sm text-slate-500">From {CASE_STATUS_LABELS[from].toLowerCase()}.</p>
    <label className="mt-4 block text-sm"><span className="mb-1 block font-medium text-slate-700">Audit note (optional)</span><input className="input" placeholder="Audit note — no PHI, e.g., 'per supervisor approval'" value={reason} onChange={(e) => { setReason(e.target.value); setErr(null); }} /></label>
    {err ? <p className="mt-2 text-sm text-rose-600">{err}</p> : null}
    <div className="mt-5 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => mut.mutate()} loading={mut.isPending}>Confirm</Button></div>
  </div></div>;
}

function DraftJobsTab({ caseId }: { readonly caseId: string }) {
  const q = useQuery({ queryKey: ['case', caseId, 'draft-jobs'], queryFn: () => listDraftJobs(caseId) });
  // Open a SPECIFIC version's letter PDF. The backend derives the key from the job version, so
  // any terminal run is viewable even if artifactPdfS3Key didn't persist. (2026-06-04 — Ryan:
  // "what's the point if I can't click the files to see the version".)
  async function viewVersion(jobId: string) {
    try {
      const { data } = await getArtifactPdfUrl(caseId, jobId);
      window.open(data.url, '_blank', 'noopener,noreferrer');
    } catch {
      window.alert('No letter PDF for that version — it may not have finished drafting.');
    }
  }
  if (q.isLoading) return <div className="text-sm text-steel">Loading draft jobs…</div>;
  const rows = q.data?.data ?? [];
  if (!rows.length) return <EmptyState title="No draft jobs" message="No drafting runs have been enqueued for this case." />;
  // Rows arrive version-desc (newest first). The raw DB version is inflated by the /draft pileup
  // (v81, v57…) and confused Ryan ("v 87? wrong"), so show a sane sequential attempt label:
  // oldest run = "Draft #1" … newest = "Draft #N". attempt = rows.length - index. The raw version
  // stays visible (muted + tooltip) for traceability — View letter still uses jobId, not this.
  const total = rows.length;
  return (
    <TabSection>
      {rows.map((d, i) => {
        const viewable = d.state === 'done' || d.state === 'failed';
        const meta = [
          `enqueued ${formatRelativeTime(d.enqueuedAt)}`,
          d.startedAt ? `started ${formatRelativeTime(d.startedAt)}` : null,
          d.completedAt ? `completed ${formatRelativeTime(d.completedAt)}` : null,
        ].filter(Boolean).join(' · ');
        return (
          <DataRow
            key={d.id}
            {...(viewable ? { onClick: () => viewVersion(d.id) } : {})}
            lead={<span className="font-medium text-slateInk">Draft #{total - i}</span>}
            meta={meta}
            trailing={
              <>
                <StatusChip tone={draftStateTone(d.state)}>{d.state}</StatusChip>
                {viewable ? <RowAction onClick={(e) => { e.stopPropagation(); viewVersion(d.id); }}>View letter</RowAction> : null}
              </>
            }
          />
        );
      })}
    </TabSection>
  );
}

// Draft-job state → Aegis chip tone. done = good, failed/cancelled = bad, running = active,
// queued = info, halted = warn, anything else = neutral.
function draftStateTone(state: string): ChipTone {
  switch (state) {
    case 'done': return 'good';
    case 'failed':
    case 'cancelled':
    case 'canceled': return 'bad';
    case 'running': return 'active';
    case 'queued': return 'info';
    case 'halted': return 'warn';
    default: return 'neutral';
  }
}

// Veteran clinical-chart sections, mounted on the case page. Fetches the same veteran detail the
// veteran chart uses (['veteran', veteranId]) and renders the same SC Conditions / Active Problems /
// Medications panels with full add/edit/delete. invalidate() refetches the shared query so an edit
// made here is reflected on the veteran chart and vice-versa.
function VeteranClinicalTab({ veteranId, section }: { readonly veteranId: string; readonly section: 'conditions' | 'problems' | 'medications' }) {
  const qc = useQueryClient();
  const veteran = useQuery({ queryKey: ['veteran', veteranId], queryFn: () => getVeteran(veteranId), enabled: veteranId.length > 0 });
  const invalidate = async () => { await qc.invalidateQueries({ queryKey: ['veteran', veteranId] }); };
  if (veteran.isLoading) return <div className="text-sm text-slate-500">Loading chart…</div>;
  if (!veteran.data) return <EmptyState title="Chart unavailable" message="The veteran's chart could not be loaded." />;
  const v = veteran.data.data;
  if (section === 'conditions') return <ConditionsPanel veteranId={veteranId} rows={v.scConditions} onChange={invalidate} />;
  if (section === 'problems') return <ProblemsPanel veteranId={veteranId} rows={v.activeProblems} onChange={invalidate} />;
  return <MedicationsPanel veteranId={veteranId} rows={v.activeMedications} onChange={invalidate} />;
}

function DocumentsTab({ veteranId, caseId, role }: { readonly veteranId: string; readonly caseId: string; readonly role: Role }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['documents', veteranId], queryFn: () => listDocuments(veteranId), enabled: veteranId.length > 0 });
  const [viewDoc, setViewDoc] = useState<ViewableDoc | null>(null);
  // Per-doc Re-OCR cooldown (Ryan 2026-06-18 cost-safety, RN red-team #1): the bare per-row "Re-run OCR"
  // had NO confirm and re-enabled the instant the POST returned, so a confused RN who clicked, saw the
  // row not visibly change, and clicked again sprayed PAID vision re-reads — the "$45" pattern per-file.
  // Fix: a cost confirm + a 90s per-doc cooldown that keeps the button disabled + labeled "Re-reading…"
  // after a fire, so a rapid re-click can't re-spend on the same file.
  const [reocrCoolingDoc, setReocrCoolingDoc] = useState<Set<string>>(new Set());
  const reocr = useMutation({
    mutationFn: reocrDocument,
    onSuccess: (_data, docId) => {
      setReocrCoolingDoc((prev) => new Set(prev).add(docId));
      setTimeout(() => setReocrCoolingDoc((prev) => { const next = new Set(prev); next.delete(docId); return next; }), 90_000);
      window.alert('Re-reading this file now (about a minute). The row stays marked "Re-reading…" so you don’t need to click again.');
    },
    onError: () => window.alert('Could not start re-reading this file. Please retry.'),
  });
  // Delete a misuploaded/junk file from RIGHT HERE on the case page (Ryan 2026-06-14: "I DON'T HAVE A
  // DELETE BUTTON" — the only delete lived on the veteran chart, not where he works). Same deleteDocument
  // API + same explicit confirm as the chart (removes the file AND its parsed text from the veteran's
  // chart for ALL their claims — the drafter bundle is veteran-wide). On success we invalidate the
  // documents list AND this case's chart-readiness query (['case', caseId, 'chart-readiness']) so the
  // readiness gate re-evaluates immediately: that is the whole point — delete the 0-byte/junk blocker,
  // the SendToDrafter gate clears without a manual refresh.
  const del = useMutation({
    mutationFn: deleteDocument,
    onSuccess: async () => { await Promise.all([
      qc.invalidateQueries({ queryKey: ['documents', veteranId] }),
      qc.invalidateQueries({ queryKey: ['case', caseId, 'chart-readiness'] }),
    ]); },
    onError: () => window.alert('Could not delete the file. Please retry.'),
  });
  const all = q.data?.data ?? [];
  const docs = all.filter((d) => d.caseId === caseId); // this claim's files
  // Upload presign/record is OPS-gated server-side (documents.ts) — mirror it here so a physician
  // sees the read-only list, never an upload control that 403s on presign. (Keystone Package 3.)
  // The same OPS gate governs DELETE server-side, so the danger control mirrors canUpload — a
  // physician sees the read-only list, never a delete that 403s.
  const canUpload = role === 'admin' || role === 'ops_staff';
  const canDelete = canUpload;
  return (
    <>
      {/* Case-page upload, caseId PRE-PINNED (Keystone Package 3): same shared presign → S3 PUT →
          record flow as the veteran chart, but every file lands on THIS claim — no case dropdown.
          The "Manage all veteran documents" chart link below stays as the secondary path. The
          invalidate refreshes ['documents', veteranId], so this tab AND the chart both update. */}
      {canUpload ? (
        <TabSection title="Upload to this claim" className="mb-4" bodyClassName="p-4">
          <DocumentUploadPanel veteranId={veteranId} caseId={caseId} onUploaded={async () => { await qc.invalidateQueries({ queryKey: ['documents', veteranId] }); }} />
        </TabSection>
      ) : null}
      <TabSection
        title="Documents on this claim"
        action={<Link className="text-xs font-medium text-navy transition-colors hover:text-navyDeep" to={`/veterans/${encodeURIComponent(veteranId)}#documents`}>Manage all veteran documents →</Link>}
        {...(q.isLoading || docs.length === 0 ? { bodyClassName: 'p-4' } : {})}
      >
        {q.isLoading ? (
          <div className="text-sm text-steel">Loading documents…</div>
        ) : docs.length === 0 ? (
          <EmptyState title="No documents on this claim" message="Files assigned to this claim (including the auto-generated Intake Summary) appear here. Click any file to view it in-page." />
        ) : (
          docs.map((d) => (
            <DataRow
              key={d.id}
              onClick={() => setViewDoc({ id: d.id, filename: d.filename, contentType: d.contentType })}
              lead={
                <span className="inline-flex items-center gap-2">
                  {documentDisplayName(d)}
                  {d.duplicateOfId ? <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700" title="Byte-identical to an earlier file on this case — likely a duplicate upload">Duplicate</span> : null}
                </span>
              }
              meta={[d.filename, formatFileSize(d.sizeBytes), formatPageCount(d.pageCount), formatRelativeTime(d.uploadedAt)].filter(Boolean).join(' · ')}
              trailing={
                <span className="flex items-center gap-3">
                  {(() => {
                    const cooling = reocrCoolingDoc.has(d.id) || (reocr.isPending && reocr.variables === d.id);
                    return (
                      <RowAction
                        disabled={reocr.isPending || cooling}
                        title="Re-read this file with AI (only if it shows as unreadable) — costs money"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm(`Re-read "${d.filename}" with AI? This costs money — only do it if the file shows as unreadable.`)) reocr.mutate(d.id);
                        }}
                      >
                        {cooling ? 'Re-reading…' : 'Re-run OCR'}
                      </RowAction>
                    );
                  })()}
                  {canDelete ? (
                    <RowAction kind="danger" disabled={del.isPending} title="Delete this file (use for a misuploaded or junk file)" onClick={(e) => { e.stopPropagation(); if (window.confirm(`Delete "${d.filename}"? This removes the file and its parsed text from this veteran's chart for ALL of their claims. Use this only for a file uploaded to the wrong place.`)) del.mutate(d.id); }}>Delete</RowAction>
                  ) : null}
                </span>
              }
            />
          ))
        )}
      </TabSection>
      <PdfViewerModal doc={viewDoc} onClose={() => setViewDoc(null)} />
    </>
  );
}
