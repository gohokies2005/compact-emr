import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from './ui/Button';
import { EmptyState } from './ui/EmptyState';
import { ConditionSelect } from './ConditionSelect';
import { ConflictError } from '../api/client';
import {
  addMedication, addProblem, addScCondition, deleteMedication, deleteProblem, deleteScCondition, updateScCondition,
} from '../api/veterans';
import type { ActiveMedication, ActiveProblem, ScCondition, ScConditionStatus } from '../types/prisma';

// Shared clinical-chart panels (SC Conditions / Active Problems / Medications). Extracted verbatim
// from VeteranChart so the case-detail page can mount the SAME add/edit/delete UI on the case's
// veteran (the case is a claim ON a veteran). Both pages render these identically. (Ryan 2026-06-08.)

// Collapse duplicate/synonym condition rows (chart-extract over duplicate docs produced e.g. OSA ×3).
// Synonym-aware canonical key + token-sort so "OSA" / "Obstructive Sleep Apnea" / "Sleep apnea,
// obstructive" merge. Keeps the most-complete name per key. (Display-level; a deep dedup-on-extract
// is a bigger follow-up.)
const COND_SYNONYMS: Record<string, string> = { osa: 'obstructive sleep apnea', ptsd: 'posttraumatic stress disorder', gerd: 'gastroesophageal reflux disease', tbi: 'traumatic brain injury', mdd: 'major depressive disorder', htn: 'hypertension' };
const COND_STOP = new Set(['the', 'a', 'condition', 'disorder', 'chronic', 'unspecified', 'with', 'and']);
function canonicalCondition(s: string): string {
  let t = (s || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (COND_SYNONYMS[t] !== undefined) t = COND_SYNONYMS[t]!;
  return t.split(' ').filter((w) => w.length > 0 && !COND_STOP.has(w)).sort().join(' ');
}
// keyExtra (e.g. SC claim status) is folded into the dedup key so rows that differ in that field
// are NOT collapsed — preserves denial/SC history (architect QA: don't drop a differently-rated row).
function dedupByCondition<T>(rows: readonly T[], getName: (r: T) => string, keyExtra?: (r: T) => string): T[] {
  const byKey = new Map<string, T>();
  const passthrough: T[] = [];
  for (const r of rows) {
    const base = canonicalCondition(getName(r));
    if (base.length === 0) { passthrough.push(r); continue; }
    const k = keyExtra ? `${base}|${keyExtra(r)}` : base;
    const cur = byKey.get(k);
    if (cur === undefined || getName(r).length > getName(cur).length) byKey.set(k, r);
  }
  return [...byKey.values(), ...passthrough];
}

// VA claim status per SC-condition row — lets the chart hold the veteran's full claim history
// (granted/established, awaiting a decision, or denied), not just already-service-connected ones.
const SC_STATUS_OPTIONS: readonly { readonly value: ScConditionStatus; readonly label: string }[] = [
  { value: 'service_connected', label: 'Service-connected' },
  { value: 'pending', label: 'Pending' },
  { value: 'denied', label: 'Denied' },
];
function scStatusClass(status: ScConditionStatus): string {
  if (status === 'pending') return 'text-amber-700';
  if (status === 'denied') return 'text-rose-700';
  return 'text-emerald-700';
}

export function ConditionsPanel({ veteranId, rows, onChange }: { readonly veteranId: string; readonly rows: readonly ScCondition[]; readonly onChange: () => Promise<void> }) {
  const [condition, setCondition] = useState(''); const [dcCode, setDcCode] = useState(''); const [status, setStatus] = useState<ScConditionStatus>('service_connected');
  const add = useMutation({ mutationFn: () => addScCondition(veteranId, { condition, ...(dcCode && { dcCode }), status }), onSuccess: async () => { setCondition(''); setDcCode(''); setStatus('service_connected'); await onChange(); } });
  const del = useMutation({ mutationFn: deleteScCondition, onSuccess: onChange });
  return <div className="space-y-4">
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <div className="sm:flex-1"><ConditionSelect label="Condition" value={condition} onChange={setCondition} /></div>
      <input className="input sm:w-32" placeholder="DC code" value={dcCode} onChange={(e) => setDcCode(e.target.value)} />
      <select className="input sm:w-44" value={status} onChange={(e) => setStatus(e.target.value as ScConditionStatus)} aria-label="Claim status">{SC_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
      <Button size="sm" onClick={() => add.mutate()} disabled={!condition}>Add</Button>
    </div>
    {rows.length === 0
      ? <EmptyState title="Nothing recorded yet" message="Add the first condition above." />
      : <div className="divide-y divide-slate-100">{dedupByCondition(rows, (r) => r.condition, (r) => r.status).map((r) => <ScConditionRow key={r.id} row={r} onChange={onChange} onDelete={() => { if (window.confirm('Remove this SC condition?')) del.mutate(r.id); }} />)}</div>}
  </div>;
}

// One SC-condition row. The status <select> is editable in place: changing it PATCHes the row
// (optimistic-concurrency via row.version) so the chart's full claim history stays current.
function ScConditionRow({ row, onChange, onDelete }: { readonly row: ScCondition; readonly onChange: () => Promise<void>; readonly onDelete: () => void }) {
  const update = useMutation({
    mutationFn: (next: ScConditionStatus) => updateScCondition(row.id, { version: row.version, status: next }),
    onSuccess: () => onChange(),
    onError: async (err) => { if (err instanceof ConflictError) { await onChange(); window.alert('This condition was updated elsewhere. Reloaded — please retry.'); } },
  });
  return <div className="flex items-center justify-between py-3 text-sm">
    <div className="flex gap-6 text-slate-700"><span>{row.condition}</span>{row.dcCode ? <span className="text-slate-500">DC {row.dcCode}</span> : null}{row.ratingPct != null ? <span className="text-slate-500">{row.ratingPct}%</span> : null}</div>
    <div className="flex items-center gap-4">
      <select className={`input w-48 text-xs font-medium ${scStatusClass(row.status)}`} value={row.status} disabled={update.isPending} onChange={(e) => update.mutate(e.target.value as ScConditionStatus)} aria-label={`Claim status for ${row.condition}`}>{SC_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
      <button className="text-rose-600" onClick={onDelete}>Delete</button>
    </div>
  </div>;
}

export function ProblemsPanel({ veteranId, rows, onChange }: { readonly veteranId: string; readonly rows: readonly ActiveProblem[]; readonly onChange: () => Promise<void> }) {
  const [problem, setProblem] = useState(''); const add = useMutation({ mutationFn: () => addProblem(veteranId, { problem }), onSuccess: async () => { setProblem(''); await onChange(); } }); const del = useMutation({ mutationFn: deleteProblem, onSuccess: onChange });
  return <div className="space-y-4"><div className="flex flex-col gap-2 sm:flex-row sm:items-start"><div className="sm:flex-1"><ConditionSelect label="Problem" value={problem} onChange={setProblem} placeholder="Select a problem…" /></div><Button size="sm" onClick={() => add.mutate()} disabled={!problem}>Add</Button></div><Rows rows={dedupByCondition(rows, (r) => r.problem).map((r) => ({ id: r.id, cols: [r.problem, r.notes ?? ''], onDelete: () => { if (window.confirm('Remove this problem?')) del.mutate(r.id); } }))} /></div>;
}

export function MedicationsPanel({ veteranId, rows, onChange }: { readonly veteranId: string; readonly rows: readonly ActiveMedication[]; readonly onChange: () => Promise<void> }) {
  const [drugName, setDrugName] = useState(''); const add = useMutation({ mutationFn: () => addMedication(veteranId, { drugName }), onSuccess: async () => { setDrugName(''); await onChange(); } }); const del = useMutation({ mutationFn: deleteMedication, onSuccess: onChange });
  return <div className="space-y-4"><div className="flex gap-2"><input className="input" placeholder="Medication" value={drugName} onChange={(e) => setDrugName(e.target.value)} /><Button size="sm" onClick={() => add.mutate()} disabled={!drugName}>Add</Button></div><Rows rows={rows.map((r) => ({ id: r.id, cols: [r.drugName, r.dose ?? '', r.frequency ?? ''], onDelete: () => { if (window.confirm('Remove this medication?')) del.mutate(r.id); } }))} /></div>;
}

function Rows({ rows }: { readonly rows: readonly { readonly id: string; readonly cols: readonly string[]; readonly onDelete: () => void }[] }) { if (!rows.length) return <EmptyState title="Nothing recorded yet" message="Add the first item above." />; return <div className="divide-y divide-slate-100">{rows.map((r) => <div className="flex items-center justify-between py-3 text-sm" key={r.id}><div className="flex gap-6 text-slate-700">{r.cols.map((c, i) => <span key={`${r.id}-${i}`}>{c}</span>)}</div><button className="text-rose-600" onClick={r.onDelete}>Delete</button></div>)}</div>; }
