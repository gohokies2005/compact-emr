import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AppShell } from '../../layout/AppShell';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { addMedication, addProblem, addScCondition, deleteMedication, deleteProblem, deleteScCondition, downloadDocument, getVeteran, listDocuments, presignDocument, recordDocument, uploadToPresignedUrl } from '../../api/veterans';
import type { ActiveMedication, ActiveProblem, Case, Document, ScCondition } from '../../types/prisma';

const DOC_TAGS = ['STR', 'DBQ', 'C&P', 'Lay Statement', 'Other'];
const ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
const MAX_BYTES = 5 * 1024 * 1024;

export function VeteranChart() {
  const { id } = useParams();
  const veteranId = id ?? '';
  const [tab, setTab] = useState<'conditions' | 'problems' | 'medications'>('conditions');
  const qc = useQueryClient();
  const veteran = useQuery({ queryKey: ['veteran', veteranId], queryFn: () => getVeteran(veteranId), enabled: veteranId.length > 0 });
  const documents = useQuery({ queryKey: ['documents', veteranId], queryFn: () => listDocuments(veteranId), enabled: veteranId.length > 0 });
  const invalidate = async () => { await Promise.all([qc.invalidateQueries({ queryKey: ['veteran', veteranId] }), qc.invalidateQueries({ queryKey: ['documents', veteranId] })]); };

  if (veteran.isLoading) return <AppShell><div className="text-sm text-slate-500">Loading veteran…</div></AppShell>;
  if (!veteran.data) return <AppShell><EmptyState title="Veteran not found" message="The requested veteran could not be loaded." /></AppShell>;
  const v = veteran.data.data;
  return <AppShell><div className="space-y-6">
    <div className="rounded-lg border border-slate-200 bg-white p-6"><div className="flex flex-col justify-between gap-3 sm:flex-row"><div><h1 className="text-2xl font-semibold text-slate-900">{v.id}</h1><p className="text-sm text-slate-500">DOB {v.dob} · {v.branch} · {v.serviceStartYear}–{v.serviceEndYear}</p></div><Link className="text-sm text-indigo-600" to="/veterans">Back to veterans</Link></div></div>
    <div className="rounded-lg border border-slate-200 bg-white"><div className="flex border-b border-slate-200 text-sm">{(['conditions','problems','medications'] as const).map((t) => <button key={t} className={`px-4 py-3 ${tab === t ? 'border-b-2 border-indigo-600 text-indigo-600' : 'text-slate-500'}`} onClick={() => setTab(t)}>{t === 'conditions' ? 'Service-connected conditions' : t === 'problems' ? 'Active problems' : 'Medications'}</button>)}</div><div className="p-4">{tab === 'conditions' ? <ConditionsPanel veteranId={veteranId} rows={v.scConditions} onChange={invalidate} /> : null}{tab === 'problems' ? <ProblemsPanel veteranId={veteranId} rows={v.activeProblems} onChange={invalidate} /> : null}{tab === 'medications' ? <MedicationsPanel veteranId={veteranId} rows={v.activeMedications} onChange={invalidate} /> : null}</div></div>
    <DocumentsPanel veteranId={veteranId} cases={v.cases} documents={documents.data?.data ?? []} onChange={invalidate} />
    <CasesPanel rows={v.cases} />
  </div></AppShell>;
}

function ConditionsPanel({ veteranId, rows, onChange }: { readonly veteranId: string; readonly rows: readonly ScCondition[]; readonly onChange: () => Promise<void> }) {
  const [condition, setCondition] = useState(''); const [dcCode, setDcCode] = useState('');
  const add = useMutation({ mutationFn: () => addScCondition(veteranId, { condition, ...(dcCode && { dcCode }) }), onSuccess: async () => { setCondition(''); setDcCode(''); await onChange(); } });
  const del = useMutation({ mutationFn: deleteScCondition, onSuccess: onChange });
  return <div className="space-y-4"><div className="flex gap-2"><input className="input" placeholder="Condition" value={condition} onChange={(e) => setCondition(e.target.value)} /><input className="input" placeholder="DC code" value={dcCode} onChange={(e) => setDcCode(e.target.value)} /><Button size="sm" onClick={() => add.mutate()} disabled={!condition}>Add</Button></div><Rows rows={rows.map((r) => ({ id: r.id, cols: [r.condition, r.dcCode ?? '—', r.ratingPct?.toString() ?? '—'], onDelete: () => { if (window.confirm('Remove this SC condition?')) del.mutate(r.id); } }))} /></div>;
}
function ProblemsPanel({ veteranId, rows, onChange }: { readonly veteranId: string; readonly rows: readonly ActiveProblem[]; readonly onChange: () => Promise<void> }) {
  const [problem, setProblem] = useState(''); const add = useMutation({ mutationFn: () => addProblem(veteranId, { problem }), onSuccess: async () => { setProblem(''); await onChange(); } }); const del = useMutation({ mutationFn: deleteProblem, onSuccess: onChange });
  return <div className="space-y-4"><div className="flex gap-2"><input className="input" placeholder="Problem" value={problem} onChange={(e) => setProblem(e.target.value)} /><Button size="sm" onClick={() => add.mutate()} disabled={!problem}>Add</Button></div><Rows rows={rows.map((r) => ({ id: r.id, cols: [r.problem, r.notes ?? '—'], onDelete: () => { if (window.confirm('Remove this problem?')) del.mutate(r.id); } }))} /></div>;
}
function MedicationsPanel({ veteranId, rows, onChange }: { readonly veteranId: string; readonly rows: readonly ActiveMedication[]; readonly onChange: () => Promise<void> }) {
  const [drugName, setDrugName] = useState(''); const add = useMutation({ mutationFn: () => addMedication(veteranId, { drugName }), onSuccess: async () => { setDrugName(''); await onChange(); } }); const del = useMutation({ mutationFn: deleteMedication, onSuccess: onChange });
  return <div className="space-y-4"><div className="flex gap-2"><input className="input" placeholder="Medication" value={drugName} onChange={(e) => setDrugName(e.target.value)} /><Button size="sm" onClick={() => add.mutate()} disabled={!drugName}>Add</Button></div><Rows rows={rows.map((r) => ({ id: r.id, cols: [r.drugName, r.dose ?? '—', r.frequency ?? '—'], onDelete: () => { if (window.confirm('Remove this medication?')) del.mutate(r.id); } }))} /></div>;
}
function Rows({ rows }: { readonly rows: readonly { readonly id: string; readonly cols: readonly string[]; readonly onDelete: () => void }[] }) { if (!rows.length) return <EmptyState title="Nothing recorded yet" message="Add the first item above." />; return <div className="divide-y divide-slate-100">{rows.map((r) => <div className="flex items-center justify-between py-3 text-sm" key={r.id}><div className="flex gap-6 text-slate-700">{r.cols.map((c, i) => <span key={`${r.id}-${i}`}>{c}</span>)}</div><button className="text-rose-600" onClick={r.onDelete}>Delete</button></div>)}</div>; }

function DocumentsPanel({ veteranId, cases, documents, onChange }: { readonly veteranId: string; readonly cases: readonly Case[]; readonly documents: readonly Document[]; readonly onChange: () => Promise<void> }) {
  const [caseId, setCaseId] = useState(cases[0]?.id ?? ''); const [docTag, setDocTag] = useState('Other'); const [status, setStatus] = useState('');
  async function onFile(file: File | undefined) { if (!file) return; if (!ALLOWED_TYPES.includes(file.type)) { setStatus('Unsupported file type.'); return; } if (file.size > MAX_BYTES) { setStatus('File exceeds 5 MB.'); return; } if (!caseId) { setStatus('Create or select a case before uploading.'); return; } setStatus('Preparing upload…'); const presigned = await presignDocument(veteranId, { caseId, filename: file.name, contentType: file.type, sizeBytes: file.size }); setStatus('Uploading…'); await uploadToPresignedUrl(presigned.data.uploadUrl, file, presigned.data.requiredHeaders); await recordDocument(veteranId, { caseId, filename: file.name, contentType: file.type, sizeBytes: file.size, s3Key: presigned.data.s3Key, docTag }); setStatus('Uploaded.'); await onChange(); }
  async function openDocument(id: string) { const res = await downloadDocument(id); window.open(res.data.downloadUrl, '_blank', 'noopener,noreferrer'); }
  return <section className="rounded-lg border border-slate-200 bg-white p-6"><h2 className="text-lg font-semibold text-slate-900">Documents</h2><div className="mt-4 flex flex-col gap-3 sm:flex-row"><select className="input" value={caseId} onChange={(e) => setCaseId(e.target.value)}>{cases.map((c) => <option key={c.id} value={c.id}>{c.id} — {c.claimedCondition}</option>)}</select><select className="input" value={docTag} onChange={(e) => setDocTag(e.target.value)}>{DOC_TAGS.map((t) => <option key={t}>{t}</option>)}</select><input className="text-sm" type="file" onChange={(e) => void onFile(e.target.files?.[0])} /></div>{status ? <p className="mt-2 text-sm text-slate-500">{status}</p> : null}<div className="mt-4 divide-y divide-slate-100">{documents.map((d) => <button key={d.id} className="flex w-full justify-between py-3 text-left text-sm hover:bg-slate-50" onClick={() => void openDocument(d.id)}><span>{d.filename}</span><span className="text-slate-500">{d.docTag ?? 'Other'} · {d.uploadedAt}</span></button>)}</div></section>;
}
function CasesPanel({ rows }: { readonly rows: readonly Case[] }) { return <section className="rounded-lg border border-slate-200 bg-white p-6"><h2 className="text-lg font-semibold text-slate-900">Cases</h2><div className="mt-4 divide-y divide-slate-100">{rows.map((c) => <Link key={c.id} className="flex justify-between py-3 text-sm hover:bg-slate-50" to={`/cases/${encodeURIComponent(c.id)}`}><span>{c.claimedCondition}</span><span className="text-slate-500">{c.status} · {c.claimType}</span></Link>)}</div>{!rows.length ? <EmptyState title="No cases yet" message="Case detail ships in Phase 4." /> : null}</section>; }
