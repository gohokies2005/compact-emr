import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '../../layout/AppShell';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { Spinner } from '../../components/ui/Spinner';
import { formatRelativeTime } from '../../lib/date';
import {
  assignIntake, dismissIntake, getIntake, intakeKind, listIntakes, retryIntake, restoreIntake,
  type IntakeDetail, type IntakeListItem, type AssignIntakeInput,
} from '../../api/intakes';
import { listVeterans } from '../../api/veterans';
import { listCases } from '../../api/cases';
import { formatConditionLabel } from '../../lib/conditionLabel';

const ALLOWED_CT = new Set(['application/pdf', 'image/jpeg', 'image/png', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
// Canonical case-enum values (must match backend ClaimType / case-validation CLAIM_TYPES). The old
// list used 'appeal', which the case layer rejects ('appeal_bva') — that mismatch failed Wayne
// Mosely's assign 3× (2026-06-05). Friendly labels so the RN doesn't see raw enum slugs.
const CLAIM_TYPES = [['initial', 'Initial'], ['supplemental', 'Supplemental'], ['hlr', 'Higher-level review'], ['appeal_bva', 'Board appeal']] as const;
// Worker/Jotform legacy claim-type values → canonical enum (mirrors backend normalizeClaimType so a
// pre-filled 'appeal' selects 'Board appeal' instead of silently falling back to Initial).
const CLAIM_TYPE_ALIAS: Readonly<Record<string, string>> = { appeal: 'appeal_bva', board_appeal: 'appeal_bva', bva: 'appeal_bva', nod: 'appeal_bva', hlr_request: 'hlr', higher_level_review: 'hlr' };
const normalizeClaimType = (s: string | null): string => { const t = (s ?? '').trim().toLowerCase(); return CLAIM_TYPE_ALIAS[t] ?? (s ?? ''); };

function splitName(full: string | null): { first: string; last: string } {
  const parts = (full ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0]!, last: '' };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1]! };
}
function mintId(prefix: string): string { return `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`; }
// Title-case a name part (fixes ALL-CAPS form entries like "WOODLEY" → "Woodley"); preserves hyphens
// and apostrophes (Hamilton-Dorsey, O'Brien).
function titleCaseName(s: string): string {
  return s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}
// Display as "Lastname, Firstname" (Ryan 2026-06-05), title-cased.
function displayName(full: string | null): string {
  const { first, last } = splitName(full);
  const f = titleCaseName(first); const l = titleCaseName(last);
  return l ? (f ? `${l}, ${f}` : l) : titleCaseName(full ?? '');
}

// Significant condition tokens (drop punctuation + filler) so "migraines" and "Migraines / Chronic
// Headaches" are recognized as the same claim — prevents a duplicate claim on the second intake.
const COND_STOPWORDS = new Set(['and', 'the', 'condition', 'disorder', 'chronic', 'unspecified', 'left', 'right', 'bilateral']);
function condTokens(s: string): string[] {
  return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !COND_STOPWORDS.has(w));
}
function conditionsLikelySame(a: string, b: string): boolean {
  const ta = condTokens(a); const tb = condTokens(b);
  return ta.length > 0 && tb.length > 0 && ta.some((w) => tb.includes(w));
}

type SortKey = 'name' | 'profile' | 'condition' | 'files' | 'received' | 'status';

function sortRows(rows: readonly IntakeListItem[], key: SortKey, dir: 1 | -1): IntakeListItem[] {
  const val = (r: IntakeListItem): string | number => {
    switch (key) {
      case 'name': return (displayName(r.submittedName) || r.submittedEmail || '').toLowerCase(); // sorts by last name
      case 'profile': return r.veteranMatch ? 0 : 1; // existing profiles first when ascending
      case 'condition': return (r.submittedCondition ?? '').toLowerCase();
      case 'files': return r.fileManifestJson?.length ?? 0;
      case 'received': return new Date(r.createdAt).getTime();
      case 'status': return r.status;
    }
  };
  return [...rows].sort((a, b) => { const av = val(a); const bv = val(b); return av < bv ? -1 * dir : av > bv ? 1 * dir : 0; });
}

export function IntakePoolPage() {
  const [status, setStatus] = useState('ready');
  const [q, setQ] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'received', dir: -1 });

  const pool = useQuery({ queryKey: ['intakes', status, q], queryFn: () => listIntakes({ status, q }) });
  const rows = useMemo(() => sortRows(pool.data?.data ?? [], sort.key, sort.dir), [pool.data, sort]);
  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: key === 'received' ? -1 : 1 }));
  const Th = ({ k, label, className }: { k: SortKey; label: string; className?: string }) => (
    <th className={`cursor-pointer select-none px-4 py-2 hover:text-slate-800 ${className ?? ''}`} onClick={() => toggleSort(k)}>
      {label}{sort.key === k ? <span className="ml-1 text-slate-400">{sort.dir === 1 ? '▲' : '▼'}</span> : null}
    </th>
  );

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
                <Th k="name" label="Name" /><Th k="profile" label="Profile" /><Th k="condition" label="Condition" /><Th k="files" label="Files" /><Th k="received" label="Received" /><Th k="status" label="Status" />
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setSelectedId(r.id)}>
                    <td className="px-4 py-2 font-medium text-slate-900">{r.submittedName ? displayName(r.submittedName) : (r.submittedEmail ?? '(no name)')}</td>
                    <td className="px-4 py-2">{r.veteranMatch
                      ? <span className="inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700" title={`Existing profile: ${r.veteranMatch.name}`}>✓ Exists</span>
                      : <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">New</span>}</td>
                    <td className="px-4 py-2 text-slate-700">{r.submittedCondition ? formatConditionLabel(r.submittedCondition) : '—'}</td>
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
  const kind = intakeKind(intake.jotformFormId, intake.submittedFormTitle);
  const nm = splitName(intake.submittedName);
  const canonicalCt = normalizeClaimType(intake.submittedClaimType);
  const prefillClaimType = CLAIM_TYPES.some(([v]) => v === canonicalCt) ? canonicalCt : 'initial';

  // veteran: existing (search/select) or new (prefilled). If a profile already exists for this email,
  // PRESELECT it (returning customer → no DOB entry needed; their claims load automatically).
  const match = intake.veteranMatch;
  // Default: existing when a profile is found, create-new when not (Ryan 2026-06-05).
  const [vetMode, setVetMode] = useState<'existing' | 'new'>(match ? 'existing' : 'new');
  const [searching, setSearching] = useState(false); // RN chose to search a different veteran than the match
  // Two-factor identity: confirm name + DOB. (intake DOB vs the matched profile's DOB.)
  const intakeDob = intake.submittedDob ?? '';
  const dobMatches = !!match?.dob && !!intakeDob && match.dob === intakeDob;
  const [vetQuery, setVetQuery] = useState(match?.name ?? intake.submittedName ?? intake.submittedEmail ?? '');
  const [vetId, setVetId] = useState<string | null>(match?.id ?? null);
  const [vetLabel, setVetLabel] = useState<string>(match?.name ?? '');
  const [nv, setNv] = useState({ firstName: nm.first, lastName: nm.last, dob: intake.submittedDob ?? '', email: intake.submittedEmail ?? '', state: intake.submittedState ?? '', phone: intake.submittedPhone ?? '' });

  // case: existing (the veteran's claims) or new (condition + claim type prefilled)
  const [caseMode, setCaseMode] = useState<'existing' | 'new'>(kind === 'additional_docs' ? 'existing' : 'new');
  const [caseId, setCaseId] = useState<string | null>(null);
  const [nc, setNc] = useState({ claimedCondition: formatConditionLabel(intake.submittedCondition ?? ''), claimType: prefillClaimType });

  const [fileKeys, setFileKeys] = useState<Set<string>>(new Set(intake.files.filter((f) => typeof f.s3Key === 'string').map((f) => f.s3Key!)));
  const [result, setResult] = useState<{ attached: number; failed: { name?: string; reason: string }[] } | null>(null);

  const vetSearch = useQuery({ queryKey: ['intake-vetsearch', vetQuery], queryFn: () => listVeterans(vetQuery), enabled: vetMode === 'existing' && vetQuery.trim().length >= 2 });
  const vetCases = useQuery({ queryKey: ['intake-vetcases', vetId], queryFn: () => listCases({ veteranId: vetId!, page: 1, pageSize: 25 }), enabled: vetMode === 'existing' && vetId !== null });

  // Default the CLAIM to existing when the chosen veteran already has a claim for this condition
  // (Ryan 2026-06-05: "if a claim already exists, default to existing"). One-shot, RN can still change.
  const claimAutoSet = useRef(false);
  useEffect(() => {
    if (claimAutoSet.current) return;
    const cases = vetCases.data?.data;
    if (!cases || cases.length === 0) return;
    const cond = intake.submittedCondition ?? '';
    const m = cases.find((c) => conditionsLikelySame(c.claimedCondition ?? '', cond));
    if (m) { setCaseMode('existing'); setCaseId(m.id); claimAutoSet.current = true; }
  }, [vetCases.data, intake.submittedCondition]);

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
  const restore = useMutation({ mutationFn: () => restoreIntake(intake.id), onSuccess: () => { onChanged(); onAssigned(); } });

  // Same-condition dedup: if the chosen veteran already has a claim matching this condition, warn so
  // the RN attaches to it instead of creating a duplicate claim (the "two migraines claims" problem).
  const dupeClaim = (caseMode === 'new' && vetMode === 'existing' && vetId && nc.claimedCondition)
    ? (vetCases.data?.data ?? []).find((c) => conditionsLikelySame(c.claimedCondition ?? '', nc.claimedCondition))
    : undefined;

  const vetName = vetMode === 'existing' ? vetLabel : `${nv.lastName}, ${nv.firstName}`;
  const vetDob = vetMode === 'new' ? nv.dob : '';
  const claimLabel = caseMode === 'new' ? nc.claimedCondition : (vetCases.data?.data.find((c) => c.id === caseId)?.claimedCondition ?? caseId ?? '');
  // Files are optional — a Stage-1/2 submission may carry no uploads; the value is creating the
  // veteran + claim from the answers. Assign needs a veteran + a claim, not files.
  const canAssign = (vetMode === 'existing' ? !!vetId : (!!nv.firstName && !!nv.lastName && !!nv.dob && !!nv.email)) && (caseMode === 'existing' ? !!caseId : nc.claimedCondition.length > 0);
  // Surface exactly WHY Assign is disabled (no silent gray-out).
  const missingVetFields = [!nv.firstName && 'first name', !nv.lastName && 'last name', !nv.dob && 'date of birth', !nv.email && 'email'].filter(Boolean);
  const disabledReason = canAssign ? null
    : vetMode === 'existing' && !vetId ? 'Choose an existing veteran above, or switch to "Create new".'
    : vetMode === 'new' && missingVetFields.length > 0 ? `Add the new veteran's ${missingVetFields.join(', ')}${!nv.dob ? ' (date of birth is on the DD-214 if the form didn’t capture it)' : ''}.`
    : caseMode === 'existing' && !caseId ? 'Choose a claim.'
    : caseMode === 'new' && nc.claimedCondition.length === 0 ? 'Enter the claimed condition.'
    : null;

  if (intake.status === 'pending' || intake.status === 'failed') {
    return (
      <div className="space-y-3 p-6 text-sm">
        <p className="text-slate-700">This intake is <b>{intake.status}</b> — its files haven't been fetched from Jotform yet{intake.errorMessage ? `: ${intake.errorMessage}` : ''}.</p>
        <Button size="sm" loading={retry.isPending} onClick={() => retry.mutate()}>Retry fetch</Button>
      </div>
    );
  }

  if (intake.status === 'dismissed') {
    return (
      <div className="space-y-3 p-6 text-sm">
        <p className="text-slate-700">This intake was <b>dismissed</b>{intake.errorMessage ? '' : ''}. Restore it to the pool if that was a mistake.</p>
        <Button size="sm" loading={restore.isPending} onClick={() => restore.mutate()}>Restore to pool</Button>
      </div>
    );
  }

  return (
    <div className="space-y-5 p-6">
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
        <div className="font-medium text-slate-900">{intake.submittedName ? displayName(intake.submittedName) : '(no name)'}</div>
        <div className="mt-1 text-slate-600">{[intake.submittedEmail, intake.submittedPhone, intake.submittedState].filter(Boolean).join(' · ')}</div>
        <div className="mt-1 text-slate-600">Condition (from form): {intake.submittedCondition ? formatConditionLabel(intake.submittedCondition) : '—'} · {intake.submittedFormTitle ?? (kind === 'additional_docs' ? 'Additional records' : kind === 'stage1' ? 'Stage 1' : 'Stage 2')}</div>
        {match ? (
          dobMatches
            ? <div className="mt-2 inline-flex rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">✓ Matched existing profile {match.name} — name + DOB ({match.dob}) match</div>
            : <div className="mt-2 inline-flex rounded-md bg-amber-100 px-2 py-1 text-xs font-medium text-amber-900">⚠ Email matches {match.name} (profile DOB {match.dob ?? '—'}) but {intakeDob ? `the intake DOB is ${intakeDob}` : 'no DOB on this intake'} — verify name + DOB before assigning</div>
        ) : null}
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
          match && vetId === match.id && !searching ? (
            // Preselected matched profile — show it as confirmed (name + DOB), not a search that says
            // "No match". The email match is authoritative; the RN verifies name + DOB here.
            <div className={`rounded-lg border p-3 text-sm ${dobMatches ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'}`}>
              <div className="font-medium text-slate-900">{match.name}</div>
              <div className="text-slate-600">Profile DOB {match.dob ?? '—'}{intakeDob && match.dob && !dobMatches ? ` · intake says ${intakeDob}` : ''}</div>
              <button type="button" className="mt-1 text-xs text-indigo-600 underline" onClick={() => { setSearching(true); setVetId(null); setVetQuery(''); }}>Pick a different veteran</button>
            </div>
          ) : (
            <div>
              <input className="input w-full" placeholder="Search by name / email / ID" value={vetQuery} onChange={(e) => { setVetQuery(e.target.value); setVetId(null); }} />
              {vetSearch.data && vetSearch.data.data.length > 0 ? (
                <ul className="mt-1 divide-y divide-slate-100 rounded-lg border border-slate-200">
                  {vetSearch.data.data.map((v) => (
                    <li key={v.id}><button type="button" className={`flex w-full justify-between px-3 py-2 text-left text-sm hover:bg-slate-50 ${vetId === v.id ? 'bg-indigo-50' : ''}`} onClick={() => { setVetId(v.id); setVetLabel(`${v.firstName} ${v.lastName}`); }}>
                      <span>{v.firstName} {v.lastName}</span><span className="text-slate-500">DOB {v.dob?.slice(0, 10) ?? '—'}</span>
                    </button></li>
                  ))}
                </ul>
              ) : vetQuery.trim().length >= 2 && !vetSearch.isLoading ? <p className="mt-1 text-xs text-slate-500">No match — switch to “Create new”.</p> : null}
            </div>
          )
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <input className="input" placeholder="First name" value={nv.firstName} onChange={(e) => setNv({ ...nv, firstName: e.target.value })} />
            <input className="input" placeholder="Last name" value={nv.lastName} onChange={(e) => setNv({ ...nv, lastName: e.target.value })} />
            <input className="input" type="date" title="Date of birth (prefilled from the form when present)" value={nv.dob} onChange={(e) => setNv({ ...nv, dob: e.target.value })} />
            <input className="input" placeholder="Email" value={nv.email} onChange={(e) => setNv({ ...nv, email: e.target.value })} />
            <input className="input" placeholder="State" title="2-letter state (e.g. CO, ID) — the EMR mints the record ID automatically" maxLength={2} value={nv.state} onChange={(e) => setNv({ ...nv, state: e.target.value.toUpperCase() })} />
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
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <input className="input" placeholder="Condition" value={nc.claimedCondition} onChange={(e) => setNc({ ...nc, claimedCondition: e.target.value })} />
              <select className="input" value={nc.claimType} onChange={(e) => setNc({ ...nc, claimType: e.target.value })}>{CLAIM_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            </div>
            {dupeClaim ? (
              <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                {vetLabel} already has a claim for <b>{dupeClaim.claimedCondition}</b> ({dupeClaim.id}). Creating a new claim would duplicate it.{' '}
                <button type="button" className="font-semibold text-indigo-700 underline" onClick={() => { setCaseMode('existing'); setCaseId(dupeClaim.id); }}>Attach to that claim instead</button> (the files/records go onto the existing claim).
              </div>
            ) : null}
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

      {disabledReason ? <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">To assign: {disabledReason}</div> : null}

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={!canAssign || assign.isPending} loading={assign.isPending} onClick={() => { if (window.confirm(`Assign ${fileKeys.size} file(s) to ${vetName}${vetDob ? ` (DOB ${vetDob})` : ''} → ${claimLabel}?`)) assign.mutate(); }}>Assign</Button>
        {kind === 'additional_docs' && caseMode === 'existing' && caseId ? <span className="self-center text-xs text-slate-500">After assigning, open the claim to re-run the draft with the new records.</span> : null}
        <Button variant="ghost" onClick={() => dismiss.mutate()}>Dismiss (spam/dupe)</Button>
      </div>
    </div>
  );
}
