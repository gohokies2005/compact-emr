import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../../layout/AppShell';
import { Card } from '../../components/ui/Card';
import { Spinner } from '../../components/ui/Spinner';
import { EmptyState } from '../../components/ui/EmptyState';
import { CaseStatusBadge } from '../../components/ui/CaseStatusBadge';
import {
  PhysicianLetterReadyPanel,
  type ReadyDraftJob,
} from '../../components/PhysicianLetterReadyPanel';
import { SignOffPopup } from '../../components/SignOffPopup';
import { AdvisoryPanel } from '../../components/AdvisoryPanel';
import { DoctorPackPanel } from '../../components/DoctorPackPanel';
import { SoapOverviewCard } from '../../components/SoapOverviewCard';
import { PhysicianHandoffNotes } from '../../components/PhysicianHandoffNotes';
import { getCase, type SignOffAnswers } from '../../api/cases';
import { formatNameLastFirst } from '../../lib/format';
import { approveLetter, finalizeImportLetter, getLetter } from '../../api/letter';
import { describeApiError } from '../../api/client';

export function PhysicianReviewPage() {
  const { caseId: routeCaseId } = useParams();
  const caseId = routeCaseId ?? '';
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [signOffOpen, setSignOffOpen] = useState(false);

  const caseQuery = useQuery({
    queryKey: ['case', caseId],
    queryFn: () => getCase(caseId),
    enabled: caseId.length > 0,
  });

  // Imported-letter detection (functional gap fix, 2026-06-14): an externally-imported finished PDF
  // (LetterRevision source='external_import') flows import → rn_review → physician_review, but its
  // import txn NEVER sets runComplete/shipRecommendation, so the normal "ready" gate below dead-ended
  // the physician on "Not ready for review" — forcing a detour through the letter editor to finalize.
  // We read the CURRENT revision's `source` from GET /cases/:id/letter (the SAME source LetterEditorPage
  // uses) and, for an import, render the finalize panel as READY + route the sign-off through
  // finalizeImportLetter (NOT approveLetter, which 409s on imports). Mirrors LetterEditorPage exactly.
  const letterQuery = useQuery({
    queryKey: ['case', caseId, 'letter'],
    queryFn: () => getLetter(caseId),
    enabled: caseId.length > 0,
  });
  const isImportedLetter = letterQuery.data?.data.source === 'external_import';

  // Also wait on the letter query: readyForPhysician depends on hasCurrentLetter (from getLetter), so
  // rendering before it settles would briefly flash "Not ready for review" on a halted-but-has-letter
  // case before flipping to the panel (QA LOW, 2026-06-24). Both queries fire in parallel on mount.
  if (caseQuery.isLoading || letterQuery.isLoading) {
    return (
      <AppShell>
        <Spinner label="Loading case" />
      </AppShell>
    );
  }

  if (!caseQuery.data) {
    return (
      <AppShell>
        <EmptyState title="Case not found" message="The requested case could not be loaded." />
      </AppShell>
    );
  }

  const c = caseQuery.data.data;
  const latestDraftJob = (c.draftJobs?.[0] ?? null) as ReadyDraftJob | null;
  // Pre-flight approve blockers (advisory mirror of the POST /letter/approve gates). Fail-open:
  // an absent field means no banner — never block the review page on the pre-flight.
  const approveBlockers = c.approveBlockers ?? [];

  // The grade (shipRecommendation) is ADVISORY, not a gate (Ryan 2026-06-20): a C-grade letter the
  // physician judges acceptable (e.g. a known PACT-rhinitis risk the customer accepts) must still be
  // reviewable + deliverable. The old `shipRecommendation === 'ship'` clause hid the Edit/Approve
  // panel for any non-ship grade → "Not ready for review" dead-end (Pichette). The GradeChip below
  // still shows the grade, so the physician sees it's a C and decides. Backend /approve has no grade
  // gate. Render the panel for ANY completed letter in physician_review.
  // A current letter the doctor can sign — txt is the source of truth; a rendered PDF also counts.
  const letter = letterQuery.data?.data ?? null;
  const hasCurrentLetter =
    letter !== null &&
    ((typeof letter.txt === 'string' && letter.txt.trim().length > 0) || Boolean(letter.rendered?.pdfUrl));

  // runComplete means "the automated drafter finished its own run" — NOT "a valid letter exists".
  // A halted-then-hand-edited draft (paused for days, edited, then forwarded into the queue) and an
  // imported PDF both legitimately have runComplete=false. Gating the review panel on runComplete
  // dead-ended those on "Not ready for physician review" even though a real letter was forwarded — a
  // no-block-rule violation (Ryan 2026-06-24, CLM-CCFDA1BCC3: "it's not really paused … just call it
  // done but unverified"). Render the review/sign panel for ANY physician_review case that HAS a
  // current letter; the "Unverified" badge (panel) tells the physician the automated pipeline didn't
  // complete. Backend /approve already has no runComplete gate. A pre-draft halt with NO letter
  // (hasCurrentLetter=false) still correctly falls through to "Not ready".
  const readyForPhysician =
    c.status === 'physician_review' &&
    latestDraftJob !== null &&
    (c.runComplete === true || hasCurrentLetter);
  const draftUnverified = c.runComplete !== true;

  // P0a (Ryan 2026-06-13): the physician View-PDF MUST render the current saved version, not a
  // job-pinned artifact. The old path called getArtifactPdfUrl(latestDraftJob.id) → that draft
  // job's version, which goes STALE the moment an editor/surgical save advances currentVersion —
  // a physician could sign a PDF they never saw. Read from GET /cases/:id/letter (resolveCurrent at
  // currentVersion), the SAME source CaseDetailPage and the DOCX use, so all three always agree.
  const openLetterPdf = async () => {
    try {
      const { data } = await getLetter(c.id);
      if (!data.rendered.pdfUrl) { window.alert('The letter PDF is not ready yet. If it persists, flag this case to Dr. Ryan.'); return; }
      window.open(data.rendered.pdfUrl, '_blank', 'noopener,noreferrer');
    } catch (e: unknown) {
      window.alert(`Could not open the letter PDF — ${describeApiError(e)}. If it keeps failing, flag this case to Dr. Ryan.`);
    }
  };

  const onChanged = async () => {
    await qc.invalidateQueries({ queryKey: ['case', caseId] });
  };

  // "Approve and sign" = record the sign-off questionnaire (the popup) AND finalize the letter.
  // The popup only RECORDED the sign-off; without the approve call the case stayed in
  // physician_review and approve appeared to do nothing. Chain the finalize (-> 'delivered'),
  // then return to the queue. (Ryan 2026-06-04.)
  const onSignedOff = async () => {
    try {
      await approveLetter(caseId);
      await qc.invalidateQueries({ queryKey: ['case', caseId] });
      navigate('/p/queue');
    } catch (e: unknown) {
      await qc.invalidateQueries({ queryKey: ['case', caseId] });
      // Sign-off incident 2026-06-09: this catch swallowed the server's precise 409 gate message
      // (signer-name gate) behind a generic "chart may not be ready" guess — an hour lost. Surface
      // the REAL cause via the house describeApiError; its canned text remains only as the
      // fallback when the server sent no message.
      window.alert(`Sign-off was recorded, but finalizing the letter failed — ${describeApiError(e)}. The case stays in review — resolve the cause above and re-approve, or flag to Dr. Ryan.`);
    }
  };

  // Imported letter (2026-06-14): the SignOffPopup hands its affirmative answers STRAIGHT to
  // finalizeImportLetter (which records its own PDF-bound sign-off + delivers the imported PDF as-is —
  // no re-render). Mirrors LetterEditorPage's finalizeImportMutation. On success, back to the queue.
  const onFinalizeImport = async (input: { answers: SignOffAnswers; notes?: string; overrideChartReadiness?: boolean; chartReadinessOverrideReason?: string }) => {
    await finalizeImportLetter(caseId, input);
    await qc.invalidateQueries({ queryKey: ['case', caseId] });
    await qc.invalidateQueries({ queryKey: ['case', caseId, 'letter'] });
    navigate('/p/queue');
  };

  return (
    <AppShell>
      <div className="space-y-6">
        <Card>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold text-slate-900">{c.claimedCondition}</h1>
            <CaseStatusBadge status={c.status} />
          </div>
          <p className="mt-1 text-sm text-slate-500">
            Case {c.id} ·{' '}
            {formatNameLastFirst(c.veteran?.firstName, c.veteran?.lastName, c.veteranId)}
          </p>
          <p className="mt-2 text-sm">
            <Link className="text-indigo-600 hover:underline" to="/p/queue">
              Back to queue
            </Link>
          </p>
        </Card>

        {isImportedLetter && c.status === 'physician_review' ? (
          // Imported letter ready to finalize (2026-06-14). Distinct from the drafter_run ready panel:
          // there is no grade/hints/draftJob — the imported PDF is the final artifact. Render READY and
          // finalize AS-IS (no re-render). Mirrors LetterEditorPage's import block.
          <Card>
            <div className="flex flex-col gap-4">
              <div>
                <h2 className="text-base font-semibold text-slate-900">Imported letter ready to finalize</h2>
                <p className="mt-1 text-sm text-slate-600">
                  This letter was imported as a finished PDF. Finalizing delivers the exact PDF unchanged — it is not re-rendered.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={openLetterPdf}
                  className="inline-flex items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  View letter PDF
                </button>
                <button
                  type="button"
                  onClick={() => setSignOffOpen(true)}
                  className="inline-flex items-center justify-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
                >
                  Finalize for delivery (as-is, no re-render)
                </button>
              </div>
            </div>
          </Card>
        ) : readyForPhysician && latestDraftJob ? (
          <>
            {approveBlockers.length > 0 ? (
              // Sign-off incident 2026-06-09: the physician completed the whole attestation and
              // only THEN hit the 409 approve gate. Show the gates' own messages BEFORE attesting.
              <div role="alert" className="rounded-lg border border-amber-300 border-l-4 border-l-amber-500 bg-amber-50 p-4 text-sm text-amber-900">
                <p className="font-semibold">
                  Approve will be blocked — resolve {approveBlockers.length === 1 ? 'this' : 'these'} before signing:
                </p>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {approveBlockers.map((b) => (
                    <li key={b.code}>{b.message}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <PhysicianLetterReadyPanel
              c={c}
              job={latestDraftJob}
              unverified={draftUnverified}
              canSendBack
              onOpenPdf={openLetterPdf}
              onEditText={() => navigate(`/cases/${encodeURIComponent(c.id)}/letter`)}
              onOpenSignOff={() => setSignOffOpen(true)}
              onChanged={onChanged}
            />
          </>
        ) : c.status === 'delivered' || c.status === 'paid' ? (
          // P0b (Ryan 2026-06-13): a signed/delivered letter must stay viewable to the physician
          // who signed it — the review page used to dead-end on "Not ready for review" for these.
          <Card>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-emerald-800">
                  ✓ Signed and finalized{c.status === 'paid' ? ' · paid' : ' · delivered'}
                </p>
                <p className="mt-1 text-sm text-slate-500">This letter has been signed. You can still view the final PDF.</p>
              </div>
              <button
                type="button"
                onClick={openLetterPdf}
                className="inline-flex items-center justify-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
              >
                View final letter PDF
              </button>
            </div>
          </Card>
        ) : (
          <EmptyState
            title="Not ready for review"
            message="This case is not ready for physician review."
          />
        )}

        {/* RN→doctor handoff notes (Ryan 2026-06-24, Spring bug): the note the RN attached when sending the
            case for review. It was written to case_messages but no screen rendered it; this surfaces it on the
            physician's primary page, under the letter action and above the clinical SOAP. Hides when empty. */}
        <PhysicianHandoffNotes caseId={c.id} />

        {/* Clinical SOAP-note Overview (Ryan 2026-06-24, item: grade + signature ABOVE the SOAP note in the
            doctor view). Moved BELOW the letter/grade/sign-off panel so the physician sees the letter grade and
            the approve/sign action FIRST (the decision they're here to make), with the calm AI-synthesized
            Subjective / Objective / Assessment / Plan clinical context beneath it. Deterministic verdict
            fallback means it always shows; hasUnreadPages is false by physician_review (the read job is done). */}
        <SoapOverviewCard
          caseId={c.id}
          claimedCondition={c.claimedCondition}
          veteranStatement={c.veteranStatement ?? null}
          hasUnreadPages={false}
        />

        {/* Chunk D: Doctor Pack (curated chart abridgement) between the SOAP overview and Ask Aegis. */}
        {caseId ? <DoctorPackPanel caseId={caseId} /> : null}

        {caseId ? <AdvisoryPanel caseId={caseId} /> : null}

        {isImportedLetter ? (
          // Imported letter: the popup's affirmative answers go STRAIGHT to finalize-import (records
          // its own PDF-bound sign-off + delivers as-is). No separate POST /sign-off — that binds to
          // the placeholder TXT the delivery gate can never match. (Mirrors LetterEditorPage, 2026-06-14.)
          <SignOffPopup
            caseId={caseId}
            open={signOffOpen}
            onClose={() => setSignOffOpen(false)}
            title="Finalize imported letter"
            submitLabel="Finalize for delivery"
            onSubmitAnswers={onFinalizeImport}
          />
        ) : (
          <SignOffPopup
            caseId={caseId}
            open={signOffOpen}
            onClose={() => setSignOffOpen(false)}
            onSignedOff={onSignedOff}
          />
        )}
      </div>
    </AppShell>
  );
}
