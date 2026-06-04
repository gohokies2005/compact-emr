import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AppShell } from '../../layout/AppShell';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { CaseStatusBadge } from '../../components/ui/CaseStatusBadge';
import { CASE_STATUS_LABELS } from '../../lib/caseStatus';
import { formatRelativeTime } from '../../lib/date';
import { listCases, type CaseLite } from '../../api/cases';
import { listVeterans } from '../../api/veterans';
import type { CaseStatus, ClaimType } from '../../types/prisma';
import { useColumnSort, type ColType } from '../../lib/useColumnSort';
import { exportRowsToCsv } from '../../lib/csv';

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
  { key: 'type', label: 'Type' }, { key: 'status', label: 'Status' }, { key: 'updated', label: 'Updated' }, { key: 'version', label: 'v' },
];
const caseSortType = (key: string): ColType => (key === 'updated' ? 'date' : key === 'version' ? 'number' : 'text');
const caseSortValue = (key: string) => (c: CaseLite): unknown => {
  switch (key) {
    case 'id': return c.id;
    case 'veteran': return c.veteran ? `${c.veteran.firstName} ${c.veteran.lastName}` : c.veteranId;
    case 'condition': return c.claimedCondition;
    case 'type': return CLAIM_TYPE_LABELS[c.claimType];
    case 'status': return CASE_STATUS_LABELS[c.status];
    case 'updated': return c.updatedAt;
    case 'version': return c.version;
    default: return '';
  }
};

export function CasesPage() {
  const [status, setStatus] = useState<CaseStatus | ''>('');
  const [claimType, setClaimType] = useState<ClaimType | ''>('');
  const [vetQuery, setVetQuery] = useState('');
  const [veteran, setVeteran] = useState<{ id: string; label: string } | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const debouncedVet = useDebounced(vetQuery, 300);
  // Reset to page 1 whenever a filter changes.
  useEffect(() => { setPage(1); }, [status, claimType, veteran?.id, pageSize]);

  const vetMatches = useQuery({
    queryKey: ['veteran-search', debouncedVet],
    queryFn: () => listVeterans(debouncedVet),
    enabled: debouncedVet.trim().length > 0 && veteran === null,
  });

  const cases = useQuery({
    queryKey: ['cases', { status, claimType, veteranId: veteran?.id ?? '', page, pageSize }],
    queryFn: () => listCases({
      ...(status && { status }),
      ...(claimType && { claimType }),
      ...(veteran && { veteranId: veteran.id }),
      page,
      pageSize,
    }),
  });

  function clearFilters() { setStatus(''); setClaimType(''); setVetQuery(''); setVeteran(null); }
  const total = cases.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const { onHeaderClick, sortRows, ariaSort, indicator } = useColumnSort();
  const pageRows = cases.data?.data ?? [];
  const rows = sortRows(pageRows, caseSortValue, caseSortType);
  const pageTruncated = total > pageRows.length;
  function exportCsv() {
    // Cases is server-paginated, so this exports the CURRENT page only (after filters + sort).
    if (pageTruncated) console.warn(`cases CSV export: current page only (${pageRows.length} of ${total}); backend full-export is a follow-up.`);
    const headers = ['Case ID', 'Veteran', 'Condition', 'Type', 'Status', 'Updated', 'Version'];
    const matrix = rows.map((c) => [
      c.id, c.veteran ? `${c.veteran.firstName} ${c.veteran.lastName}` : c.veteranId, c.claimedCondition,
      CLAIM_TYPE_LABELS[c.claimType], CASE_STATUS_LABELS[c.status], c.updatedAt, c.version,
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
          ? <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">{vetMatches.data.data.slice(0, 5).map((v) => <li key={v.id}><button type="button" className="flex w-full justify-between px-3 py-2 text-left hover:bg-slate-50" onClick={() => { setVeteran({ id: v.id, label: `${v.firstName} ${v.lastName} (${v.id})` }); }}><span>{v.firstName} {v.lastName}</span><span className="text-slate-500">{v.dob?.slice(0, 4) ?? ''}</span></button></li>)}</ul>
          : null}
      </div>
      <Button variant="secondary" onClick={clearFilters}>Clear filters</Button>
    </div>

    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500"><tr>
          {CASE_COLUMNS.map((col) => <th key={col.key} className="px-4 py-3" aria-sort={ariaSort(col.key)}>
            <button type="button" className="flex items-center gap-1 uppercase tracking-wide hover:text-slate-700" onClick={() => onHeaderClick(col.key)}>{col.label}{indicator(col.key)}</button>
          </th>)}
        </tr></thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((c) => <tr key={c.id} className="hover:bg-slate-50">
            <td className="px-4 py-3 font-medium"><Link className="text-indigo-600" to={`/cases/${encodeURIComponent(c.id)}`}>{c.id}</Link></td>
            <td className="px-4 py-3 text-slate-600"><Link className="hover:text-indigo-600" to={`/veterans/${encodeURIComponent(c.veteranId)}`}>{c.veteran ? `${c.veteran.firstName} ${c.veteran.lastName}` : c.veteranId}</Link></td>
            <td className="px-4 py-3 text-slate-700">{c.claimedCondition}</td>
            <td className="px-4 py-3 text-slate-600">{CLAIM_TYPE_LABELS[c.claimType]}</td>
            <td className="px-4 py-3"><CaseStatusBadge status={c.status} /></td>
            <td className="px-4 py-3 text-slate-500">{formatRelativeTime(c.updatedAt)}</td>
            <td className="px-4 py-3 text-slate-400">{c.version}</td>
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
  </div></AppShell>;
}
