import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppShell } from '../../layout/AppShell';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { createVeteran, listVeterans, type CreateVeteranInput, type VeteranListItem } from '../../api/veterans';
import { NewVeteranModal } from './NewVeteranModal';
import { formatRelativeTime } from '../../lib/date';
import { useColumnSort, type ColType } from '../../lib/useColumnSort';
import { exportRowsToCsv } from '../../lib/csv';

function useDebounced(value: string, ms: number) { const [debounced, setDebounced] = useState(value); useEffect(() => { const t = window.setTimeout(() => setDebounced(value), ms); return () => window.clearTimeout(t); }, [value, ms]); return debounced; }

const VET_COLUMNS: readonly { readonly key: string; readonly label: string }[] = [
  { key: 'veteran', label: 'Veteran' }, { key: 'dob', label: 'DOB' }, { key: 'branch', label: 'Branch' },
  { key: 'activeCases', label: 'Active cases' }, { key: 'lastActivity', label: 'Last activity' },
];
const vetSortType = (key: string): ColType => (key === 'dob' || key === 'lastActivity' ? 'date' : key === 'activeCases' ? 'number' : 'text');
const vetSortValue = (key: string) => (v: VeteranListItem): unknown => {
  switch (key) {
    case 'veteran': return `${v.firstName} ${v.lastName}`;
    case 'dob': return v.dob;
    case 'branch': return v.branch;
    case 'activeCases': return v.activeCases ?? 0;
    case 'lastActivity': return v.updatedAt;
    default: return '';
  }
};

export function VeteransPage() {
  const [q, setQ] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const debouncedQ = useDebounced(q, 300);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const veterans = useQuery({ queryKey: ['veterans', debouncedQ], queryFn: () => listVeterans(debouncedQ) });
  const createMutation = useMutation({ mutationFn: createVeteran, onSuccess: (res) => { void qc.invalidateQueries({ queryKey: ['veterans'] }); navigate(`/veterans/${encodeURIComponent(res.data.id)}`); } });

  async function submit(input: CreateVeteranInput) { await createMutation.mutateAsync(input); }

  const { onHeaderClick, sortRows, ariaSort, indicator } = useColumnSort();
  const vetRows = sortRows(veterans.data?.data ?? [], vetSortValue, vetSortType);
  function exportCsv() {
    const headers = ['Veteran', 'MRN', 'DOB', 'Branch', 'Active Cases', 'Last Activity'];
    const matrix = vetRows.map((v) => [`${v.firstName} ${v.lastName}`, v.id, v.dob, v.branch, v.activeCases ?? 0, v.updatedAt ?? '']);
    exportRowsToCsv(`veterans-export-${new Date().toISOString().slice(0, 10)}.csv`, headers, matrix);
  }
  return <AppShell><div className="space-y-6">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h1 className="text-2xl font-semibold text-slate-900">Veterans</h1><p className="text-sm text-slate-500">Search and manage veteran master records.</p></div><div className="flex gap-2"><Button variant="secondary" onClick={exportCsv} disabled={vetRows.length === 0}>Export to Excel</Button><Button onClick={() => setModalOpen(true)}>+ New veteran</Button></div></div>
    <input aria-label="Search veterans" className="w-full rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm outline-none focus:border-indigo-500" placeholder="Search veterans by name, DOB, ID, or condition…" value={q} onChange={(e) => setQ(e.target.value)} />
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white"><table className="min-w-full divide-y divide-slate-200 text-sm"><thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500"><tr>{VET_COLUMNS.map((col) => <th key={col.key} className="px-4 py-3" aria-sort={ariaSort(col.key)}><button type="button" className="flex items-center gap-1 uppercase tracking-wide hover:text-slate-700" onClick={() => onHeaderClick(col.key)}>{col.label}{indicator(col.key)}</button></th>)}</tr></thead><tbody className="divide-y divide-slate-100">
      {vetRows.map((v) => <tr key={v.id} className="cursor-pointer hover:bg-slate-50" onClick={() => navigate(`/veterans/${encodeURIComponent(v.id)}`)}><td className="px-4 py-3"><div className="font-medium text-slate-900">{v.firstName} {v.lastName}</div><div className="text-xs text-slate-400">MRN {v.id}</div></td><td className="px-4 py-3 text-slate-600">{v.dob}</td><td className="px-4 py-3 text-slate-600">{v.branch}</td><td className="px-4 py-3 text-slate-600">{v.activeCases ?? 0}</td><td className="px-4 py-3 text-slate-600">{v.updatedAt ? formatRelativeTime(v.updatedAt) : '—'}</td></tr>)}
    </tbody></table>{!veterans.isLoading && veterans.data?.data.length === 0 ? <EmptyState title="No veterans found" message="Try a different search or create a new veteran." /> : null}</div>
    <NewVeteranModal open={modalOpen} onClose={() => setModalOpen(false)} onSubmit={submit} saving={createMutation.isPending} />
  </div></AppShell>;
}
