import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { AppShell } from '../../layout/AppShell';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { CASE_STATUS_LABELS } from '../../lib/caseStatus';
import { formatRelativeTime } from '../../lib/date';
import { listCases, deleteCase, restoreCase, updateQuickNote, type CaseLite } from '../../api/cases';
import { describeApiError } from '../../api/client';
import { listVeterans } from '../../api/veterans';
import type { CaseStatus, ClaimType } from '../../types/prisma';
import { useColumnSort, type ColType } from '../../lib/useColumnSort';
import { exportRowsToCsv } from '../../lib/csv';
import { formatConditionLabel } from '../../lib/conditionLabel';
import { formatNameLastFirst } from '../../lib/format';

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => { const t = window.setTimeout(() => setDebounced(value), ms); return () => window.clearTimeout(t); }, [value, ms]);
  return debounced;
}

const CLAIM_TYPE_LABELS: Record<ClaimType, string> = { initial: 'Initial', supplemental: 'Supplemental', hlr: 'Higher-level review', appeal_bva: 'Board appeal' };
const STATUS_OPTIONS = Object.entries(CASE_STATUS_LABELS) as [CaseStatus, string][];
const CLAIM_TYPE_OPTIONS = Object.entries(CLAIM_TYPE_LABELS) as [ClaimType, string][];
const PAGE_SIZES = [25, 50, 100];
const CASE_COLUMNS: readonly { readonly key: string; readonly label: string }[] = [
  { key: 'id', label: 'Case' }, { key: 'veteran', label: 'Veteran' }, { key: 'condition', label: 'Condition' },
  { key: 'type', label: 'Type' }, { key: 'status', label: 'Status' }, { key: 'records', label: 'Records' }, { key: 'note', label: 'Note' }, { key: 'physician', label: 'Physician' }, { key: 'rn', label: 'RN' }, { key: 'submitted', label: 'Submitted' }, { key: 'updated', label: 'Updated' }, { key: 'version', label: 'v' },
];
const caseSortType = (key: string): ColType => (key === 'updated' || key === 'submitted' ? 'date' : key === 'version' || key === 'records' ? 'number' : 'text');
const caseSortValue = (key: string) => (c: CaseLite): unknown => {
  switch (key) {
    case 'id': return c.id;
    case 'veteran': return c.veteran ? `${c.veteran.lastName} ${c.veteran.firstName}` : c.veteranId; // sort by LAST name
    case 'condition': return c.claimedCondition;
    case 'type': return CLAIM_TYPE_LABELS[c.claimType];
    case 'status': return CASE_STATUS_LABELS[c.status];
    case 'records': return c.recordsUploaded ? 1 : 0; // sort: records-in (1) vs awaiting (0)
    case 'note': return c.quickNote ?? '';
    case 'physician': return c.assignedPhysician?.fullName ?? '';
    case 'rn': return c.assignedRn?.email ?? '';
    case 'submitted': return c.createdAt;
    case 'updated': return c.updatedAt;
    case 'version': return c.version;
    default: return '';
  }
};

export function CasesPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<CaseStatus | ''>('');
  const [claimType, setClaimType] = useState<ClaimType | ''>('');
  const [vetQuery, setVetQuery] = useState('');
  const [veteran, setVeteran] = useState<{ id: string; label: string } | null>(null);
  const [archived, setArchived] = useState(false); // show the Archive (soft-deleted claims)
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const debouncedVet = useDebounced(vetQuery, 300);
  // Reset to page 1 whenever a filter changes.
  useEffect(() => { setPage(1); }, [status, claimType, veteran?.id, pageSize, archived]);

  const vetMatches = useQuery({
    queryKey: ['veteran-search', debouncedVet],
    queryFn: () => listVeterans(debouncedVet),
    enabled: debouncedVet.trim().length > 0 && veteran === null,
  });

  const cases = useQuery({
    queryKey: ['cases', { status, claimType, veteranId: veteran?.id ?? '', archived, page, pageSize }],
    queryFn: () => listCases({
      ...(status && { status }),
      ...(claimType && { claimType }),
      ...(veteran && { veteranId: veteran.id }),
      ...(archived && { archived: true }),
      page,
      pageSize,
    }),
  });

  function clearFilters() { setStatus(''); setClaimType(''); setVetQuery(''); setVeteran(null); setArchived(false); }
  const total = cases.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const qc = useQueryClient();
  // Archive (soft-delete, reversible) a claim — clean up a mis-assigned / duplicate one. Restorable.
  const archiveMut = useMutation({
    mutationFn: (id: string) => deleteCase(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['cases'] }); },
    onError: (e: unknown) => window.alert(`Could not archive this claim — ${describeApiError(e)}`),
  });
  const restoreMut = useMutation({
    mutationFn: (id: string) => restoreCase(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['cases'] }); },
    onError: (e: unknown) => window.alert(`Could not restore this claim — ${describeApiError(e)}`),
  });

  // Feature A quick-note popup (Epic/Cerner-style scratch note on the row).
  const [noteCase, setNoteCase] = useState<CaseLite | null>(null);
  const quickNoteMut = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) => updateQuickNote(id, note),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['cases'] }); setNoteCase(null); },
    onError: (e: unknown) => window.alert(`Could not save the note — ${describeApiError(e)}`),
  });

  const { onHeaderClick, sortRows, ariaSort, indicator } = useColumnSort();
  const pageRows = cases.data?.data ?? [];
  const rows = sortRows(pageRows, caseSortValue, caseSortType);
  const pageTruncated = total > pageRows.length;
  function exportCsv() {
    // Cases is server-paginated, so this exports the CURRENT page only (after filters + sort).
    if (pageTruncated) console.warn(`cases CSV export: current page only (${pageRows.length} of ${total}); backend full-export is a follow-up.`);
    const headers = ['Case ID', 'Veteran', 'Condition', 'Type', 'Status', 'Records', 'Physician', 'RN', 'Submitted', 'Updated', 'Version'];
    const matrix = rows.map((c) => [
      c.id, c.veteran ? `${c.veteran.lastName}, ${c.veteran.firstName}` : c.veteranId, c.claimedCondition,
      CLAIM_TYPE_LABELS[c.claimType], CASE_STATUS_LABELS[c.status], c.recordsUploaded ? 'Received' : 'Pending', c.assignedPhysician?.fullName ?? '', c.assignedRn?.email ?? '', c.createdAt, c.updatedAt, c.version,
    ]);
    exportRowsToCsv(`cases-export-${new Date().toISOString().slice(0, 10)}.csv`, headers, matrix);
  }

  return <AppShell><div className="space-y-6">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div><h1 className="text-2xl font-semibold text-slate-900">Cases</h1><p className="text-sm text-slate-500">Browse and filter claims across all veterans.</p></div>
      <Button variant="secondary" onClick={exportCsv} disabled={rows.length === 0}>Export to Excel</Button>
    </div>

    <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
      <label className="block text-sm lg:w-56"><span className="mb-1 block font-medium text-slate-700">Status</span>
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value as CaseStatus | '')}><option value="">All statuses</option>{STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      </label>
      <label className="block text-sm lg:w-56"><span className="mb-1 block font-medium text-slate-700">Claim type</span>
        <select className="input" value={claimType} onChange={(e) => setClaimType(e.target.value as ClaimType | '')}><option value="">All claim types</option>{CLAIM_TYPE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      </label>
      <div className="relative block text-sm lg:flex-1">
        <span className="mb-1 block font-medium text-slate-700">Veteran</span>
        {veteran
          ? <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2"><span className="text-slate-900">{veteran.label}</span><button type="button" className="text-xs text-indigo-600" onClick={() => { setVeteran(null); setVetQuery(''); }}>Clear</button></div>
          : <input className="input" aria-label="Search veterans" placeholder="Search veteran by name or ID…" value={vetQuery} onChange={(e) => setVetQuery(e.target.value)} />}
        {!veteran && debouncedVet.trim() && vetMatches.data && vetMatches.data.data.length > 0
          ? <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">{vetMatches.data.data.slice(0, 5).map((v) => <li key={v.id}><button type="button" className="flex w-full justify-between px-3 py-2 text-left hover:bg-slate-50" onClick={() => { setVeteran({ id: v.id, label: `${formatNameLastFirst(v.firstName, v.lastName)} (${v.id})` }); }}><span>{formatNameLastFirst(v.firstName, v.lastName)}</span><span className="text-slate-500">{v.dob?.slice(0, 4) ?? ''}</span></button></li>)}</ul>
          : null}
      </div>
      <label className="flex items-center gap-2 text-sm lg:pb-2"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Show archived</label>
      <Button variant="secondary" onClick={clearFilters}>Clear filters</Button>
    </div>

    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500"><tr>
          {CASE_COLUMNS.map((col) => { const centered = col.key === 'status' || col.key === 'records'; return <th key={col.key} className="px-4 py-3" aria-sort={ariaSort(col.key)}>
            <button type="button" className={`flex items-center gap-1 uppercase tracking-wide hover:text-slate-700${centered ? ' mx-auto' : ''}`} onClick={() => onHeaderClick(col.key)}>{col.label}{indicator(col.key)}</button>
          </th>; })}
          <th className="px-4 py-3" />
        </tr></thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((c) => <tr key={c.id} className="cursor-pointer hover:bg-slate-50" onClick={() => navigate(`/cases/${encodeURIComponent(c.id)}`)}>
            <td className="px-4 py-3 font-medium"><Link className="text-indigo-600" to={`/cases/${encodeURIComponent(c.id)}`} onClick={(e) => e.stopPropagation()}>{c.id}</Link></td>
            <td className="px-4 py-3 text-slate-600"><Link className="hover:text-indigo-600" to={`/veterans/${encodeURIComponent(c.veteranId)}`} onClick={(e) => e.stopPropagation()}>{formatNameLastFirst(c.veteran?.firstName, c.veteran?.lastName, c.veteranId)}</Link></td>
            <td className="px-4 py-3 text-slate-700">{formatConditionLabel(c.claimedCondition)}</td>
            <td className="px-4 py-3 text-slate-600">{CLAIM_TYPE_LABELS[c.claimType]}</td>
            <td className="px-4 py-3 text-center"><span className="text-xs font-medium text-slate-600">{CASE_STATUS_LABELS[c.status]}</span></td>
            <td className="px-4 py-3 text-center"><RecordsChip recordsUploaded={c.recordsUploaded} /></td>
            <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
              {c.quickNote ? (
                <button type="button" title={c.quickNote} aria-label={`Quick note: ${c.quickNote}`} className="text-amber-500 hover:text-amber-600" onClick={() => setNoteCase(c)}>
                  <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4"><path d="M4 3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7l-4-4H4zm9 1.5L16.5 8H13V4.5zM5 9h8v1.5H5V9zm0 3h6v1.5H5V12z"/></svg>
                </button>
              ) : (
                <button type="button" aria-label="Add quick note" title="Add a quick note" className="text-base leading-none text-slate-300 hover:text-indigo-600" onClick={() => setNoteCase(c)}>+</button>
              )}
            </td>
            <td className="px-4 py-3 text-slate-600">{c.assignedPhysician?.fullName ?? '—'}</td>
            <td className="px-4 py-3 text-slate-500">{c.assignedRn?.email ?? '—'}</td>
            <td className="px-4 py-3 text-slate-500" title={new Date(c.createdAt).toLocaleString()}>{formatRelativeTime(c.createdAt)}</td>
            <td className="px-4 py-3 text-slate-500">{formatRelativeTime(c.updatedAt)}</td>
            <td className="px-4 py-3 text-slate-400">{c.version}</td>
            <td className="px-4 py-3 text-right whitespace-nowrap">
              {archived ? (
                <button type="button" className="text-xs font-medium text-indigo-600 hover:text-indigo-700 disabled:opacity-50" disabled={restoreMut.isPending}
                  onClick={(e) => { e.stopPropagation(); restoreMut.mutate(c.id); }}>Restore</button>
              ) : (
                <button type="button" className="text-xs font-medium text-rose-600 hover:text-rose-700 disabled:opacity-50" disabled={archiveMut.isPending}
                  onClick={(e) => { e.stopPropagation(); if (window.confirm(`Archive claim ${c.id} (${formatConditionLabel(c.claimedCondition)})? It's hidden from the list but kept and can be Restored from "Show archived".`)) archiveMut.mutate(c.id); }}
                >Archive</button>
              )}
            </td>
          </tr>)}
        </tbody>
      </table>
      {cases.isLoading ? <div className="p-6 text-sm text-slate-500">Loading cases…</div> : null}
      {!cases.isLoading && total === 0 ? <EmptyState title="No cases found" message="Adjust the filters or create a claim from a veteran chart." /> : null}
    </div>

    <div className="flex flex-col items-center justify-between gap-3 text-sm text-slate-600 sm:flex-row">
      <div>{total} case{total === 1 ? '' : 's'} · page {page} of {totalPages}{pageTruncated ? ' · export covers this page only' : ''}</div>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2">Per page<select className="input w-auto" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>{PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
        <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</Button>
        <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next</Button>
      </div>
    </div>

    {noteCase ? (
      <QuickNotePopup
        c={noteCase}
        saving={quickNoteMut.isPending}
        onClose={() => setNoteCase(null)}
        onSave={(note) => quickNoteMut.mutate({ id: noteCase.id, note })}
      />
    ) : null}
  </div></AppShell>;
}

// RECORDS chip: binary "veteran-uploaded records present" signal. "Records in" once the case has
// >=1 real uploaded document (Stage 2 done); "Awaiting records" while we're still Stage-1-only.
// NEUTRAL by design (Ryan 2026-06-08, "christmas tree") — the Cases list deliberately drops the
// green/amber fills and renders calm centered slate text; the label still carries the meaning.
// `undefined` (older API response without the field) renders as awaiting — the conservative default.
function RecordsChip({ recordsUploaded }: { readonly recordsUploaded: boolean | undefined }) {
  return recordsUploaded
    ? <span className="text-xs font-medium text-slate-600" title="At least one veteran-uploaded record is on file (Stage 2 complete).">Received</span>
    : <span className="text-xs font-medium text-slate-500" title="No uploaded records yet — waiting on the veteran's files (Stage-1 only).">Pending</span>;
}

// Epic/Cerner-style quick-note popup: overwrite scratchpad + a last-editor stamp. "Delete" clears it
// (sends an empty note). This is the QUICK layer — the official record lives in the chart's Notes.
function QuickNotePopup({ c, saving, onClose, onSave }: { readonly c: CaseLite; readonly saving: boolean; readonly onClose: () => void; readonly onSave: (note: string) => void }) {
  const [draft, setDraft] = useState(c.quickNote ?? '');
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 p-6" onClick={onClose}>
      <div className="mx-auto mt-32 max-w-sm rounded-lg bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-900">Quick note · {c.id}</h2>
          <button type="button" className="text-slate-400 hover:text-slate-600" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <p className="mt-0.5 text-xs text-slate-500">At-a-glance status. For the official record, use the chart’s Notes.</p>
        <textarea className="input mt-3 min-h-24 w-full text-sm" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="e.g. Waiting on records · rejected, refund offered" />
        {c.quickNoteBy ? <p className="mt-1 text-xs text-slate-400">Last edited by {c.quickNoteBy}{c.quickNoteAt ? ` · ${formatRelativeTime(c.quickNoteAt)}` : ''}</p> : null}
        <div className="mt-4 flex items-center justify-between">
          <button type="button" className="text-xs font-medium text-rose-600 hover:text-rose-700 disabled:opacity-40" disabled={saving || !c.quickNote} onClick={() => onSave('')}>Delete</button>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
            <Button variant="primary" size="sm" loading={saving} onClick={() => onSave(draft)}>Save</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
