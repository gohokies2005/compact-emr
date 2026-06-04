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
import { getCase } from '../../api/cases';
import { getArtifactPdfUrl } from '../../api/drafter';
import { approveLetter } from '../../api/letter';

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

  if (caseQuery.isLoading) {
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

  const readyForPhysician =
    c.runComplete === true &&
    c.shipRecommendation === 'ship' &&
    c.status === 'physician_review' &&
    latestDraftJob !== null;

  const openSignedDraftPdf = async () => {
    if (!latestDraftJob) return;
    try {
      const { data } = await getArtifactPdfUrl(c.id, latestDraftJob.id);
      window.open(data.url, '_blank', 'noopener,noreferrer');
    } catch {
      window.alert('Could not open the PDF. Please try again.');
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
    } catch {
      await qc.invalidateQueries({ queryKey: ['case', caseId] });
      window.alert('Sign-off was recorded, but finalizing the letter failed (the chart may not be ready, or render is unavailable). The case stays in review — please retry or flag to Dr. Ryan.');
    }
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
            {c.veteran ? `${c.veteran.firstName} ${c.veteran.lastName}` : c.veteranId}
          </p>
          <p className="mt-2 text-sm">
            <Link className="text-indigo-600 hover:underline" to="/p/queue">
              Back to queue
            </Link>
          </p>
        </Card>

        {readyForPhysician && latestDraftJob ? (
          <PhysicianLetterReadyPanel
            c={c}
            job={latestDraftJob}
            canSendBack
            onOpenPdf={openSignedDraftPdf}
            onEditText={() => navigate(`/cases/${encodeURIComponent(c.id)}/letter`)}
            onOpenSignOff={() => setSignOffOpen(true)}
            onChanged={onChanged}
          />
        ) : (
          <EmptyState
            title="Not ready for review"
            message="This case is not ready for physician review."
          />
        )}

        <SignOffPopup
          caseId={caseId}
          open={signOffOpen}
          onClose={() => setSignOffOpen(false)}
          onSignedOff={onSignedOff}
        />
      </div>
    </AppShell>
  );
}
