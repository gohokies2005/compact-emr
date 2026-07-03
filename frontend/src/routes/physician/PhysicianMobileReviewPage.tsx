import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../../layout/AppShell';
import { Spinner } from '../../components/ui/Spinner';
import { EmptyState } from '../../components/ui/EmptyState';
import { SignOffPopup } from '../../components/SignOffPopup';
import { ReviewChangesPopup } from '../../components/ReviewChangesPopup';
import { SendBackToRnModal } from '../../components/SendBackToRnModal';
import { SoapOverviewCard } from '../../components/SoapOverviewCard';
import { DoctorPackPanel } from '../../components/DoctorPackPanel';
import { PhysicianDocumentsList } from '../../components/PhysicianDocumentsList';
import { PhysicianHandoffNotes } from '../../components/PhysicianHandoffNotes';
import { LetterPdfModal } from '../../components/LetterPdfModal';
import { GradeChip } from '../../components/ui/GradeChip';
import { getCase, type SignOffAnswers } from '../../api/cases';
import { formatNameLastFirst } from '../../lib/format';
import { approveLetter, finalizeImportLetter, getLetter } from '../../api/letter';
import { describeApiError } from '../../api/client';

// PHYSICIAN MOBILE REVIEW (Ryan/Dr. Kasky 2026-06-25, foundation slice #80).
//
// A doctor on the move, a few spare minutes: open a letter → read the SOAP story → glance at a couple
// of abridged docs → read the letter → tap APPROVE (sign-off on the phone is fine), or SAVE IT FOR
// WHEN THEY'RE AT A COMPUTER, or SEND BACK TO RN. One focused, scrollable column with a sticky bottom
// action bar so the decision is always one thumb-tap away.
//
// READ-ONLY by design (the feasibility call, Dr. Kasky): NO mobile letter editing. The surgical /
// guided-revision edit flow needs precise verbatim passage selection inside a contentEditable letter +
// a side-by-side preview with citation diffs — genuinely fiddly on a phone, and Dr. Kasky said no typing
// paragraphs on an iPhone. "Needs an edit" therefore routes to "Save for computer" (the case stays in
// physician_review, unchanged — finish in the desktop editor) or "Send back to RN". The letter is
// VIEW-only here (Open PDF) and the full editor is one tap away on a computer.
//
// APPROVE reuses the EXISTING sign-off → approve path UNCHANGED (SignOffPopup + approveLetter /
// finalizeImportLetter for imports). The legal attestation is NOT weakened. SAVE FOR COMPUTER makes NO
// state change.
//
// SCOPE: physician review/approve only. The page reuses the desktop review components wholesale; only
// the layout (mobile-first single column + sticky action bar) differs.

export function PhysicianMobileReviewPage() {
  const { caseId: routeCaseId } = useParams();
  const caseId = routeCaseId ?? '';
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [signOffOpen, setSignOffOpen] = useState(false);
  const [sendBackOpen, setSendBackOpen] = useState(false);
  const [showLetterPdf, setShowLetterPdf] = useState(false);

  const caseQuery = useQuery({
    queryKey: ['case', caseId],
    queryFn: () => getCase(caseId),
    enabled: caseId.length > 0,
  });
  // The letter query drives both the imported-letter branch and the "has a real letter" gate — exactly
  // mirroring the desktop PhysicianReviewPage so the two surfaces never disagree on readiness.
  const letterQuery = useQuery({
    queryKey: ['case', caseId, 'letter'],
    queryFn: () => getLetter(caseId),
    enabled: caseId.length > 0,
  });
  const isImportedLetter = letterQuery.data?.data.source === 'external_import';

  if (caseQuery.isLoading || letterQuery.isLoading) {
    return (
      <AppShell>
        <div className="mx-auto max-w-xl">
          <Spinner label="Loading case" />
        </div>
      </AppShell>
    );
  }

  if (!caseQuery.data) {
    return (
      <AppShell>
        <div className="mx-auto max-w-xl">
          <EmptyState title="Case not found" message="The requested case could not be loaded." />
        </div>
      </AppShell>
    );
  }

  const c = caseQuery.data.data;
  const letter = letterQuery.data?.data ?? null;
  const hasCurrentLetter =
    letter !== null &&
    ((typeof letter.txt === 'string' && letter.txt.trim().length > 0) || Boolean(letter.rendered?.pdfUrl));
  const latestDraftJob = c.draftJobs?.[0] ?? null;
  // Same readiness gate as the desktop page: ANY physician_review case that HAS a current letter is
  // reviewable here (runComplete OR a forwarded/edited/imported letter). A pre-draft halt with no letter
  // falls through to "Not ready".
  const readyForPhysician =
    c.status === 'physician_review' && (isImportedLetter || (latestDraftJob !== null && (c.runComplete === true || hasCurrentLetter)));
  const draftUnverified = c.runComplete !== true && !isImportedLetter;
  const isSignedDelivered = c.status === 'delivered' || c.status === 'paid';
  const approveBlockers = c.approveBlockers ?? [];

  // Open the letter PDF in an INLINE modal (iframe), never window.open. A window.open AFTER an
  // await getLetter() runs outside the click gesture → mobile/PWA popup-blockers silently kill it
  // ("the doctor app does not open a PDF when clicked unless in edit mode", Dr. Kasky 2026-06-26).
  // The modal fetches a fresh presigned URL itself.
  const openLetterPdf = () => setShowLetterPdf(true);

  const onChanged = async () => {
    await qc.invalidateQueries({ queryKey: ['case', caseId] });
  };

  // APPROVE (normal drafter_run letter): record the sign-off, then finalize → delivered → back to queue.
  // Reuses approveLetter unchanged; the legal attestation lives in SignOffPopup.
  const onSignedOff = async () => {
    try {
      await approveLetter(caseId);
      await qc.invalidateQueries({ queryKey: ['case', caseId] });
      navigate('/p/m/queue');
    } catch (e: unknown) {
      await qc.invalidateQueries({ queryKey: ['case', caseId] });
      window.alert(`Sign-off was recorded, but finalizing the letter failed — ${describeApiError(e)}. The case stays in review — resolve the cause and re-approve on a computer, or flag to Dr. Ryan.`);
    }
  };

  // APPROVE (imported PDF): the affirmative answers go straight to finalize-import (delivers the exact
  // PDF as-is). Same path the desktop page uses.
  const onFinalizeImport = async (input: {
    answers: SignOffAnswers;
    notes?: string;
    overrideChartReadiness?: boolean;
    chartReadinessOverrideReason?: string;
  }) => {
    await finalizeImportLetter(caseId, input);
    await qc.invalidateQueries({ queryKey: ['case', caseId] });
    await qc.invalidateQueries({ queryKey: ['case', caseId, 'letter'] });
    navigate('/p/m/queue');
  };

  const veteranName = formatNameLastFirst(c.veteran?.firstName, c.veteran?.lastName, c.veteranId);
  const canAct = readyForPhysician;

  // Considerations before signing (Dr. Kasky 2026-06-25): the grader's substantive argument hints are
  // physician-judgment items — surfaced here OPTIONAL, mirroring the desktop PhysicianLetterReadyPanel.
  // They never block approve/sign. Guard the untrusted worker payload + drop blank issues; cap at 3.
  const considerations = (latestDraftJob?.gradeSidecarJson?.targeted_revision_hints ?? [])
    .filter((h) => typeof h.issue === 'string' && h.issue.trim().length > 0)
    .slice(0, 3);

  return (
    <AppShell>
      {/* Bottom padding so the last content clears the sticky action bar. */}
      <div className="mx-auto max-w-xl pb-32">
        {/* Header */}
        <div className="mb-4">
          <Link to="/p/m/queue" className="text-sm text-navy underline">
            ‹ Back to queue
          </Link>
          <div className="mt-2 flex items-center gap-2">
            <h1 className="text-xl font-semibold text-slate-900">{c.claimedCondition}</h1>
            {c.grade ? <GradeChip grade={c.grade} /> : null}
          </div>
          <p className="mt-0.5 text-sm text-slate-500">{veteranName} · {c.id}</p>
          {draftUnverified && canAct ? (
            <p className="mt-2 inline-flex rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">
              Unverified — the automated draft did not finish. Review carefully before signing.
            </p>
          ) : null}
        </div>

        {!canAct && !isSignedDelivered ? (
          <EmptyState title="Not ready for review" message="This case is not ready for physician review yet." />
        ) : isSignedDelivered ? (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
            <p className="text-sm font-semibold text-emerald-800">✓ Signed and finalized{c.status === 'paid' ? ' · paid' : ' · delivered'}</p>
            <p className="mt-1 text-sm text-slate-600">This letter has been signed. You can still view the final PDF.</p>
            <button
              type="button"
              onClick={openLetterPdf}
              className="mt-3 inline-flex min-h-[44px] items-center justify-center rounded-lg bg-navy px-4 py-2 text-sm font-medium text-white active:bg-navyDeep"
            >
              View final letter PDF
            </button>
          </div>
        ) : (
          <div className="space-y-5">
            {approveBlockers.length > 0 ? (
              <div role="alert" className="rounded-xl border border-amber-300 border-l-4 border-l-amber-500 bg-amber-50 p-4 text-sm text-amber-900">
                <p className="font-semibold">Approve will be blocked — resolve {approveBlockers.length === 1 ? 'this' : 'these'} first:</p>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {approveBlockers.map((b) => (
                    <li key={b.code}>{b.message}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* RN→MD handoff note (P0-2, 2026-06-26): the RN's send-to-doctor / correction note lives in
                case_messages and was rendered ONLY on the desktop review page — a physician reviewing on
                mobile lost it. Surface it FIRST so the handoff message can't be missed. Fetches + fails
                open independently (same component the desktop page uses). */}
            <PhysicianHandoffNotes caseId={c.id} />

            {/* 1) THE QUICK STORY — AI SOAP overview (Subjective/Objective/Assessment/Plan + verdict). */}
            <section aria-label="Clinical summary">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">The quick story</h2>
              <SoapOverviewCard
                caseId={c.id}
                claimedCondition={c.claimedCondition}
                veteranStatement={c.veteranStatement ?? null}
                hasUnreadPages={false}
              />
            </section>

            {/* 2) ABRIDGED / KEY DOCS — the curated Doctor Pack (open the abridged PDF), plus the full
                   record below it for anyone who wants to glance deeper. Both open in-viewer / new tab. */}
            <section aria-label="Records">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Key records (abridged)</h2>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <DoctorPackPanel caseId={c.id} />
              </div>
              <details className="mt-3 rounded-xl border border-slate-200 bg-white">
                <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-slate-700">
                  All documents on this case
                </summary>
                <div className="border-t border-slate-100">
                  <PhysicianDocumentsList caseId={c.id} />
                </div>
              </details>
            </section>

            {/* 3) THE LETTER — read it. View-only on mobile (open the rendered PDF). Editing is on the
                   computer (the feasibility call): no mobile paragraph editing. */}
            <section aria-label="The letter">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">The letter</h2>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <p className="text-sm text-slate-600">Read the rendered letter before you sign.</p>
                <button
                  type="button"
                  onClick={openLetterPdf}
                  className="mt-3 inline-flex min-h-[48px] w-full items-center justify-center rounded-lg bg-navy px-4 py-3 text-base font-medium text-white active:bg-navyDeep"
                >
                  Open the letter (PDF)
                </button>
                <p className="mt-3 text-xs text-slate-400">
                  Editing the letter happens on a computer. If it needs changes, use “Save for computer” or “Send back to RN” below.
                </p>
              </div>

              {/* Considerations before signing (Dr. Kasky 2026-06-25): optional, physician-judgment
                  argument hints. Never block approve/sign — informational only, mirroring the desktop
                  PhysicianLetterReadyPanel. Hidden when there are none. */}
              {considerations.length > 0 ? (
                <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <h3 className="text-sm font-semibold text-slate-900">Considerations before signing</h3>
                  <p className="mt-0.5 text-xs text-slate-500">Not required — consider before you sign.</p>
                  <ul className="mt-2 space-y-2">
                    {considerations.map((hint, index) => (
                      <li key={`${hint.section ?? 'section'}-${index}`} className="text-sm text-slate-600">
                        <span className="text-slate-400">{'• '}</span>
                        <span className="font-medium">Section {hint.section ?? 'review'} — </span>
                        <span className="whitespace-pre-wrap">{hint.issue ?? ''}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
          </div>
        )}
      </div>

      {/* STICKY ACTION BAR — the decision, always a thumb-tap away. Only on a reviewable case. */}
      {canAct && !isSignedDelivered ? (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-white/80">
          <div className="mx-auto flex max-w-xl flex-col gap-2">
            <button
              type="button"
              onClick={() => setSignOffOpen(true)}
              className="inline-flex min-h-[52px] w-full items-center justify-center rounded-xl bg-navy px-4 py-3 text-base font-semibold text-white shadow-sm active:bg-navyDeep"
            >
              {isImportedLetter ? 'Approve & finalize (as-is)' : 'Approve & sign'}
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => navigate('/p/m/queue')}
                title="Leaves the case in your queue, unchanged, to finish on a computer"
                className="inline-flex min-h-[48px] flex-1 items-center justify-center rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 active:bg-slate-50"
              >
                Save for computer
              </button>
              <button
                type="button"
                onClick={() => setSendBackOpen(true)}
                className="inline-flex min-h-[48px] flex-1 items-center justify-center rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 active:bg-slate-50"
              >
                Send back to RN
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Sign-off / approve — the EXISTING attestation popup, unchanged. Imports route to finalize-import. */}
      {isImportedLetter ? (
        <SignOffPopup
          caseId={caseId}
          open={signOffOpen}
          onClose={() => setSignOffOpen(false)}
          title="Finalize imported letter"
          submitLabel="Finalize for delivery"
          onSubmitAnswers={onFinalizeImport}
        />
      ) : (
        <SignOffPopup caseId={caseId} open={signOffOpen} onClose={() => setSignOffOpen(false)} onSignedOff={onSignedOff} />
      )}

      <SendBackToRnModal
        caseId={c.id}
        veteranId={c.veteranId}
        from={c.status}
        version={c.version}
        open={sendBackOpen}
        onClose={() => setSendBackOpen(false)}
        onDone={onChanged}
      />
      <LetterPdfModal caseId={showLetterPdf ? c.id : null} onClose={() => setShowLetterPdf(false)} />
      {/* Auto-pops when the physician opens an RN-corrected case with unsigned changes (Ryan 2026-07-03). */}
      <ReviewChangesPopup caseId={caseId} />
    </AppShell>
  );
}
