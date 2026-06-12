import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '../../layout/AppShell';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { Spinner } from '../../components/ui/Spinner';
import { LetterEditor } from '../../components/LetterEditor';
import { SignOffPopup } from '../../components/SignOffPopup';
import { getCase } from '../../api/cases';
import { letterFilename } from '../../lib/letterFilename';
import { ConflictError, ServiceUnavailableError, SurgicalEditUnappliableError } from '../../api/client';
import {
  applySurgicalAi,
  approveLetter,
  declineLetter,
  getLetter,
  previewSurgicalAi,
  saveLetter,
  type LetterWarning,
  type SurgicalProposal,
} from '../../api/letter';

// Turns an approve failure into an actionable physician-facing message. The render Lambda being
// unconfigured surfaces as a 503 (ServiceUnavailableError); the approve gates are 409s carrying a
// `details.reason` on ConflictError.current (sign_off_required / chart_not_ready / etc.). The
// chart-readiness 409 uses error CODE 'chart_not_ready' and its details carry `blockingFiles`
// rather than a `reason`, so detect either form. (architect diagnosis 2026-06-08)
export function describeApproveError(error: unknown): string {
  if (error instanceof ServiceUnavailableError) return 'Letter render is not available in this environment.';
  if (error instanceof ConflictError) {
    const details = error.current as { reason?: string; blockingFiles?: unknown } | undefined;
    const reason = details?.reason;
    if (reason === 'sign_off_required') return 'Sign off on the letter before approving.';
    if (reason === 'sign_off_not_affirmative') return 'The sign-off has a "No" answer — resolve it or send the case back to the RN before approving.';
    if (reason === 'chart_not_ready' || (Array.isArray(details?.blockingFiles) && details.blockingFiles.length > 0)) {
      return "The chart isn't ready yet — finish reviewing the records, then approve.";
    }
  }
  return 'Letter could not be approved (a sign-off + a ready chart are required). Please retry.';
}

function WarningList({ warnings }: { readonly warnings: readonly LetterWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
      <div className="text-sm font-semibold text-amber-900">Sanity warnings</div>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-800">
        {warnings.map((w) => <li key={w.rule}>{w.detail}</li>)}
      </ul>
    </div>
  );
}

export function LetterEditorPage() {
  const { id } = useParams();
  const caseId = String(id ?? '');
  const qc = useQueryClient();

  const [txt, setTxt] = useState('');
  // Live edited text captured from the editor's onChange. A REF (not state) so keystrokes do NOT
  // re-render the page and echo back into the contentEditable (which wiped the caret). Save reads
  // this. Kept in sync with `txt` on load / save / surgical-apply. (Ryan 2026-06-04.)
  const editedTextRef = useRef('');
  const [baseVersion, setBaseVersion] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [warnings, setWarnings] = useState<readonly LetterWarning[]>([]);
  const [instruction, setInstruction] = useState('');
  const [proposal, setProposal] = useState<SurgicalProposal | null>(null);
  const [preview, setPreview] = useState<string>('');
  const [proposalCostUsd, setProposalCostUsd] = useState<number | null>(null);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [signOffOpen, setSignOffOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const navigate = useNavigate();

  const letterQuery = useQuery({
    queryKey: ['case', caseId, 'letter'],
    queryFn: () => getLetter(caseId),
    enabled: caseId.length > 0,
  });

  const letter = letterQuery.data?.data;
  const role = letter?.role;
  const canOpsEdit = role === 'ops_staff' || role === 'admin';
  const canPhysicianAct = role === 'physician' || role === 'admin';
  // "/cases/:id" is admin/ops-only (App.tsx) — a physician landing there hits the role guard → /403.
  // Route a physician back to their review page instead (same target as the physician queue's Review link).
  const backTo = role === 'physician' ? `/p/review/${encodeURIComponent(caseId)}` : `/cases/${encodeURIComponent(caseId)}`;

  // Case detail (veteran name + condition) drives the filename-style title. Read-only; if it
  // hasn't loaded yet we fall back to a generic title.
  const caseQuery = useQuery({
    queryKey: ['case', caseId],
    queryFn: () => getCase(caseId),
    enabled: caseId.length > 0,
  });
  const caseDetail = caseQuery.data?.data;
  const fileName = caseDetail
    ? letterFilename(caseDetail.veteran?.lastName, caseDetail.veteran?.firstName, caseDetail.claimedCondition, baseVersion ?? letter?.version)
    : null;

  useEffect(() => {
    if (!letter) return;
    setTxt(letter.txt);
    editedTextRef.current = letter.txt;
    setBaseVersion(letter.version);
  }, [letter]);

  const saveMutation = useMutation({
    mutationFn: () => {
      if (baseVersion === null) throw new Error('Letter version is missing.');
      return saveLetter(caseId, { base_version: baseVersion, txt: editedTextRef.current });
    },
    onSuccess: (res) => {
      setBaseVersion(res.data.version);
      setTxt(res.data.txt);
      editedTextRef.current = res.data.txt;
      setWarnings(res.data.warnings ?? []);
      setMessage(`Saved version ${res.data.version}.`);
      void qc.invalidateQueries({ queryKey: ['case', caseId, 'letter'] });
    },
    onError: async (error: unknown) => {
      if (error instanceof ConflictError) {
        // RN lock (2026-06-11): an RN who reached the editor via a direct URL on a
        // physician_review case must get the HONEST reason — and their typed text must NOT be
        // clobbered by the stale-version refetch (which resets the buffer via the letter effect).
        if (error.serverMessage?.includes('locked while in physician review')) {
          setMessage('This letter is locked while the doctor has the case — your changes were NOT saved. Copy your text if you need it; editing reopens when the case leaves physician review.');
          return;
        }
        setMessage('This letter was changed elsewhere. Reloaded the latest version.');
        await letterQuery.refetch();
        return;
      }
      if (error instanceof ServiceUnavailableError) { setMessage('Letter service is not available in this environment.'); return; }
      setMessage('Letter could not be saved. Please retry.');
    },
  });

  const previewMutation = useMutation({
    mutationFn: () => previewSurgicalAi(caseId, { instruction: instruction.trim() }),
    onSuccess: (res) => {
      setProposal(res.data.proposal);
      setPreview(res.data.preview);
      setProposalCostUsd(res.data.costUsd);
      setMessage('Limited scope edit preview is ready.');
    },
    onError: (error: unknown) => {
      // 422 (unappliable — cost still incurred), 503 (surgical-AI not configured), or other.
      if (error instanceof ServiceUnavailableError) { setMessage('Surgical AI is not available in this environment.'); return; }
      if (error instanceof SurgicalEditUnappliableError) {
        const cost = typeof error.costUsd === 'number' ? ` (AI cost of $${error.costUsd.toFixed(2)} was still incurred)` : '';
        setMessage(`The AI ran but its proposed edit did not fit the current draft${cost}. Rephrase the instruction and try again.`);
        return;
      }
      setMessage('Limited scope edit could not be generated (try rephrasing, or it may not be enabled yet).');
    },
  });

  const applyMutation = useMutation({
    mutationFn: () => {
      if (proposal === null) throw new Error('Proposal is missing.');
      return applySurgicalAi(caseId, proposal);
    },
    onSuccess: (res) => {
      setProposal(null);
      setPreview('');
      setProposalCostUsd(null);
      setInstruction('');
      setTxt(res.data.txt);
      editedTextRef.current = res.data.txt;
      setBaseVersion(res.data.version);
      setWarnings(res.data.warnings ?? []);
      setMessage(`Applied limited scope edit. Current version ${res.data.version}.`);
      void qc.invalidateQueries({ queryKey: ['case', caseId, 'letter'] });
    },
    onError: (error: unknown) => setMessage(error instanceof ServiceUnavailableError ? 'Surgical AI is not available in this environment.' : 'Limited scope edit could not be applied.'),
  });

  const approveMutation = useMutation({
    mutationFn: () => approveLetter(caseId),
    onSuccess: async () => {
      setMessage('Letter approved and finalized.');
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['case', caseId] }),
        qc.invalidateQueries({ queryKey: ['case', caseId, 'letter'] }),
      ]);
      navigate('/p/queue'); // back to the physician queue after approving (Ryan 2026-06-04)
    },
    // Split the failure by the backend's reason so the physician sees an ACTIONABLE message,
    // not a lumped "sign-off + ready chart required" guess. The render Lambda being unconfigured
    // is a 503; the sign-off + chart gates are 409s whose `details.reason` (carried on
    // ConflictError.current) names the exact block. (architect diagnosis 2026-06-08)
    onError: (error: unknown) => setMessage(describeApproveError(error)),
  });

  const declineMutation = useMutation({
    mutationFn: () => declineLetter(caseId, { reason: declineReason.trim() }),
    onSuccess: async () => {
      setDeclineOpen(false);
      setDeclineReason('');
      setMessage('Letter sent back to the RN.');
      await qc.invalidateQueries({ queryKey: ['case', caseId] });
    },
    onError: () => setMessage('Letter could not be declined. Please retry.'),
  });

  if (letterQuery.isLoading) {
    return (
      <AppShell>
        <main className="mx-auto max-w-7xl px-6 py-8">
          <div className="flex items-center gap-2 text-sm text-slate-500"><Spinner /> Loading letter editor</div>
        </main>
      </AppShell>
    );
  }

  if (!letter) {
    return (
      <AppShell>
        <main className="mx-auto max-w-7xl px-6 py-8"><EmptyState message="Letter could not be loaded." /></main>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <main className="mx-auto max-w-7xl space-y-6 px-6 py-8">
        <Card className="p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <Link to={backTo} className="text-sm text-slate-500 hover:text-slate-800">Back to case</Link>
              <h1 className="mt-2 text-2xl font-semibold text-slate-950" title="Last name, first name, condition, version">{fileName ?? 'Letter'}</h1>
              <p className="mt-1 text-sm text-slate-600">Version {baseVersion ?? letter.version} &middot; {role}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" onClick={() => setZoom((z) => Math.max(0.8, Math.round((z - 0.1) * 10) / 10))}>Zoom out</Button>
              <Button type="button" variant="secondary" onClick={() => setZoom((z) => Math.min(1.4, Math.round((z + 0.1) * 10) / 10))}>Zoom in</Button>
              {letter.rendered.pdfUrl ? <a href={letter.rendered.pdfUrl} target="_blank" rel="noreferrer"><Button type="button" variant="secondary">Open PDF</Button></a> : null}
              {letter.rendered.docxUrl ? <a href={letter.rendered.docxUrl} target="_blank" rel="noreferrer"><Button type="button" variant="secondary" title="Downloads the editable Word source of the letter">Download Word (.docx)</Button></a> : null}
              <Button type="button" variant="secondary" onClick={() => navigate(backTo)}>Close</Button>
            </div>
          </div>
        </Card>

        {message ? <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">{message}</div> : null}
        <WarningList warnings={warnings} />

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <LetterEditor key={baseVersion ?? letter.version} txt={txt} lockedRanges={letter.locked_ranges} mode={canOpsEdit || canPhysicianAct ? 'editable' : 'readonly'} zoom={zoom} onChange={(t) => { editedTextRef.current = t; }} />

          <aside className="space-y-4">
            {canOpsEdit || canPhysicianAct ? (
              <Card className="p-6">
                <h2 className="text-base font-semibold text-slate-900">Editing</h2>
                <p className="mt-1 text-sm text-slate-600">Type directly in the letter (locked regions are greyed).</p>
                <p className="mt-2 text-sm text-slate-600">Save creates a new version of the letter. It does <span className="font-medium">not</span> send it back to the RN — use {canPhysicianAct ? '“Decline and send back to RN” below' : 'the send-back action'} for that.</p>
                {/* Disabled until the loaded version commits (the useEffect that sets baseVersion
                    runs after first paint). Without this a click in that window throws "Letter
                    version is missing" and silently no-ops the save. (architect de-flake 2026-06-08.) */}
                <Button type="button" variant="primary" className="mt-4 w-full" loading={saveMutation.isPending} disabled={saveMutation.isPending || baseVersion === null} onClick={() => saveMutation.mutate()}>Save new version</Button>
              </Card>
            ) : null}

            {/* AI surgical edit — available to BOTH the RN (ops_staff) and the physician, mirroring
                the hand-edit parity (Ryan 2026-06-04: RN "edit letter" should be just like the
                doctor's — manual OR AI surgical). Approve/Decline stays physician-only below. */}
            {canOpsEdit || canPhysicianAct ? (
              <Card className="p-6">
                <h2 className="text-base font-semibold text-slate-900">AI surgical edit</h2>
                <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">Limited scope edit, not a full redraft.</div>
                <label className="mt-4 block">
                  <span className="text-sm font-medium text-slate-800">Surgical AI instruction</span>
                  <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={4} maxLength={1000} className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200" placeholder="Example: remove the second alternative-etiology sentence." />
                </label>
                <Button type="button" variant="secondary" className="mt-3 w-full" loading={previewMutation.isPending} disabled={instruction.trim().length === 0 || previewMutation.isPending} onClick={() => previewMutation.mutate()}>Preview limited edit</Button>

                {proposal ? (
                  <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
                    <div className="text-sm font-semibold text-slate-900">Proposed edit{proposalCostUsd !== null ? ` · $${proposalCostUsd.toFixed(2)}` : ''}</div>
                    <div className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-white p-3 font-['Times_New_Roman',Times,serif] text-sm text-slate-800">{preview}</div>
                    <div className="mt-3 flex gap-2">
                      <Button type="button" variant="primary" loading={applyMutation.isPending} disabled={applyMutation.isPending} onClick={() => applyMutation.mutate()}>Apply edit</Button>
                      <Button type="button" variant="secondary" onClick={() => { setProposal(null); setPreview(''); setProposalCostUsd(null); }}>Discard</Button>
                    </div>
                  </div>
                ) : null}

                {/* Approve / Decline — physician (or admin) only; an RN never signs off a letter.
                    Approve OPENS the sign-off popup first (the backend /approve 409s with
                    sign_off_required unless a sign-off exists). On a successful sign-off we chain
                    the approve mutation — mirrors PhysicianReviewPage's onSignedOff. (architect
                    diagnosis 2026-06-08: the bare Approve button always 409'd because no sign-off
                    UI existed here.) */}
                {canPhysicianAct ? (
                  <div className="mt-6 flex flex-col gap-2 border-t border-slate-200 pt-4">
                    <Button type="button" variant="primary" className="w-full" loading={approveMutation.isPending} disabled={approveMutation.isPending} onClick={() => setSignOffOpen(true)}>Approve letter</Button>
                    <Button type="button" variant="secondary" className="w-full" onClick={() => setDeclineOpen(true)}>Decline and send back to RN</Button>
                  </div>
                ) : null}
              </Card>
            ) : null}
          </aside>
        </div>

        {/* Physician sign-off → approve. The popup RECORDS the sign-off; onSignedOff then chains
            the approve mutation (finalize → 'delivered' → back to the queue). Same wiring as
            PhysicianReviewPage. */}
        {canPhysicianAct ? (
          <SignOffPopup
            caseId={caseId}
            open={signOffOpen}
            onClose={() => setSignOffOpen(false)}
            onSignedOff={async () => {
              // Chain finalize after the sign-off is recorded. approveMutation.onError already sets
              // an actionable message (e.g. chart not ready); swallow the rejection here so the
              // popup's onSuccess doesn't surface a duplicate/unhandled error.
              try { await approveMutation.mutateAsync(); } catch { /* handled by approveMutation.onError */ }
            }}
          />
        ) : null}

        {declineOpen ? (
          <div role="dialog" aria-modal="true" aria-labelledby="decline-letter-title">
            <div className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm" />
            <div className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-6 shadow-2xl">
              <h2 id="decline-letter-title" className="text-lg font-semibold text-slate-900">Send back to RN</h2>
              <p className="mt-2 text-sm text-slate-600">Use this when the letter needs RN rework rather than a limited physician edit.</p>
              <label className="mt-4 block">
                <span className="text-sm font-medium text-slate-800">Reason</span>
                <textarea value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} rows={4} maxLength={1000} className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200" placeholder="Tell the RN what needs to change." />
              </label>
              <div className="mt-6 flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={() => setDeclineOpen(false)}>Cancel</Button>
                <Button type="button" variant="primary" loading={declineMutation.isPending} disabled={declineReason.trim().length === 0 || declineMutation.isPending} onClick={() => declineMutation.mutate()}>Send back</Button>
              </div>
            </div>
          </div>
        ) : null}
      </main>
    </AppShell>
  );
}
