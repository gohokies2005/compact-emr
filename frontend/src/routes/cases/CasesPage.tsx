import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AppShell } from '../../layout/AppShell';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { CASE_STATUS_LABELS, caseDisplayLabel } from '../../lib/caseStatus';
import { formatAbsoluteDate, formatRelativeTime } from '../../lib/date';
import { listCases, deleteCase, restoreCase, updateQuickNote, assignCaseRn, type CaseLite } from '../../api/cases';
import { describeApiError } from '../../api/client';
import { listVeterans } from '../../api/veterans';
import { getMe, listUsers, type StaffUser } from '../../api/users';
import { useAuth } from '../../auth/useAuth';
import type { CaseStatus, ClaimType } from '../../types/prisma';
import { type ColType } from '../../lib/useColumnSort';
import { exportRowsToCsv } from '../../lib/csv';
import { formatConditionLabel } from '../../lib/conditionLabel';
import { formatNameLastFirst } from '../../lib/format';

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => { const t = window.setTimeout(() => setDebounced(value), ms); return () => window.clearTimeout(t); }, [value, ms]);
  return debounced;
}

// KEPT for the Type COLUMN + CSV export — only the claim-type FILTER was removed (P3.2).
const CLAIM_TYPE_LABELS: Record<ClaimType, string> = { initial: 'Initial', supplemental: 'Supplemental', hlr: 'Higher-level review', appeal_bva: 'Board appeal' };
const STATUS_OPTIONS = Object.entries(CASE_STATUS_LABELS) as [CaseStatus, string][];
const PAGE_SIZES = [25, 50, 100];
// RN-filter tokens. '__me__' is CLIENT-ONLY (resolved to my AppUser id via /users/me before the
// request); '__none__' is the backend's unassigned sentinel and goes over the wire as-is.
const RN_ME = '__me__';
const RN_UNASSIGNED = '__none__';
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
    case 'rn': return c.assignedRn?.name ?? c.assignedRn?.email ?? '';
    case 'submitted': return c.createdAt;
    case 'updated': return c.updatedAt;
    case 'version': return c.version;
    default: return '';
  }
};

// === Sticky deterministic sort + sticky filters (Ryan 2026-06-11) ===
// The backend lists cases by updatedAt DESC, so with no explicit sort the rows RESHUFFLED on every
// refetch (touching ANY case floats it to the top) — that's the "Submitted column resorts itself"
// complaint. Fixes, all client-side on this page:
//   1. Default order = Submitted (createdAt) NEWEST FIRST — the actual timeline.
//   2. Date columns compare on the EPOCH (Date.parse), NEVER the display string (a display-string
//      sort would order Sep/Oct/Nov alphabetically — the 9/10/11-out-of-order bug).
//   3. Equal keys tiebreak on case id ASC, so ties can't jitter between refetches.
//   4. Sort + filters persist in sessionStorage (per-tab; survives navigating into a claim and
//      back, resets with a fresh tab). Rows themselves are NOT frozen — react-query refetches
//      still bring in new cases; only the ORDERING is deterministic.
interface CasesSortState { readonly key: string; readonly dir: 'asc' | 'desc' }
const DEFAULT_SORT: CasesSortState = { key: 'submitted', dir: 'desc' };
const SORT_STORAGE_KEY = 'emr.cases.sort.v1';
const FILTERS_STORAGE_KEY = 'emr.cases.filters.v1';
const COLUMN_KEYS = new Set(CASE_COLUMNS.map((c) => c.key));

function loadStoredSort(): CasesSortState {
  try {
    const raw = sessionStorage.getItem(SORT_STORAGE_KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<CasesSortState>;
      if (typeof v.key === 'string' && COLUMN_KEYS.has(v.key) && (v.dir === 'asc' || v.dir === 'desc')) return { key: v.key, dir: v.dir };
    }
  } catch { /* corrupted or unavailable storage → default */ }
  return DEFAULT_SORT;
}

interface StoredFilters {
  readonly status: CaseStatus | '';
  readonly rnSel: readonly string[];
  readonly archived: boolean;
  readonly pageSize: number;
  readonly veteran: { readonly id: string; readonly label: string } | null;
}
function loadStoredFilters(): StoredFilters | null {
  try {
    const raw = sessionStorage.getItem(FILTERS_STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredFilters>;
    const statusOk = v.status === '' || (typeof v.status === 'string' && v.status in CASE_STATUS_LABELS);
    const rnOk = Array.isArray(v.rnSel) && v.rnSel.every((t) => typeof t === 'string');
    const vetOk = v.veteran == null || (typeof v.veteran.id === 'string' && typeof v.veteran.label === 'string');
    if (statusOk && rnOk && vetOk && typeof v.archived === 'boolean' && typeof v.pageSize === 'number' && PAGE_SIZES.includes(v.pageSize)) {
      return { status: v.status as CaseStatus | '', rnSel: v.rnSel as string[], archived: v.archived, pageSize: v.pageSize, veteran: v.veteran ?? null };
    }
  } catch { /* corrupted or unavailable storage → role defaults */ }
  return null;
}

function compareCaseValues(a: unknown, b: unknown, type: ColType): number {
  if (type === 'number') {
    const na = typeof a === 'number' ? a : Number(a);
    const nb = typeof b === 'number' ? b : Number(b);
    return (Number.isFinite(na) ? na : -Infinity) - (Number.isFinite(nb) ? nb : -Infinity);
  }
  if (type === 'date') {
    // EPOCH comparison — the load-bearing line for "sorted by actual timeline".
    const da = a ? Date.parse(String(a)) : NaN;
    const db = b ? Date.parse(String(b)) : NaN;
    return (Number.isNaN(da) ? -Infinity : da) - (Number.isNaN(db) ? -Infinity : db);
  }
  const sa = a === null || a === undefined ? '' : String(a);
  const sb = b === null || b === undefined ? '' : String(b);
  return sa.localeCompare(sb, undefined, { sensitivity: 'base' });
}

function sortCases(rows: readonly CaseLite[], sort: CasesSortState): CaseLite[] {
  const get = caseSortValue(sort.key);
  const type = caseSortType(sort.key);
  const dir = sort.dir === 'asc' ? 1 : -1;
  return rows.slice().sort((ra, rb) => {
    const primary = dir * compareCaseValues(get(ra), get(rb), type);
    return primary !== 0 ? primary : ra.id.localeCompare(rb.id); // deterministic tiebreak: id ASC
  });
}

// Deep-link params (D2 dashboard tiles, 2026-06-13). A dashboard tile navigates here with
// ?status=<one> (single-status tile) or ?statuses=<csv> (group tile). Parsed ONCE on mount and
// seeded into filter state so the list reproduces the tile's count. When present, the URL wins over
// the sticky sessionStorage filters (an explicit deep-link is a deliberate "show me THIS" action);
// with no params the stored filters drive, preserving the navigate-into-a-claim-and-back UX.
// Only canonical CASE_STATUS values are honored — an unknown one is ignored (no crash).
function parseStatusesParam(raw: string | null): readonly CaseStatus[] {
  if (!raw) return [];
  return raw.split(',').map((t) => t.trim()).filter((t) => t in CASE_STATUS_LABELS) as CaseStatus[];
}

export function CasesPage() {
  const navigate = useNavigate();
  const { role } = useAuth();
  // Deep-link override (parsed ONCE via lazy init, like storedFilters).
  const [searchParams] = useSearchParams();
  const [deepLink] = useState(() => {
    const statusesFromUrl = parseStatusesParam(searchParams.get('statuses'));
    const statusFromUrl = searchParams.get('status');
    const singleStatus = statusFromUrl && statusFromUrl in CASE_STATUS_LABELS ? (statusFromUrl as CaseStatus) : null;
    return { statuses: statusesFromUrl, status: singleStatus };
  });
  const hasDeepLink = deepLink.statuses.length > 0 || deepLink.status !== null;
  // Filters rehydrate from sessionStorage so navigating into a claim and back keeps the working
  // set (parsed ONCE via lazy useState — not per render). Cleared with the tab; page # excluded
  // on purpose (the reset-to-1 effect below fires on mount and would fight it). A deep-link from a
  // dashboard tile takes precedence over the stored filters for THIS mount.
  const [storedFilters] = useState(() => (hasDeepLink ? null : loadStoredFilters()));
  // A group-tile deep-link drives a multi-status filter that the single-status dropdown can't
  // express; we hold it separately and clear it the moment the RN touches the dropdown.
  const [statuses, setStatuses] = useState<readonly CaseStatus[]>(deepLink.statuses);
  const [status, setStatus] = useState<CaseStatus | ''>(deepLink.status ?? storedFilters?.status ?? '');
  const [vetQuery, setVetQuery] = useState('');
  const [veteran, setVeteran] = useState<{ id: string; label: string } | null>(storedFilters?.veteran ?? null);
  const [archived, setArchived] = useState(storedFilters?.archived ?? false); // show the Archive (soft-deleted claims)
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(storedFilters?.pageSize ?? 25);
  // RN filter (P3.3): [] = "All active" (param omitted). Default: admins see ALL active; everyone
  // else lands on their own cases (B-2). Tokens: RN_ME | RN_UNASSIGNED | <AppUser id>.
  const defaultRnSel: readonly string[] = role === 'admin' ? [] : [RN_ME];
  const [rnSel, setRnSel] = useState<readonly string[]>(storedFilters?.rnSel ?? defaultRnSel);
  // Sticky sort: rehydrate (default = Submitted, newest first) + persist on every change.
  const [sort, setSort] = useState<CasesSortState>(loadStoredSort);
  useEffect(() => { try { sessionStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(sort)); } catch { /* storage unavailable */ } }, [sort]);
  useEffect(() => {
    try { sessionStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify({ status, rnSel, archived, pageSize, veteran } satisfies StoredFilters)); } catch { /* storage unavailable */ }
  }, [status, rnSel, archived, pageSize, veteran]);

  // "Me" = my AppUser id (assignedRnId keys on it, NOT the Cognito sub) — resolved once via
  // /users/me. A login without an AppUser row 404s: degrade by hiding [Me] and falling back to
  // All active (no crash). staleTime Infinity: identity doesn't change mid-session.
  const me = useQuery({ queryKey: ['users', 'me'], queryFn: getMe, retry: false, staleTime: Infinity });
  const meId = me.data?.data.id ?? null;
  const meResolved = me.isSuccess || me.isError;
  // /users/me failed (e.g. 404: Cognito login without an AppUser row) → [Me] is meaningless. Prune
  // it from the selection so the default degrades to All active and the summary never lies.
  useEffect(() => {
    if (me.isError) setRnSel((sel) => (sel.includes(RN_ME) ? sel.filter((t) => t !== RN_ME) : sel));
  }, [me.isError]);
  const effectiveRnTokens = rnSel
    .filter((t) => t !== RN_ME || meId !== null)
    .map((t) => (t === RN_ME ? (meId as string) : t));
  const assignedRnParam = effectiveRnTokens.length > 0 ? effectiveRnTokens.join(',') : undefined;

  // Roster for the filter checkboxes + the '+' assign popup (same source CaseAssignmentPanel uses).
  const staffQuery = useQuery({ queryKey: ['users', 'ops_staff'], queryFn: () => listUsers({ role: 'ops_staff' }) });
  const rnRoster = staffQuery.data?.data ?? [];

  const debouncedVet = useDebounced(vetQuery, 300);
  // Reset to page 1 whenever a filter changes.
  const rnSelKey = rnSel.join(',');
  const statusesKey = statuses.join(',');
  useEffect(() => { setPage(1); }, [status, statusesKey, rnSelKey, veteran?.id, pageSize, archived]);

  const vetMatches = useQuery({
    queryKey: ['veteran-search', debouncedVet],
    queryFn: () => listVeterans(debouncedVet),
    enabled: debouncedVet.trim().length > 0 && veteran === null,
  });

  // A multi-status group-tile deep-link (statuses[]) supersedes the single-status dropdown.
  const statusesParam = statuses.length > 0 ? statuses : undefined;
  const cases = useQuery({
    queryKey: ['cases', { status, statuses: statusesParam?.join(',') ?? '', assignedRnId: assignedRnParam ?? '', veteranId: veteran?.id ?? '', archived, page, pageSize }],
    queryFn: () => listCases({
      ...(statusesParam ? { statuses: statusesParam } : status ? { status } : {}),
      ...(assignedRnParam && { assignedRnId: assignedRnParam }),
      ...(veteran && { veteranId: veteran.id }),
      ...(archived && { archived: true }),
      page,
      pageSize,
    }),
    // Don't fire an UNFILTERED query while [Me] is still resolving — it would flash every case.
    enabled: !rnSel.includes(RN_ME) || meResolved,
  });

  function clearFilters() { setStatus(''); setStatuses([]); setRnSel(defaultRnSel); setVetQuery(''); setVeteran(null); setArchived(false); }
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

  // RN-column '+' assign popup (P3.4): REAL assignment on the claim — same version-checked wiring
  // as the chart's CaseAssignmentPanel. The 409 stale-version cause must surface verbatim.
  const [assignCase, setAssignCase] = useState<CaseLite | null>(null);
  const assignRnMut = useMutation({
    mutationFn: ({ id, rnUserId, version }: { id: string; rnUserId: string; version: number }) => assignCaseRn(id, { rnUserId, version }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['cases'] }); setAssignCase(null); },
    onError: (e: unknown) => window.alert(`Could not assign the RN — ${describeApiError(e)}`),
  });

  // 3-state header cycle, except "default" is now the explicit timeline order (Submitted desc),
  // not raw server order (server = updatedAt desc, which reshuffles on every touch). On the
  // Submitted column itself desc IS the default, so it just toggles asc/desc.
  function onHeaderClick(key: string) {
    setSort((prev) => {
      if (prev.key !== key) return { key, dir: 'asc' };
      if (prev.dir === 'asc') return { key, dir: 'desc' };
      return key === DEFAULT_SORT.key ? { key, dir: 'asc' } : DEFAULT_SORT;
    });
  }
  const ariaSort = (key: string): 'ascending' | 'descending' | 'none' => (sort.key !== key ? 'none' : sort.dir === 'asc' ? 'ascending' : 'descending');
  const indicator = (key: string): '' | ' ▲' | ' ▼' => (sort.key !== key ? '' : sort.dir === 'asc' ? ' ▲' : ' ▼');
  const pageRows = cases.data?.data ?? [];
  const rows = sortCases(pageRows, sort);
  const pageTruncated = total > pageRows.length;
  function exportCsv() {
    // Cases is server-paginated, so this exports the CURRENT page only (after filters + sort).
    if (pageTruncated) console.warn(`cases CSV export: current page only (${pageRows.length} of ${total}); backend full-export is a follow-up.`);
    const headers = ['Case ID', 'Veteran', 'Condition', 'Type', 'Status', 'Records', 'Physician', 'RN', 'Submitted', 'Updated', 'Version'];
    const matrix = rows.map((c) => [
      c.id, c.veteran ? `${c.veteran.lastName}, ${c.veteran.firstName}` : c.veteranId, c.claimedCondition,
      CLAIM_TYPE_LABELS[c.claimType], CASE_STATUS_LABELS[c.status], c.recordsUploaded ? 'Received' : 'Pending', c.assignedPhysician?.fullName ?? '', c.assignedRn?.name ?? c.assignedRn?.email ?? '', c.createdAt, c.updatedAt, c.version,
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
        <select className="input" value={statuses.length > 0 ? '' : status} onChange={(e) => { setStatuses([]); setStatus(e.target.value as CaseStatus | ''); }}><option value="">{statuses.length > 0 ? `Grouped (${statuses.length} statuses)` : 'All statuses'}</option>{STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      </label>
      <RnFilterDropdown selection={rnSel} onChange={setRnSel} showMe={!me.isError} meId={meId} others={rnRoster.filter((u) => u.id !== meId)} />
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
            {/* Invoiced (Ryan 2026-06-12): the LABEL ITSELF flips to "Invoiced" in the same neutral
                format once the invoice email is out — no chip (his words: "just change ready for
                delivery to invoiced, keeping the same format"). */}
            <td className="px-4 py-3 text-center"><span className="text-xs font-medium text-slate-600" title={c.invoiced && c.status === 'delivered' ? 'The invoice email has been sent — awaiting the veteran’s payment.' : undefined}>{caseDisplayLabel(c.status, { invoiced: c.invoiced })}</span></td>
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
            <td className="px-4 py-3 text-slate-500" onClick={(e) => e.stopPropagation()}>
              {c.assignedRn ? (c.assignedRn.name ?? c.assignedRn.email) : (
                <button type="button" aria-label="Assign RN" title="Assign an RN" className="text-base leading-none text-slate-300 hover:text-indigo-600" onClick={() => setAssignCase(c)}>+</button>
              )}
            </td>
            {/* Submitted = absolute month-name date (Ryan 2026-06-11: "just put by date, not how long ago");
                Updated stays relative ("for updates keep how long ago"). Hover = full local timestamp. */}
            <td className="whitespace-nowrap px-4 py-3 text-slate-500" title={new Date(c.createdAt).toLocaleString()}>{formatAbsoluteDate(c.createdAt)}</td>
            <td className="px-4 py-3 text-slate-500" title={new Date(c.updatedAt).toLocaleString()}>{formatRelativeTime(c.updatedAt)}</td>
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

    {assignCase ? (
      <AssignRnPopup
        c={assignCase}
        rns={rnRoster}
        assigning={assignRnMut.isPending}
        onClose={() => setAssignCase(null)}
        onAssign={(rnUserId) => assignRnMut.mutate({ id: assignCase.id, rnUserId, version: assignCase.version })}
      />
    ) : null}
  </div></AppShell>;
}

// "Assigned RN" dropdown-checkbox filter (P3.3). Selection semantics: [] = All active (param
// omitted); otherwise any mix of [Me] / [Unassigned] / specific staff. "All active" is EXCLUSIVE —
// checking it clears the others, and checking anything else un-checks it (length > 0).
function RnFilterDropdown({ selection, onChange, showMe, meId, others }: {
  readonly selection: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
  readonly showMe: boolean; // false when /users/me 404'd (no AppUser row) — degrade, no [Me]
  readonly meId: string | null;
  readonly others: readonly StaffUser[];
}) {
  const [open, setOpen] = useState(false);
  const isAll = selection.length === 0;
  const toggle = (token: string) => onChange(selection.includes(token) ? selection.filter((t) => t !== token) : [...selection, token]);
  const labelFor = (token: string): string => {
    if (token === RN_ME) return 'Me';
    if (token === RN_UNASSIGNED) return 'Unassigned';
    if (token === meId) return 'Me';
    const u = others.find((o) => o.id === token);
    return u ? (u.name ?? u.email) : token;
  };
  const summary = isAll ? 'All active' : selection.map(labelFor).join(', ');
  const itemCls = 'flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-slate-50';
  return (
    <div className="relative block text-sm lg:w-56">
      <span className="mb-1 block font-medium text-slate-700">Assigned RN</span>
      <button type="button" className="input flex w-full items-center justify-between gap-2 text-left" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="truncate">{summary}</span><span aria-hidden="true" className="text-slate-400">▾</span>
      </button>
      {open ? <>
        {/* invisible click-away layer (the row sits inside the filter flexbox, so a document listener is overkill) */}
        <div className="fixed inset-0 z-10" aria-hidden="true" onClick={() => setOpen(false)} />
        <div className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-slate-200 bg-white p-1.5 shadow-lg">
          {showMe ? (
            <label className={itemCls}><input type="checkbox" checked={selection.includes(RN_ME)} onChange={() => toggle(RN_ME)} /> Me</label>
          ) : null}
          <label className={itemCls}><input type="checkbox" checked={selection.includes(RN_UNASSIGNED)} onChange={() => toggle(RN_UNASSIGNED)} /> Unassigned</label>
          {others.map((u) => (
            <label key={u.id} className={itemCls}><input type="checkbox" checked={selection.includes(u.id)} onChange={() => toggle(u.id)} /> <span className="truncate">{u.name ?? u.email}</span></label>
          ))}
          <div className="my-1 border-t border-slate-100" />
          <label className={itemCls}><input type="checkbox" checked={isAll} onChange={() => { if (!isAll) onChange([]); }} /> All active</label>
        </div>
      </> : null}
    </div>
  );
}

// '+' assign popup (P3.4): pick an ops_staff user → REAL version-checked assignment (assignCaseRn),
// mirroring the chart's Assignments panel. Backdrop/stopPropagation mirror QuickNotePopup.
function AssignRnPopup({ c, rns, assigning, onClose, onAssign }: {
  readonly c: CaseLite;
  readonly rns: readonly StaffUser[];
  readonly assigning: boolean;
  readonly onClose: () => void;
  readonly onAssign: (rnUserId: string) => void;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 p-6" onClick={onClose}>
      <div className="mx-auto mt-32 max-w-sm rounded-lg bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-900">Assign RN · {c.id}</h2>
          <button type="button" className="text-slate-400 hover:text-slate-600" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <p className="mt-0.5 text-xs text-slate-500">Assigns the RN liaison on the claim — same as the chart’s Assignments panel.</p>
        <ul className="mt-3 max-h-64 divide-y divide-slate-100 overflow-auto rounded-lg border border-slate-200">
          {rns.map((u) => (
            <li key={u.id}>
              <button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-slate-50 disabled:opacity-50" disabled={assigning} onClick={() => onAssign(u.id)}>{u.name ?? u.email}</button>
            </li>
          ))}
          {rns.length === 0 ? <li className="px-3 py-2 text-sm text-slate-500">No active staff found.</li> : null}
        </ul>
      </div>
    </div>
  );
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
