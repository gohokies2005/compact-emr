import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '../../layout/AppShell';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { Spinner } from '../../components/ui/Spinner';
import { LetterEditor } from '../../components/LetterEditor';
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
  const [baseVersion, setBaseVersion] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [warnings, setWarnings] = useState<readonly LetterWarning[]>([]);
  const [instruction, setInstruction] = useState('');
  const [proposal, setProposal] = useState<SurgicalProposal | null>(null);
  const [preview, setPreview] = useState<string>('');
  const [proposalCostUsd, setProposalCostUsd] = useState<number | null>(null);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
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

  useEffect(() => {
    if (!letter) return;
    setTxt(letter.txt);
    setBaseVersion(letter.version);
  }, [letter]);

  const saveMutation = useMutation({
    mutationFn: () => {
      if (baseVersion === null) throw new Error('Letter version is missing.');
      return saveLetter(caseId, { base_version: baseVersion, txt });
    },
    onSuccess: (res) => {
      setBaseVersion(res.data.version);
      setTxt(res.data.txt);
      setWarnings(res.data.warnings ?? []);
      setMessage(`Saved version ${res.data.version}.`);
      void qc.invalidateQueries({ queryKey: ['case', caseId, 'letter'] });
    },
    onError: async (error: unknown) => {
      if (error instanceof ConflictError) {
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
    onError: (error: unknown) => setMessage(error instanceof ServiceUnavailableError ? 'Letter render is not available in this environment.' : 'Letter could not be approved (a sign-off + a ready chart are required). Please retry.'),
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
              <Link to={`/cases/${encodeURIComponent(caseId)}`} className="text-sm text-slate-500 hover:text-slate-800">Back to case</Link>
              <h1 className="mt-2 text-2xl font-semibold text-slate-950">Letter editor</h1>
              <p className="mt-1 text-sm text-slate-600">Version {baseVersion ?? letter.version} &middot; {role}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" onClick={() => setZoom((z) => Math.max(0.8, Math.round((z - 0.1) * 10) / 10))}>Zoom out</Button>
              <Button type="button" variant="secondary" onClick={() => setZoom((z) => Math.min(1.4, Math.round((z + 0.1) * 10) / 10))}>Zoom in</Button>
              {letter.rendered.pdfUrl ? <a href={letter.rendered.pdfUrl} target="_blank" rel="noreferrer"><Button type="button" variant="secondary">Open PDF</Button></a> : null}
              {letter.rendered.docxUrl ? <a href={letter.rendered.docxUrl} target="_blank" rel="noreferrer"><Button type="button" variant="secondary">Open DOCX</Button></a> : null}
            </div>
          </div>
        </Card>

        {message ? <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">{message}</div> : null}
        <WarningList warnings={warnings} />

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <LetterEditor txt={txt} lockedRanges={letter.locked_ranges} mode={canOpsEdit || canPhysicianAct ? 'editable' : 'readonly'} zoom={zoom} onChange={setTxt} />

          <aside className="space-y-4">
            {canOpsEdit || canPhysicianAct ? (
              <Card className="p-6">
                <h2 className="text-base font-semibold text-slate-900">Editing</h2>
                <p className="mt-1 text-sm text-slate-600">Type directly in the letter (locked regions are greyed). Save creates a new version.</p>
                <Button type="button" variant="primary" className="mt-4 w-full" loading={saveMutation.isPending} disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>Save new version</Button>
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

                {/* Approve / Decline — physician (or admin) only; an RN never signs off a letter. */}
                {canPhysicianAct ? (
                  <div className="mt-6 flex flex-col gap-2 border-t border-slate-200 pt-4">
                    <Button type="button" variant="primary" className="w-full" loading={approveMutation.isPending} disabled={approveMutation.isPending} onClick={() => approveMutation.mutate()}>Approve letter</Button>
                    <Button type="button" variant="secondary" className="w-full" onClick={() => setDeclineOpen(true)}>Decline and send back to RN</Button>
                  </div>
                ) : null}
              </Card>
            ) : null}
          </aside>
        </div>

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
