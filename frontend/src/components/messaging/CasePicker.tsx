import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listVeterans } from '../../api/veterans';
import { listCases } from '../../api/cases';
import { formatConditionLabel } from '../../lib/conditionLabel';
import { formatNameLastFirst } from '../../lib/format';

// Optional case link. Default OFF — a thread is unlinked unless the user opts in. When toggled on, a
// Cases-style VETERAN search reveals; clearly skippable (un-toggle clears the selection).
//
// The veteran NAME is the search + display layer; the thread is still linked by the EXISTING caseId
// mechanism the backend supports (StaffMessage.caseId — no veteranId column). Flow:
//   1. Debounced name type-ahead over listVeterans({ q }) — typing "Sm" lists Smith, Smalls…
//      Each row shows the veteran's name + a light secondary line of their condition(s)/case so a
//      veteran with multiple claims is distinguishable WITHOUT showing a claim number.
//   2. On selecting a veteran we resolve their case(s) via listCases({ veteranId }):
//        - exactly one case  → link it directly, locked chip shows "Name — Condition".
//        - multiple cases    → expand to per-case rows ("Smith — OSA", "Smith — PTSD") so the
//          selection still resolves to a single caseId.
export interface SelectedCase {
  readonly id: string;
  readonly label: string;
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

interface PendingVeteran {
  readonly id: string;
  readonly name: string;
}

export function CasePicker({
  value,
  onChange,
}: {
  readonly value: SelectedCase | null;
  readonly onChange: (next: SelectedCase | null) => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [query, setQuery] = useState('');
  // When a veteran with >1 case is picked we hold them here and show their per-case rows.
  const [pendingVeteran, setPendingVeteran] = useState<PendingVeteran | null>(null);
  const debounced = useDebounced(query, 300);

  const vetMatches = useQuery({
    queryKey: ['messages', 'veteran-search', debounced],
    queryFn: () => listVeterans(debounced),
    enabled: enabled && debounced.trim().length > 0 && value === null && pendingVeteran === null,
  });

  // Cases for the veteran the user just tapped — resolves the name back to a concrete caseId.
  const vetCases = useQuery({
    queryKey: ['messages', 'veteran-cases', pendingVeteran?.id ?? ''],
    queryFn: () => listCases({ veteranId: pendingVeteran!.id, pageSize: 50 }),
    enabled: enabled && pendingVeteran !== null && value === null,
  });

  // Auto-link when the picked veteran turns out to have exactly one case — no second tap needed.
  useEffect(() => {
    if (!pendingVeteran || value !== null) return;
    const list = vetCases.data?.data;
    if (!list || list.length !== 1) return;
    const only = list[0]!;
    onChange({ id: only.id, label: `${pendingVeteran.name} — ${formatConditionLabel(only.claimedCondition)}` });
    setPendingVeteran(null);
    setQuery('');
  }, [vetCases.data, pendingVeteran, value, onChange]);

  function toggle(on: boolean) {
    setEnabled(on);
    if (!on) {
      onChange(null);
      setQuery('');
      setPendingVeteran(null);
    }
  }

  function clearSelection() {
    onChange(null);
    setQuery('');
    setPendingVeteran(null);
  }

  const veteranRows = (vetMatches.data?.data ?? []).slice(0, 6);
  const caseRows = vetCases.data?.data ?? [];
  const multiCase = pendingVeteran !== null && caseRows.length > 1;

  return (
    <div>
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" checked={enabled} onChange={(e) => toggle(e.target.checked)} />
        Link a case (optional)
      </label>
      {enabled ? (
        <div className="relative mt-2">
          {value ? (
            <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
              <span className="text-slate-900">{value.label}</span>
              <button type="button" className="text-xs text-indigo-600" onClick={clearSelection}>
                Clear
              </button>
            </div>
          ) : pendingVeteran ? (
            // Veteran chosen, resolving / picking which of their cases to link.
            <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
              <span className="text-slate-900">{pendingVeteran.name}</span>
              <button type="button" className="text-xs text-indigo-600" onClick={clearSelection}>
                Change
              </button>
            </div>
          ) : (
            <input
              className="input"
              aria-label="Search veterans"
              placeholder="Search veteran by name…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}

          {/* Stage 1: veteran name matches. */}
          {!value && !pendingVeteran && debounced.trim() && veteranRows.length > 0 ? (
            <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
              {veteranRows.map((v) => {
                const name = formatNameLastFirst(v.firstName, v.lastName, v.id);
                return (
                  <li key={v.id}>
                    <button
                      type="button"
                      className="flex w-full justify-between px-3 py-2 text-left text-sm hover:bg-slate-50"
                      onClick={() => {
                        setPendingVeteran({ id: v.id, name });
                        setQuery('');
                      }}
                    >
                      <span className="text-slate-900">{name}</span>
                      <span className="text-slate-500">
                        {v.activeCases === 1 ? '1 case' : `${v.activeCases ?? 0} cases`}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {/* Stage 2: per-case rows for a multi-case veteran. */}
          {!value && multiCase ? (
            <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
              {caseRows.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className="flex w-full justify-between px-3 py-2 text-left text-sm hover:bg-slate-50"
                    onClick={() =>
                      onChange({ id: c.id, label: `${pendingVeteran!.name} — ${formatConditionLabel(c.claimedCondition)}` })
                    }
                  >
                    <span className="text-slate-900">{pendingVeteran!.name}</span>
                    <span className="text-slate-500">{formatConditionLabel(c.claimedCondition)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {pendingVeteran && !value && !vetCases.isLoading && caseRows.length === 0 ? (
            <p className="mt-1 text-xs text-amber-600">This veteran has no cases to link. Choose another, or leave the link off.</p>
          ) : (
            <p className="mt-1 text-xs text-slate-400">Leave this off to send an unlinked message.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
