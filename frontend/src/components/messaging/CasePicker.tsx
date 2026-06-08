import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listCases } from '../../api/cases';
import { formatConditionLabel } from '../../lib/conditionLabel';

// Optional case link. Default OFF — a thread is unlinked unless the user opts in. When toggled on, a
// Cases-style search reveals; clearly skippable (un-toggle clears the selection). Mirrors the Cases
// veteran-search autocomplete shape (debounced query -> dropdown of buttons -> selected pill).
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

export function CasePicker({
  value,
  onChange,
}: {
  readonly value: SelectedCase | null;
  readonly onChange: (next: SelectedCase | null) => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query, 300);

  const matches = useQuery({
    queryKey: ['messages', 'case-search', debounced],
    queryFn: () => listCases({ page: 1, pageSize: 5 }),
    enabled: enabled && debounced.trim().length > 0 && value === null,
  });

  // Client-side filter the page by id/condition (the cases list endpoint has no free-text param here).
  const filtered = (matches.data?.data ?? [])
    .filter((c) => {
      const q = debounced.trim().toLowerCase();
      return c.id.toLowerCase().includes(q) || c.claimedCondition.toLowerCase().includes(q);
    })
    .slice(0, 5);

  function toggle(on: boolean) {
    setEnabled(on);
    if (!on) {
      onChange(null);
      setQuery('');
    }
  }

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
              <button
                type="button"
                className="text-xs text-indigo-600"
                onClick={() => {
                  onChange(null);
                  setQuery('');
                }}
              >
                Clear
              </button>
            </div>
          ) : (
            <input
              className="input"
              aria-label="Search cases"
              placeholder="Search case by ID or condition…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          {!value && debounced.trim() && filtered.length > 0 ? (
            <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
              {filtered.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className="flex w-full justify-between px-3 py-2 text-left text-sm hover:bg-slate-50"
                    onClick={() => onChange({ id: c.id, label: `${c.id} · ${formatConditionLabel(c.claimedCondition)}` })}
                  >
                    <span className="text-slate-900">{c.id}</span>
                    <span className="text-slate-500">{formatConditionLabel(c.claimedCondition)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mt-1 text-xs text-slate-400">Leave this off to send an unlinked message.</p>
        </div>
      ) : null}
    </div>
  );
}
