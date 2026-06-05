import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '../../layout/AppShell';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { Spinner } from '../../components/ui/Spinner';
import { formatRelativeTime } from '../../lib/date';
import {
  assignIntake, dismissIntake, getIntake, intakeKind, listIntakes, retryIntake,
  type IntakeDetail, type IntakeListItem, type AssignIntakeInput,
} from '../../api/intakes';
import { listVeterans } from '../../api/veterans';
import { listCases } from '../../api/cases';

const ALLOWED_CT = new Set(['application/pdf', 'image/jpeg', 'image/png', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
const CLAIM_TYPES = ['initial', 'supplemental', 'hlr', 'appeal'] as const;

function splitName(full: string | null): { first: string; last: string } {
  const parts = (full ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0]!, last: '' };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1]! };
}
function mintId(prefix: string): string { return `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`; }

export function IntakePoolPage() {
  const [status, setStatus] = useState('ready');
  const [q, setQ] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const pool = useQuery({ queryKey: ['intakes', status, q], queryFn: () => listIntakes({ status, q }) });
  const rows = pool.data?.data ?? [];

  return (
    <AppShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Intake pool</h1>
          <p className="mt-1 text-sm text-slate-500">New Jotform submissions. Open one, match or create the veteran, and assign its files.</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <input className="input w-72" placeholder="Search name / email" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input w-44" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="ready">Ready</option>
            <option value="pending">Pending</option>
            <option value="failed">Failed</option>
            <option value="assigned">Assigned</option>
            <option value="dismissed">Dismissed</option>
            <option value="">All</option>
          </select>
        </div>

        {pool.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500"><Spinner /> Loading intakes</div>
        ) : rows.length === 0 ? (
          <EmptyState title="Nothing here" message="No submissions in this view. New Jotform submissions land here automatically." />
        ) : (
          <Card className="p-0">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500"><tr>
                <th className="px-4 py-2">Name</th><th className="px-4 py-2">Condition</th><th className="px-4 py-2">Files</th><th className="px-4 py-2">Received</th><th className="px-4 py-2">Status</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setSelectedId(r.id)}>
                    <td className="px-4 py-2 font-medium text-slate-900">{r.submittedName ?? r.submittedEmail ?? '(no name)'}</td>
                    <td className="px-4 py-2 text-slate-700">{r.submittedCondition ?? '—'}</td>
                    <td className="px-4 py-2 text-slate-600">{(r.fileManifestJson?.length ?? 0)} file(s)</td>
                    <td className="px-4 py-2 text-slate-500">{formatRelativeTime(r.createdAt)}</td>
                    <td className="px-4 py-2"><StatusChip s={r.status} retry={r.retryCount} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>

      {selectedId ? <IntakeDrawer id={selectedId} onClose={() => setSelectedId(null)} /> : null}
    </AppShell>
  );
}

function StatusChip({ s, retry }: { readonly s: string; readonly retry: number }) {
  const cls: Record<string, string> = {
    ready: 'bg-emerald-100 text-emerald-700', pending: 'bg-amber-100 text-amber-700',
    failed: 'bg-rose-100 text-rose-700', assigned: 'bg-slate-100 text-slate-600', dismissed: 'bg-slate-100 text-slate-400',
  };
  return <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${cls[s] ?? 'bg-slate-100 text-slate-600'}`}>{s}{s === 'failed' && retry > 0 ? ` (×${retry})` : ''}</span>;
}

function IntakeDrawer({ id, onClose }: { readonly id: string; readonly onClose: () => void }) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['intake', id], queryFn: () => getIntake(id) });
  const intake = detail.data?.data;
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['intakes'] }); };

  return (
    <div role="dialog" aria-modal="true">
      <div className="fixed inset-0 z-40 bg-slate-900/40" onClick={onClose} />
      <div className="fixed right-0 top-0 z-50 h-full w-full max-w-2xl overflow-y-auto bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 p-4">
          <h2 className="text-base font-semibold text-slate-900">Intake</h2>
          <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
        </div>
        {detail.isLoading || !intake ? (
          <div className="p-6 text-sm text-slate-500"><Spinner /> Loading…</div>
        ) : (
          <IntakeAssign intake={intake} onAssigned={() => { refresh(); onClose(); }} onChanged={refresh} />
        )}
      </div>
    </div>
  );
}

function IntakeAssign({ intake, onAssigned, onChanged }: { readonly intake: IntakeDetail; readonly onAssigned: () => void; readonly onChanged: () => void }) {
  const kind = intakeKind(intake.jotformFormId);
  const nm = splitName(intake.submittedName);

  // veteran: existing (search/select) or new (prefilled)
  const [vetMode, setVetMode] = useState<'existing' | 'new'>(kind === 'stage1' ? 'new' : 'existing');
  const [vetQuery, setVetQuery] = useState(intake.submittedName ?? intake.submittedEmail ?? '');
  const [vetId, setVetId] = useState<string | null>(null);
  const [vetLabel, setVetLabel] = useState<string>('');
  const [nv, setNv] = useState({ firstName: nm.first, lastName: nm.last, dob: '', email: intake.submittedEmail ?? '', state: intake.submittedState ?? '', phone: intake.submittedPhone ?? '' });

  // case: existing (the veteran's claims) or new (condition prefilled)
  const [caseMode, setCaseMode] = useState<'existing' | 'new'>(kind === 'additional_docs' ? 'existing' : 'new');
  const [caseId, setCaseId] = useState<string | null>(null);
  const [nc, setNc] = useState({ claimedCondition: intake.submittedCondition ?? '', claimType: 'initial' });

  const [fileKeys, setFileKeys] = useState<Set<string>>(new Set(intake.files.filter((f) => typeof f.s3Key === 'string').map((f) => f.s3Key!)));
  const [result, setResult] = useState<{ attached: number; failed: { name?: string; reason: string }[] } | null>(null);

  const vetSearch = useQuery({ queryKey: ['intake-vetsearch', vetQuery], queryFn: () => listVeterans(vetQuery), enabled: vetMode === 'existing' && vetQuery.trim().length >= 2 });
  const vetCases = useQuery({ queryKey: ['intake-vetcases', vetId], queryFn: () => listCases({ veteranId: vetId!, page: 1, pageSize: 25 }), enabled: vetMode === 'existing' && vetId !== null });

  const assign = useMutation({
    mutationFn: () => {
      const input: AssignIntakeInput = { fileS3Keys: [...fileKeys] };
      if (vetMode === 'existing') {
        if (!vetId) throw new Error('Pick a veteran.');
        (input as { veteranId?: string }).veteranId = vetId;
      } else {
        (input as { newVeteran?: unknown }).newVeteran = { id: mintId('MRN'), firstName: nv.firstName, lastName: nv.lastName, dob: nv.dob, email: nv.email, ...(nv.phone ? { phone: nv.phone } : {}), ...(nv.state ? { state: nv.state } : {}) };
      }
      if (caseMode === 'existing') {
        if (!caseId) throw new Error('Pick a claim.');
        (input as { caseId?: string }).caseId = caseId;
      } else {
        (input as { newCase?: unknown }).newCase = { id: mintId('CLM'), claimedCondition: nc.claimedCondition, claimType: nc.claimType };
      }
      return assignIntake(intake.id, input);
    },
    onSuccess: (res) => {
      setResult({ attached: res.data.attached.length, failed: [...res.data.failed] });
      if (res.data.assigned) { onAssigned(); }
    },
    onError: (e: unknown) => window.alert(`Could not assign — ${e instanceof Error ? e.message : 'please retry'}.`),
  });

  const dismiss = useMutation({ mutationFn: () => dismissIntake(intake.id, window.prompt('Reason for dismissing (spam/dupe)?') ?? 'dismissed'), onSuccess: () => { onChanged(); onAssigned(); } });
  const retry = useMutation({ mutationFn: () => retryIntake(intake.id), onSuccess: onChanged });

  const vetName = vetMode === 'existing' ? vetLabel : `${nv.lastName}, ${nv.firstName}`;
  const vetDob = vetMode === 'new' ? nv.dob : '';
  const claimLabel = caseMode === 'new' ? nc.claimedCondition : (vetCases.data?.data.find((c) => c.id === caseId)?.claimedCondition ?? caseId ?? '');
  const canAssign = fileKeys.size > 0 && (vetMode === 'existing' ? !!vetId : (nv.firstName && nv.lastName && nv.dob && nv.email)) && (caseMode === 'existing' ? !!caseId : nc.claimedCondition.length > 0);

  if (intake.status === 'pending' || intake.status === 'failed') {
    return (
      <div className="space-y-3 p-6 text-sm">
        <p className="text-slate-700">This intake is <b>{intake.status}</b> — its files haven't been fetched from Jotform yet{intake.errorMessage ? `: ${intake.errorMessage}` : ''}.</p>
        <Button size="sm" loading={retry.isPending} onClick={() => retry.mutate()}>Retry fetch</Button>
      </div>
    );
  }

  return (
    <div className="space-y-5 p-6">
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
        <div className="font-medium text-slate-900">{intake.submittedName ?? '(no name)'}</div>
        <div className="mt-1 text-slate-600">{[intake.submittedEmail, intake.submittedPhone, intake.submittedState].filter(Boolean).join(' · ')}</div>
        <div className="mt-1 text-slate-600">Condition (from form): {intake.submittedCondition ?? '—'} · {kind === 'additional_docs' ? 'Additional records' : kind === 'stage1' ? 'Stage 1' : 'Stage 2'}</div>
      </div>

      {/* Files */}
      <div>
        <div className="text-sm font-semibold text-slate-800">Files ({intake.files.length})</div>
        <ul className="mt-2 space-y-1">
          {intake.files.map((f) => {
            const ok = ALLOWED_CT.has(f.contentType ?? '');
            const key = f.s3Key ?? '';
            return (
              <li key={key} className="flex items-center gap-2 text-sm">
                <input type="checkbox" disabled={!ok} checked={ok && fileKeys.has(key)} onChange={(e) => setFileKeys((prev) => { const n = new Set(prev); if (e.target.checked) n.add(key); else n.delete(key); return n; })} />
                {f.previewUrl ? <a className="text-indigo-600 hover:underline" href={f.previewUrl} target="_blank" rel="noreferrer">{f.name}</a> : <span>{f.name}</span>}
                {!ok ? <span className="text-xs text-rose-600">unsupported — won't be filed</span> : null}
              </li>
            );
          })}
        </ul>
      </div>

      {/* Veteran */}
      <div className="space-y-2">
        <div className="text-sm font-semibold text-slate-800">Assign to veteran</div>
        <div className="flex gap-2 text-sm">
          <label className="flex items-center gap-1"><input type="radio" checked={vetMode === 'existing'} onChange={() => setVetMode('existing')} /> Existing</label>
          <label className="flex items-center gap-1"><input type="radio" checked={vetMode === 'new'} onChange={() => setVetMode('new')} /> Create new</label>
        </div>
        {vetMode === 'existing' ? (
          <div>
            <input className="input w-full" placeholder="Search by name / email / ID" value={vetQuery} onChange={(e) => { setVetQuery(e.target.value); setVetId(null); }} />
            {vetSearch.data && vetSearch.data.data.length > 0 ? (
              <ul className="mt-1 divide-y divide-slate-100 rounded-lg border border-slate-200">
                {vetSearch.data.data.map((v) => (
                  <li key={v.id}><button type="button" className={`flex w-full justify-between px-3 py-2 text-left text-sm hover:bg-slate-50 ${vetId === v.id ? 'bg-indigo-50' : ''}`} onClick={() => { setVetId(v.id); setVetLabel(`${v.firstName} ${v.lastName}`); setCaseMode((m) => m); }}>
                    <span>{v.firstName} {v.lastName}</span><span className="text-slate-500">DOB {v.dob?.slice(0, 10) ?? '—'}</span>
                  </button></li>
                ))}
              </ul>
            ) : vetMode === 'existing' && vetQuery.trim().length >= 2 && !vetSearch.isLoading ? <p className="mt-1 text-xs text-slate-500">No match — switch to “Create new”.</p> : null}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <input className="input" placeholder="First name" value={nv.firstName} onChange={(e) => setNv({ ...nv, firstName: e.target.value })} />
            <input className="input" placeholder="Last name" value={nv.lastName} onChange={(e) => setNv({ ...nv, lastName: e.target.value })} />
            <input className="input" type="date" title="DOB (confirm from the Stage-1 PDF)" value={nv.dob} onChange={(e) => setNv({ ...nv, dob: e.target.value })} />
            <input className="input" placeholder="Email" value={nv.email} onChange={(e) => setNv({ ...nv, email: e.target.value })} />
            <input className="input" placeholder="State (2)" maxLength={2} value={nv.state} onChange={(e) => setNv({ ...nv, state: e.target.value.toUpperCase() })} />
            <input className="input" placeholder="Phone" value={nv.phone} onChange={(e) => setNv({ ...nv, phone: e.target.value })} />
          </div>
        )}
      </div>

      {/* Case */}
      <div className="space-y-2">
        <div className="text-sm font-semibold text-slate-800">Claim</div>
        <div className="flex gap-2 text-sm">
          <label className="flex items-center gap-1"><input type="radio" checked={caseMode === 'existing'} onChange={() => setCaseMode('existing')} disabled={vetMode === 'new'} /> Existing</label>
          <label className="flex items-center gap-1"><input type="radio" checked={caseMode === 'new'} onChange={() => setCaseMode('new')} /> New claim</label>
        </div>
        {caseMode === 'existing' ? (
          vetId ? (
            <select className="input w-full" value={caseId ?? ''} onChange={(e) => setCaseId(e.target.value || null)}>
              <option value="">Select a claim…</option>
              {(vetCases.data?.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.claimedCondition} ({c.status})</option>)}
            </select>
          ) : <p className="text-xs text-slate-500">Pick an existing veteran first.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <input className="input" placeholder="Condition" value={nc.claimedCondition} onChange={(e) => setNc({ ...nc, claimedCondition: e.target.value })} />
            <select className="input" value={nc.claimType} onChange={(e) => setNc({ ...nc, claimType: e.target.value })}>{CLAIM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select>
          </div>
        )}
      </div>

      {result ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
          <div className="font-medium text-slate-900">{result.attached} file(s) filed.</div>
          {result.failed.length > 0 ? <ul className="mt-1 text-rose-700">{result.failed.map((f, i) => <li key={i}>• {f.name}: {f.reason}</li>)}</ul> : null}
        </div>
      ) : null}

      <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-900">
        Assign <b>{fileKeys.size}</b> file(s) → <b>{vetName || '(choose veteran)'}{vetDob ? ` (DOB ${vetDob})` : ''}</b> → <b>{claimLabel || '(choose claim)'}</b>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={!canAssign || assign.isPending} loading={assign.isPending} onClick={() => { if (window.confirm(`Assign ${fileKeys.size} file(s) to ${vetName}${vetDob ? ` (DOB ${vetDob})` : ''} → ${claimLabel}?`)) assign.mutate(); }}>Assign</Button>
        {kind === 'additional_docs' && caseMode === 'existing' && caseId ? <span className="self-center text-xs text-slate-500">After assigning, open the claim to re-run the draft with the new records.</span> : null}
        <Button variant="ghost" onClick={() => dismiss.mutate()}>Dismiss (spam/dupe)</Button>
      </div>
    </div>
  );
}
