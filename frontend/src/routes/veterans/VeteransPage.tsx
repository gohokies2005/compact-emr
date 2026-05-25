import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppShell } from '../../layout/AppShell';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { createVeteran, listVeterans, type CreateVeteranInput } from '../../api/veterans';
import { NewVeteranModal } from './NewVeteranModal';

function useDebounced(value: string, ms: number) { const [debounced, setDebounced] = useState(value); useEffect(() => { const t = window.setTimeout(() => setDebounced(value), ms); return () => window.clearTimeout(t); }, [value, ms]); return debounced; }

export function VeteransPage() {
  const [q, setQ] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const debouncedQ = useDebounced(q, 300);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const veterans = useQuery({ queryKey: ['veterans', debouncedQ], queryFn: () => listVeterans(debouncedQ) });
  const createMutation = useMutation({ mutationFn: createVeteran, onSuccess: (res) => { void qc.invalidateQueries({ queryKey: ['veterans'] }); navigate(`/veterans/${encodeURIComponent(res.data.id)}`); } });

  async function submit(input: CreateVeteranInput) { await createMutation.mutateAsync(input); }
  return <AppShell><div className="space-y-6">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h1 className="text-2xl font-semibold text-slate-900">Veterans</h1><p className="text-sm text-slate-500">Search and manage veteran master records.</p></div><Button onClick={() => setModalOpen(true)}>+ New veteran</Button></div>
    <input aria-label="Search veterans" className="w-full rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm outline-none focus:border-indigo-500" placeholder="Search veterans by name, DOB, ID, or condition…" value={q} onChange={(e) => setQ(e.target.value)} />
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white"><table className="min-w-full divide-y divide-slate-200 text-sm"><thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">Veteran</th><th className="px-4 py-3">DOB</th><th className="px-4 py-3">Branch</th><th className="px-4 py-3">Active cases</th><th className="px-4 py-3">Last activity</th></tr></thead><tbody className="divide-y divide-slate-100">
      {veterans.data?.data.map((v) => <tr key={v.id} className="cursor-pointer hover:bg-slate-50" onClick={() => navigate(`/veterans/${encodeURIComponent(v.id)}`)}><td className="px-4 py-3 font-medium text-slate-900">{v.id}</td><td className="px-4 py-3 text-slate-600">{v.dob}</td><td className="px-4 py-3 text-slate-600">{v.branch}</td><td className="px-4 py-3 text-slate-600">{v.caseCount ?? 0}</td><td className="px-4 py-3 text-slate-600">{v.lastActivity ?? '—'}</td></tr>)}
    </tbody></table>{!veterans.isLoading && veterans.data?.data.length === 0 ? <EmptyState title="No veterans found" message="Try a different search or create a new veteran." /> : null}</div>
    <NewVeteranModal open={modalOpen} onClose={() => setModalOpen(false)} onSubmit={submit} saving={createMutation.isPending} />
  </div></AppShell>;
}
