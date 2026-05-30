import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AppShell } from '../../layout/AppShell';
import { Button } from '../../components/ui/Button';
import { TabBar, type TabItem } from '../../components/ui/TabBar';
import { EmptyState } from '../../components/ui/EmptyState';
import { addMedication, addProblem, addScCondition, deleteMedication, deleteProblem, deleteScCondition, downloadDocument, getVeteran, listDocuments, presignDocument, recordDocument, uploadToPresignedUrl } from '../../api/veterans';
import { createCase, type CreateCaseInput } from '../../api/cases';
import { NewClaimModal } from '../cases/NewClaimModal';
import { ChartNotesPanel } from './ChartNotesPanel';
import { ConditionSelect } from '../../components/ConditionSelect';
import { classifyEntry, isZip, uploadErrorReason, type CandidateResult } from './documentUpload';
import type { ActiveMedication, ActiveProblem, Case, Document, ScCondition } from '../../types/prisma';

const DOC_TAGS = ['STR', 'DBQ', 'C&P', 'Lay Statement', 'Other'];

// All six chart sections are top-level tabs. Order is owner-specified (2026-05-30): the
// previously-buried Pending Claims / Staff Notes / Documents tables come FIRST (they were
// stacked below the chart and hard to find), then the clinical chart tabs.
type ChartTab = 'claims' | 'notes' | 'documents' | 'conditions' | 'problems' | 'medications';
const CHART_TABS: readonly TabItem<ChartTab>[] = [
  { id: 'claims', label: 'Pending Claims' },
  { id: 'notes', label: 'Staff Notes' },
  { id: 'documents', label: 'Documents' },
  { id: 'conditions', label: 'Established Service Connected Conditions' },
  { id: 'problems', label: 'Active Problems' },
  { id: 'medications', label: 'Medications' },
];

export function VeteranChart() {
  const { id } = useParams();
  const veteranId = id ?? '';
  const [tab, setTab] = useState<ChartTab>('claims');
  const [claimModalOpen, setClaimModalOpen] = useState(false);
  const qc = useQueryClient();
  const createClaim = useMutation({ mutationFn: (input: CreateCaseInput) => createCase(veteranId, input), onSuccess: async () => { setClaimModalOpen(false); await Promise.all([qc.invalidateQueries({ queryKey: ['veteran', veteranId] }), qc.invalidateQueries({ queryKey: ['documents', veteranId] })]); } });
  const veteran = useQuery({ queryKey: ['veteran', veteranId], queryFn: () => getVeteran(veteranId), enabled: veteranId.length > 0 });
  const documents = useQuery({ queryKey: ['documents', veteranId], queryFn: () => listDocuments(veteranId), enabled: veteranId.length > 0 });
  const invalidate = async () => { await Promise.all([qc.invalidateQueries({ queryKey: ['veteran', veteranId] }), qc.invalidateQueries({ queryKey: ['documents', veteranId] })]); };

  if (veteran.isLoading) return <AppShell><div className="text-sm text-slate-500">Loading veteran…</div></AppShell>;
  if (!veteran.data) return <AppShell><EmptyState title="Veteran not found" message="The requested veteran could not be loaded." /></AppShell>;
  const v = veteran.data.data;
  return <AppShell><div className="space-y-6">
    <div className="rounded-lg border border-slate-200 bg-white p-6"><div className="flex flex-col justify-between gap-3 sm:flex-row"><div><h1 className="text-2xl font-semibold text-slate-900">{v.firstName} {v.lastName}</h1><p className="text-sm text-slate-500">{[`MRN ${v.id}`, `DOB ${v.dob}`, v.branch, (v.serviceStartYear ?? v.serviceEndYear) != null ? `${v.serviceStartYear ?? '—'}–${v.serviceEndYear ?? '—'}` : null].filter(Boolean).join(' · ')}</p></div><div className="flex items-center gap-3"><Button size="sm" onClick={() => setClaimModalOpen(true)}>+ New claim</Button><Link className="text-sm text-indigo-600" to="/veterans">Back to veterans</Link></div></div></div>
    <div className="rounded-lg border border-slate-200 bg-white">
      <TabBar tabs={CHART_TABS} active={tab} onChange={setTab} className="flex-wrap" />
      {/* All six panels stay mounted; we toggle visibility with `hidden` rather than
          conditionally mounting. Conditional mount would unmount DocumentsPanel on a tab
          switch and silently drop an in-flight upload's status/error line — the upload path
          was hardened specifically to surface that reason, so we must not lose it. */}
      <div className="p-4">
        <div role="tabpanel" hidden={tab !== 'claims'}><CasesPanel rows={v.cases} /></div>
        <div role="tabpanel" hidden={tab !== 'notes'}><ChartNotesPanel veteranId={veteranId} /></div>
        <div role="tabpanel" hidden={tab !== 'documents'}><DocumentsPanel veteranId={veteranId} cases={v.cases} documents={documents.data?.data ?? []} onChange={invalidate} /></div>
        <div role="tabpanel" hidden={tab !== 'conditions'}><ConditionsPanel veteranId={veteranId} rows={v.scConditions} onChange={invalidate} /></div>
        <div role="tabpanel" hidden={tab !== 'problems'}><ProblemsPanel veteranId={veteranId} rows={v.activeProblems} onChange={invalidate} /></div>
        <div role="tabpanel" hidden={tab !== 'medications'}><MedicationsPanel veteranId={veteranId} rows={v.activeMedications} onChange={invalidate} /></div>
      </div>
    </div>
    <NewClaimModal open={claimModalOpen} onClose={() => setClaimModalOpen(false)} onSubmit={(input) => createClaim.mutateAsync(input).then(() => undefined)} saving={createClaim.isPending} />
  </div></AppShell>;
}

function ConditionsPanel({ veteranId, rows, onChange }: { readonly veteranId: string; readonly rows: readonly ScCondition[]; readonly onChange: () => Promise<void> }) {
  const [condition, setCondition] = useState(''); const [dcCode, setDcCode] = useState('');
  const add = useMutation({ mutationFn: () => addScCondition(veteranId, { condition, ...(dcCode && { dcCode }) }), onSuccess: async () => { setCondition(''); setDcCode(''); await onChange(); } });
  const del = useMutation({ mutationFn: deleteScCondition, onSuccess: onChange });
  return <div className="space-y-4"><div className="flex flex-col gap-2 sm:flex-row sm:items-start"><div className="sm:flex-1"><ConditionSelect label="Condition" value={condition} onChange={setCondition} /></div><input className="input sm:w-40" placeholder="DC code" value={dcCode} onChange={(e) => setDcCode(e.target.value)} /><Button size="sm" onClick={() => add.mutate()} disabled={!condition}>Add</Button></div><Rows rows={rows.map((r) => ({ id: r.id, cols: [r.condition, r.dcCode ?? '—', r.ratingPct?.toString() ?? '—'], onDelete: () => { if (window.confirm('Remove this SC condition?')) del.mutate(r.id); } }))} /></div>;
}
function ProblemsPanel({ veteranId, rows, onChange }: { readonly veteranId: string; readonly rows: readonly ActiveProblem[]; readonly onChange: () => Promise<void> }) {
  const [problem, setProblem] = useState(''); const add = useMutation({ mutationFn: () => addProblem(veteranId, { problem }), onSuccess: async () => { setProblem(''); await onChange(); } }); const del = useMutation({ mutationFn: deleteProblem, onSuccess: onChange });
  return <div className="space-y-4"><div className="flex flex-col gap-2 sm:flex-row sm:items-start"><div className="sm:flex-1"><ConditionSelect label="Problem" value={problem} onChange={setProblem} placeholder="Select a problem…" /></div><Button size="sm" onClick={() => add.mutate()} disabled={!problem}>Add</Button></div><Rows rows={rows.map((r) => ({ id: r.id, cols: [r.problem, r.notes ?? '—'], onDelete: () => { if (window.confirm('Remove this problem?')) del.mutate(r.id); } }))} /></div>;
}
function MedicationsPanel({ veteranId, rows, onChange }: { readonly veteranId: string; readonly rows: readonly ActiveMedication[]; readonly onChange: () => Promise<void> }) {
  const [drugName, setDrugName] = useState(''); const add = useMutation({ mutationFn: () => addMedication(veteranId, { drugName }), onSuccess: async () => { setDrugName(''); await onChange(); } }); const del = useMutation({ mutationFn: deleteMedication, onSuccess: onChange });
  return <div className="space-y-4"><div className="flex gap-2"><input className="input" placeholder="Medication" value={drugName} onChange={(e) => setDrugName(e.target.value)} /><Button size="sm" onClick={() => add.mutate()} disabled={!drugName}>Add</Button></div><Rows rows={rows.map((r) => ({ id: r.id, cols: [r.drugName, r.dose ?? '—', r.frequency ?? '—'], onDelete: () => { if (window.confirm('Remove this medication?')) del.mutate(r.id); } }))} /></div>;
}
function Rows({ rows }: { readonly rows: readonly { readonly id: string; readonly cols: readonly string[]; readonly onDelete: () => void }[] }) { if (!rows.length) return <EmptyState title="Nothing recorded yet" message="Add the first item above." />; return <div className="divide-y divide-slate-100">{rows.map((r) => <div className="flex items-center justify-between py-3 text-sm" key={r.id}><div className="flex gap-6 text-slate-700">{r.cols.map((c, i) => <span key={`${r.id}-${i}`}>{c}</span>)}</div><button className="text-rose-600" onClick={r.onDelete}>Delete</button></div>)}</div>; }

interface UploadItem { readonly filename: string; readonly contentType: string; readonly sizeBytes: number; readonly blob: Blob; }

function DocumentsPanel({ veteranId, cases, documents, onChange }: { readonly veteranId: string; readonly cases: readonly Case[]; readonly documents: readonly Document[]; readonly onChange: () => Promise<void> }) {
  const [caseId, setCaseId] = useState(cases[0]?.id ?? ''); const [docTag, setDocTag] = useState('Other'); const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  // Upload one already-classified item via the existing presign -> upload -> record flow.
  // Throws on failure so the batch driver can record a per-file error without aborting the batch.
  async function uploadOne(item: UploadItem) {
    const presigned = await presignDocument(veteranId, { caseId, filename: item.filename, contentType: item.contentType, sizeBytes: item.sizeBytes });
    await uploadToPresignedUrl(presigned.data.uploadUrl, new File([item.blob], item.filename, { type: item.contentType }), presigned.data.requiredHeaders);
    await recordDocument(veteranId, { caseId, filename: item.filename, contentType: item.contentType, sizeBytes: item.sizeBytes, s3Key: presigned.data.s3Key, docTag });
  }

  // Expand the user's selection into upload candidates: zips are unpacked client-side, plain
  // files pass through. Returns { items, skipped } where skipped carries the reason per file.
  async function expandSelection(files: readonly File[]): Promise<{ items: UploadItem[]; skipped: { name: string; reason: string }[] }> {
    const items: UploadItem[] = [];
    const skipped: { name: string; reason: string }[] = [];
    const reasonText: Record<string, string> = { directory_or_junk: 'skipped (folder/system file)', unsupported_type: 'unsupported type', too_large: 'over 50 MB' };
    const note = (r: CandidateResult & { ok: false }) => skipped.push({ name: r.path.split('/').pop() ?? r.path, reason: reasonText[r.reason] ?? 'skipped' });

    for (const file of files) {
      if (isZip(file)) {
        const { default: JSZip } = await import('jszip');
        const zip = await JSZip.loadAsync(file);
        const entries = Object.values(zip.files);
        for (const entry of entries) {
          const metaSize = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
          const cls = classifyEntry({ path: entry.name, sizeBytes: metaSize, isDir: entry.dir });
          if (!cls.ok) { note(cls); continue; }
          // Realize the blob, then re-check size against the true byte length (zip metadata can be
          // missing/zero in some JSZip builds).
          const blob = await entry.async('blob');
          const recheck = classifyEntry({ path: entry.name, sizeBytes: blob.size, isDir: entry.dir });
          if (!recheck.ok) { note(recheck); continue; }
          items.push({ filename: recheck.candidate.path, contentType: recheck.candidate.contentType, sizeBytes: blob.size, blob });
        }
      } else {
        const cls = classifyEntry({ path: file.name, sizeBytes: file.size, explicitType: file.type });
        if (!cls.ok) { note(cls); continue; }
        items.push({ filename: cls.candidate.path, contentType: cls.candidate.contentType, sizeBytes: file.size, blob: file });
      }
    }
    return { items, skipped };
  }

  // Batch driver: validate the case, expand the selection, then upload sequentially with progress.
  async function onFiles(fileList: FileList | null) {
    const files = fileList ? Array.from(fileList) : [];
    if (files.length === 0) return;
    if (!caseId) { setStatus('Create or select a case before uploading.'); return; }
    setBusy(true);
    try {
      setStatus('Reading selection…');
      const { items, skipped } = await expandSelection(files);
      if (items.length === 0) { setStatus(`Nothing to upload — ${skipped.length} skipped (unsupported/too large).`); return; }
      let uploaded = 0; const failed: { name: string; reason: string }[] = [];
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (!item) continue;
        setStatus(`Uploading ${i + 1} of ${items.length}… (${item.filename})`);
        try { await uploadOne(item); uploaded += 1; }
        catch (err) { failed.push({ name: item.filename, reason: uploadErrorReason(err) }); }
      }
      const parts = [`${uploaded} uploaded`];
      if (skipped.length > 0) parts.push(`${skipped.length} skipped (unsupported/too large)`);
      // Surface the actual per-file failure reason — an upload that fails silently is the same
      // as "I uploaded but see nothing." Show the real cause so the RN can act on it.
      if (failed.length > 0) parts.push(`${failed.length} failed — ${failed.map((f) => `${f.name}: ${f.reason}`).join('; ')}`);
      setStatus(parts.join(', ') + '.');
      await onChange();
    } catch (err) {
      setStatus(`Upload failed: ${err instanceof Error ? err.message : 'unexpected error'}.`);
    } finally {
      setBusy(false);
    }
  }

  async function openDocument(id: string) { const res = await downloadDocument(id); window.open(res.data.downloadUrl, '_blank', 'noopener,noreferrer'); }
  return <div id="documents"><p className="text-sm text-slate-500">Upload one or more files, or a .zip — PDF, JPG, PNG, DOC, DOCX (max 50 MB each).</p><div className="mt-4 flex flex-col gap-3 sm:flex-row"><select className="input" value={caseId} onChange={(e) => setCaseId(e.target.value)}>{cases.map((c) => <option key={c.id} value={c.id}>{c.id} — {c.claimedCondition}</option>)}</select><select className="input" value={docTag} onChange={(e) => setDocTag(e.target.value)}>{DOC_TAGS.map((t) => <option key={t}>{t}</option>)}</select><input className="text-sm" type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.zip,application/pdf,image/jpeg,image/png,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/zip,application/x-zip-compressed" disabled={busy} onChange={(e) => { void onFiles(e.target.files); e.target.value = ''; }} /></div>{status ? <p className="mt-2 text-sm text-slate-500">{status}</p> : null}<div className="mt-4 divide-y divide-slate-100">{documents.map((d) => <button key={d.id} className="flex w-full justify-between py-3 text-left text-sm hover:bg-slate-50" onClick={() => void openDocument(d.id)}><span>{d.filename}</span><span className="text-slate-500">{d.docTag ?? 'Other'} · {d.uploadedAt}</span></button>)}</div></div>;
}
function CasesPanel({ rows }: { readonly rows: readonly Case[] }) { return <div><div className="divide-y divide-slate-100">{rows.map((c) => <Link key={c.id} className="flex justify-between py-3 text-sm hover:bg-slate-50" to={`/cases/${encodeURIComponent(c.id)}`}><span>{c.claimedCondition}</span><span className="text-slate-500">{c.status} · {c.claimType}</span></Link>)}</div>{!rows.length ? <EmptyState title="No claims yet" message="This veteran has no claims on file yet. Use “+ New claim” above to start one." /> : null}</div>; }
