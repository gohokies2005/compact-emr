import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AppShell } from '../../layout/AppShell';
import { Button } from '../../components/ui/Button';
import { TabBar, type TabItem } from '../../components/ui/TabBar';
import { EmptyState } from '../../components/ui/EmptyState';
import { deleteDocument, getVeteran, listDocuments, presignDocument, recordDocument, updateVeteran, uploadToPresignedUrl, type UpdateVeteranInput, type VeteranDetail } from '../../api/veterans';
import { PdfViewerModal } from '../../components/PdfViewerModal';
import { ConditionsPanel, MedicationsPanel, ProblemsPanel } from '../../components/ClinicalChartPanels';
import { ConflictError, describeApiError } from '../../api/client';
import { createCase, type CreateCaseInput } from '../../api/cases';
import { useAuth } from '../../auth/useAuth';
import { NewClaimModal } from '../cases/NewClaimModal';
import { ChartNotesPanel } from './ChartNotesPanel';
import { SHARED_TABS, type SharedTabId } from '../../lib/caseTabs';
import { classifyEntry, isZip, uploadErrorReason, type CandidateResult } from './documentUpload';
import { formatDateOnly, formatPhone, formatNameLastFirst } from '../../lib/format';
import type { Case, Document, Role } from '../../types/prisma';

const DOC_TAGS = ['STR', 'DBQ', 'C&P', 'Lay Statement', 'Other'];

// The chart mirrors the claim page's tabs (architect design 2026-06-08): a leading Claims tab (the
// veteran's claim list) followed by the SHARED vet-scoped sections (Documents + the clinical chart),
// sourced from the same SHARED_TABS list the claim page uses so the two can't drift. The claim-scoped
// tabs (Draft jobs / Clarifications / Email / Messages) are dropped — they belong to a claim, not a
// veteran. (Email-on-chart is intentionally NOT carried over: a vet-scope email/thread query is out of
// scope for this structural change.)
type ChartTab = 'claims' | SharedTabId;
const CHART_TABS: readonly TabItem<ChartTab>[] = [
  { id: 'claims', label: 'Claims' },
  ...SHARED_TABS,
];

export function VeteranChart() {
  const { id } = useParams();
  const veteranId = id ?? '';
  const [tab, setTab] = useState<ChartTab>('claims');
  const [claimModalOpen, setClaimModalOpen] = useState(false);
  const { user } = useAuth();
  const role: Role = user?.role ?? 'ops_staff';
  const qc = useQueryClient();
  const createClaim = useMutation({ mutationFn: (input: CreateCaseInput) => createCase(veteranId, input), onSuccess: async () => { setClaimModalOpen(false); await Promise.all([qc.invalidateQueries({ queryKey: ['veteran', veteranId] }), qc.invalidateQueries({ queryKey: ['documents', veteranId] })]); } });
  const veteran = useQuery({ queryKey: ['veteran', veteranId], queryFn: () => getVeteran(veteranId), enabled: veteranId.length > 0 });
  const documents = useQuery({ queryKey: ['documents', veteranId], queryFn: () => listDocuments(veteranId), enabled: veteranId.length > 0 });
  const invalidate = async () => { await Promise.all([qc.invalidateQueries({ queryKey: ['veteran', veteranId] }), qc.invalidateQueries({ queryKey: ['documents', veteranId] })]); };

  if (veteran.isLoading) return <AppShell><div className="text-sm text-slate-500">Loading veteran…</div></AppShell>;
  if (!veteran.data) return <AppShell><EmptyState title="Veteran not found" message="The requested veteran could not be loaded." /></AppShell>;
  const v = veteran.data.data;
  return <AppShell><div className="space-y-6">
    <div className="rounded-lg border border-slate-200 bg-white p-6"><div className="flex flex-col justify-between gap-3 sm:flex-row"><div><h1 className="text-3xl font-bold text-slate-900">{formatNameLastFirst(v.firstName, v.lastName)}</h1><p className="mt-1 text-xs text-slate-400">MRN {v.id}{v.dob ? ` · age ${Math.floor((Date.now() - Date.parse(v.dob)) / 31557600000)}` : ''}</p></div><div className="flex items-center gap-3"><Button size="sm" onClick={() => setClaimModalOpen(true)}>+ New claim</Button><Link className="text-sm text-indigo-600" to="/veterans">Back to veterans</Link></div></div><VeteranDemographics v={v} role={role} onSaved={invalidate} /></div>
    <div className="rounded-lg border border-slate-200 bg-white">
      <TabBar tabs={CHART_TABS} active={tab} onChange={setTab} className="flex-wrap" />
      {/* All six panels stay mounted; we toggle visibility with `hidden` rather than
          conditionally mounting. Conditional mount would unmount DocumentsPanel on a tab
          switch and silently drop an in-flight upload's status/error line — the upload path
          was hardened specifically to surface that reason, so we must not lose it. */}
      <div className="p-4">
        <div role="tabpanel" hidden={tab !== 'claims'}><CasesPanel rows={v.cases} /></div>
        <div role="tabpanel" hidden={tab !== 'documents'}><DocumentsPanel veteranId={veteranId} cases={v.cases} documents={documents.data?.data ?? []} onChange={invalidate} /></div>
        <div role="tabpanel" hidden={tab !== 'conditions'}><ConditionsPanel veteranId={veteranId} rows={v.scConditions} onChange={invalidate} /></div>
        <div role="tabpanel" hidden={tab !== 'problems'}><ProblemsPanel veteranId={veteranId} rows={v.activeProblems} onChange={invalidate} /></div>
        <div role="tabpanel" hidden={tab !== 'medications'}><MedicationsPanel veteranId={veteranId} rows={v.activeMedications} onChange={invalidate} /></div>
        <div role="tabpanel" hidden={tab !== 'notes'}><ChartNotesPanel veteranId={veteranId} /></div>
      </div>
    </div>
    <NewClaimModal open={claimModalOpen} onClose={() => setClaimModalOpen(false)} onSubmit={(input) => createClaim.mutateAsync(input).then(() => undefined)} saving={createClaim.isPending} />
  </div></AppShell>;
}


interface UploadItem { readonly filename: string; readonly contentType: string; readonly sizeBytes: number; readonly blob: Blob; }

function DocumentsPanel({ veteranId, cases, documents, onChange }: { readonly veteranId: string; readonly cases: readonly Case[]; readonly documents: readonly Document[]; readonly onChange: () => Promise<void> }) {
  const [caseId, setCaseId] = useState(cases[0]?.id ?? ''); const [docTag, setDocTag] = useState('Other'); const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [viewDoc, setViewDoc] = useState<Document | null>(null); // in-page PDF viewer
  // Delete a misuploaded file (Ryan 2026-06-04). Removes the file + its parsed text from the
  // veteran's chart for ALL claims (the drafter bundle is veteran-wide), so the confirm is explicit.
  const del = useMutation({ mutationFn: deleteDocument, onSuccess: onChange, onError: () => window.alert('Could not delete the file. Please retry.') });

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

  return <div id="documents"><p className="text-sm text-slate-500">Upload one or more files, or a .zip — PDF, JPG, PNG, DOC, DOCX (max 50 MB each).</p><div className="mt-4 flex flex-col gap-3 sm:flex-row"><select className="input" value={caseId} onChange={(e) => setCaseId(e.target.value)}>{cases.map((c) => <option key={c.id} value={c.id}>{c.id} — {c.claimedCondition}</option>)}</select><select className="input" value={docTag} onChange={(e) => setDocTag(e.target.value)}>{DOC_TAGS.map((t) => <option key={t}>{t}</option>)}</select><input className="text-sm" type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.zip,application/pdf,image/jpeg,image/png,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/zip,application/x-zip-compressed" disabled={busy} onChange={(e) => { void onFiles(e.target.files); e.target.value = ''; }} /></div>{status ? <p className="mt-2 text-sm text-slate-500">{status}</p> : null}<div className="mt-4 divide-y divide-slate-100">{documents.map((d) => <div key={d.id} className="flex items-center justify-between gap-3 py-3 text-sm"><button className="flex flex-1 items-center justify-between gap-3 text-left hover:bg-slate-50" onClick={() => setViewDoc(d)}><span>{d.filename}</span><span className="text-slate-500">{d.docTag ?? 'Other'} · {d.uploadedAt}{(d as { caseId?: string }).caseId ? ` · ${(d as { caseId?: string }).caseId}` : ''}</span></button><button type="button" className="shrink-0 rounded px-2 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50" disabled={del.isPending} onClick={() => { if (window.confirm(`Delete "${d.filename}"? This removes the file and its parsed text from this veteran's chart for ALL of their claims. Use this only for a file uploaded to the wrong chart.`)) del.mutate(d.id); }}>Delete</button></div>)}</div><PdfViewerModal doc={viewDoc} onClose={() => setViewDoc(null)} /></div>;
}
// FRN claims: clicking a claim row OPENS it (that's the instinct — Ryan 2026-06-06). Editing the
// claimed condition lives on the claim's own page (click the condition under the patient's name there),
// NOT here — making the title edit-in-place surprised people who expected it to open the claim.
function CasesPanel({ rows }: { readonly rows: readonly Case[] }) {
  if (!rows.length) return <EmptyState title="No claims yet" message="This veteran has no claims on file yet. Use “+ New claim” above to start one." />;
  return <div className="divide-y divide-slate-100">{rows.map((c) => (
    <Link key={c.id} className="flex items-center justify-between gap-3 px-1 py-3 text-sm hover:bg-slate-50" to={`/cases/${encodeURIComponent(c.id)}`}>
      <span className="font-medium text-slate-800">{c.claimedCondition}</span>
      <span className="text-slate-500">{c.status} · {c.claimType} <span className="text-indigo-600">→</span></span>
    </Link>
  ))}</div>;
}

// Editable veteran demographics grid (Ryan 2026-06-06: "click on it and change it" — a typo in DOB,
// email, height, etc. shouldn't force a whole new chart). Each field PATCHes ONE column with the row
// version (optimistic concurrency); the parent refetch bumps v.version for the next edit. Name + DOB
// are ADMIN-ONLY — the backend enforces it (veteran-validation ADMIN_ONLY_FIELDS); the UI mirrors that
// so a non-admin sees them read-only instead of hitting a 403.
function VeteranDemographics({ v, role, onSaved }: { readonly v: VeteranDetail; readonly role: Role; readonly onSaved: () => Promise<void> }) {
  const isAdmin = role === 'admin';
  // The backend PATCH /veterans/:id is gated to OPS_ROLES — a physician can VIEW the chart but cannot
  // edit demographics (every save would 403). Gate the edit affordance on the same role set so a
  // physician sees read-only values instead of a dead "click to edit" that errors. (architect QA)
  const canEdit = isAdmin || role === 'ops_staff';
  const save = useMutation({
    mutationFn: (input: UpdateVeteranInput) => updateVeteran(v.id, input),
    onSuccess: () => onSaved(),
    onError: async (e: unknown) => {
      if (e instanceof ConflictError) { await onSaved(); window.alert('This veteran was updated elsewhere. Reloaded — please retry your edit.'); }
      else window.alert(`Could not save — ${describeApiError(e)}`);
    },
  });
  // Cast is needed because UpdateVeteranInput types the numeric fields as `number` (no null), but the
  // backend accepts null to CLEAR height/weight. The cast is sound — the backend validates the shape.
  const patch = (field: string, value: string | number | null) => save.mutate({ version: v.version, [field]: value } as UpdateVeteranInput);
  const reqStr = (field: 'firstName' | 'lastName' | 'email', label: string) => (raw: string) => { const t = raw.trim(); if (!t) { window.alert(`${label} cannot be empty.`); return; } patch(field, t); };
  const optStr = (field: 'phone' | 'address' | 'branch') => (raw: string) => patch(field, raw.trim()); // '' → backend stores null
  const yearReq = (field: 'serviceStartYear' | 'serviceEndYear') => (raw: string) => { const t = raw.trim(); if (!t) return; if (!/^\d{4}$/.test(t)) { window.alert('Enter a 4-digit year (e.g. 2008).'); return; } patch(field, Number.parseInt(t, 10)); };
  const intNul = (field: 'heightIn' | 'weightLb', label: string) => (raw: string) => { const t = raw.trim(); if (!t) { patch(field, null); return; } const n = Number.parseInt(t, 10); if (Number.isNaN(n) || n < 0) { window.alert(`${label} must be a positive whole number.`); return; } patch(field, n); };
  const onDob = (raw: string) => { const t = raw.trim(); if (!t) { window.alert('DOB cannot be empty.'); return; } patch('dob', t); };

  const ht = v.heightIn != null ? `${Math.floor(v.heightIn / 12)}'${v.heightIn % 12}"` : '';
  return (
    <div className="mt-4 grid grid-cols-1 gap-x-10 gap-y-0.5 border-t border-slate-100 pt-4 sm:grid-cols-2">
      <InlineField label="First name" value={v.firstName} editable={isAdmin} saving={save.isPending} onSave={reqStr('firstName', 'First name')} />
      <InlineField label="Last name" value={v.lastName} editable={isAdmin} saving={save.isPending} onSave={reqStr('lastName', 'Last name')} />
      <InlineField label="DOB" type="date" value={formatDateOnly(v.dob)} display={v.dob ? formatDateOnly(v.dob) : ''} editable={isAdmin} saving={save.isPending} onSave={onDob} />
      <InlineField label="Email" value={v.email ?? ''} editable={canEdit} saving={save.isPending} onSave={reqStr('email', 'Email')} />
      <InlineField label="Phone" value={v.phone ?? ''} display={v.phone ? formatPhone(v.phone) : ''} editable={canEdit} saving={save.isPending} onSave={optStr('phone')} />
      <InlineField label="Address" value={v.address ?? ''} editable={canEdit} saving={save.isPending} onSave={optStr('address')} />
      <InlineField label="Branch" value={v.branch ?? ''} editable={canEdit} saving={save.isPending} onSave={optStr('branch')} />
      <InlineField label="Service start" type="number" value={v.serviceStartYear != null ? String(v.serviceStartYear) : ''} editable={canEdit} saving={save.isPending} onSave={yearReq('serviceStartYear')} />
      <InlineField label="Service end" type="number" value={v.serviceEndYear != null ? String(v.serviceEndYear) : ''} editable={canEdit} saving={save.isPending} onSave={yearReq('serviceEndYear')} />
      <InlineField label="Height (in)" type="number" value={v.heightIn != null ? String(v.heightIn) : ''} display={ht} editable={canEdit} saving={save.isPending} onSave={intNul('heightIn', 'Height')} />
      <InlineField label="Weight (lb)" type="number" value={v.weightLb != null ? String(v.weightLb) : ''} display={v.weightLb != null ? `${v.weightLb} lb` : ''} editable={canEdit} saving={save.isPending} onSave={intNul('weightLb', 'Weight')} />
      {/* Claim-relevant flags (combat 1154(b), PACT presumptives, TERA) — captured at intake + fed to the
          drafter; now visible + correctable here (audit 2026-06-07: they were write-only). */}
      <InlineSelect label="Combat veteran" value={v.combatVeteran ?? ''} editable={canEdit} saving={save.isPending} onSave={(val) => patch('combatVeteran', val)} />
      <InlineSelect label="PACT area" value={v.pactArea ?? ''} editable={canEdit} saving={save.isPending} onSave={(val) => patch('pactArea', val)} />
      <InlineSelect label="TERA conceded" value={v.teraConceded ?? ''} editable={canEdit} saving={save.isPending} onSave={(val) => patch('teraConceded', val)} />
    </div>
  );
}

// Compact click-to-edit field. `value` = the RAW editable string; `display` = the formatted read view
// (phone, height, DOB). Non-editable fields render as plain text (admin-only demographics).
function InlineField({ label, value, display, type = 'text', editable = true, saving, onSave }: {
  readonly label: string;
  readonly value: string;
  readonly display?: string;
  readonly type?: 'text' | 'number' | 'date';
  readonly editable?: boolean;
  readonly saving: boolean;
  readonly onSave: (raw: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  function commit() { onSave(draft); setEditing(false); }
  return (
    <div className="flex items-baseline gap-2 py-1">
      <span className="w-28 shrink-0 text-xs font-medium uppercase tracking-wide text-slate-400">{label}</span>
      {editing ? (
        <span className="flex items-center gap-2">
          <input className="input h-7 w-44 py-0 text-sm" type={type} value={draft} autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }} />
          <button type="button" className="text-xs font-medium text-indigo-600 disabled:opacity-50" disabled={saving} onClick={commit}>Save</button>
          <button type="button" className="text-xs text-slate-400" onClick={() => setEditing(false)}>Cancel</button>
        </span>
      ) : editable ? (
        <button type="button" className="rounded px-1 text-left text-sm text-slate-700 decoration-dotted hover:bg-amber-50 hover:underline" title={`Click to edit ${label.toLowerCase()}`} onClick={() => { setDraft(value); setEditing(true); }}>
          {display || value || <span className="text-slate-300">— add</span>}
        </button>
      ) : (
        <span className="px-1 text-sm text-slate-500" title={`${label} — admin only`}>{display || value || '—'}</span>
      )}
    </div>
  );
}

// Click-to-edit Yes/No/Unknown field (combat / PACT / TERA flags). Same affordance as InlineField but a
// bounded enum so an RN can't free-type a value the drafter won't recognize.
function InlineSelect({ label, value, editable = true, saving, onSave }: {
  readonly label: string;
  readonly value: string; // 'yes' | 'no' | 'unknown' | ''
  readonly editable?: boolean;
  readonly saving: boolean;
  readonly onSave: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || 'unknown');
  function commit() { onSave(draft); setEditing(false); }
  const display = value ? value.charAt(0).toUpperCase() + value.slice(1) : '';
  return (
    <div className="flex items-baseline gap-2 py-1">
      <span className="w-28 shrink-0 text-xs font-medium uppercase tracking-wide text-slate-400">{label}</span>
      {editing ? (
        <span className="flex items-center gap-2">
          <select className="input h-7 w-44 py-0 text-sm" value={draft} autoFocus onChange={(e) => setDraft(e.target.value)}>
            <option value="yes">Yes</option>
            <option value="no">No</option>
            <option value="unknown">Unknown</option>
          </select>
          <button type="button" className="text-xs font-medium text-indigo-600 disabled:opacity-50" disabled={saving} onClick={commit}>Save</button>
          <button type="button" className="text-xs text-slate-400" onClick={() => setEditing(false)}>Cancel</button>
        </span>
      ) : editable ? (
        <button type="button" className="rounded px-1 text-left text-sm text-slate-700 decoration-dotted hover:bg-amber-50 hover:underline" title={`Click to edit ${label.toLowerCase()}`} onClick={() => { setDraft(value || 'unknown'); setEditing(true); }}>
          {display || <span className="text-slate-300">— add</span>}
        </button>
      ) : (
        <span className="px-1 text-sm text-slate-500">{display || '—'}</span>
      )}
    </div>
  );
}
