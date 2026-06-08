import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listUsers } from '../../api/users';
import { listPhysicians } from '../../api/physicians';
import type { RecipientAlias, RecipientKind, SendRecipient } from '../../api/messaging';

// Chip-input type-ahead over the UNION of staff users (listUsers) + physicians (listPhysicians). The
// cross-role key is `sub`. Role aliases ("All RNs"/"All Physicians"/"Admins") are selectable options
// that send as { alias, kind } rather than a concrete sub. Mirrors the Cases veteran-search autocomplete
// (debounced filter -> dropdown of buttons -> selected pills).
export interface SelectedRecipient {
  readonly key: string; // sub or `alias:<alias>` — local de-dup key
  readonly label: string;
  readonly kind: RecipientKind;
  readonly send: SendRecipient;
}

interface Option {
  readonly key: string;
  readonly label: string;
  readonly sublabel: string;
  readonly toSend: (kind: RecipientKind) => SendRecipient;
}

const ALIAS_OPTIONS: readonly { alias: RecipientAlias; label: string }[] = [
  { alias: 'all_rns', label: 'All RNs' },
  { alias: 'all_physicians', label: 'All Physicians' },
  { alias: 'admin', label: 'Admins' },
];

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export function RecipientMultiSelect({
  selected,
  onChange,
}: {
  readonly selected: readonly SelectedRecipient[];
  readonly onChange: (next: readonly SelectedRecipient[]) => void;
}) {
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query, 250);

  const usersQuery = useQuery({ queryKey: ['users', 'all'], queryFn: () => listUsers() });
  const physiciansQuery = useQuery({ queryKey: ['physicians', 'all'], queryFn: () => listPhysicians() });

  const options = useMemo<Option[]>(() => {
    const opts: Option[] = ALIAS_OPTIONS.map((a) => ({
      key: `alias:${a.alias}`,
      label: a.label,
      sublabel: 'Group',
      toSend: (kind) => ({ alias: a.alias, kind }),
    }));
    for (const u of usersQuery.data?.data ?? []) {
      // Staff users carry `id` (the app-user id); the cross-role key the backend wants is the Cognito
      // sub. Staff list exposes it as the row id in this contract's picker union — guard against missing.
      const sub = u.id;
      opts.push({
        key: sub,
        label: u.name ?? u.email,
        sublabel: u.roles.includes('ops_staff') ? 'RN' : u.roles.includes('admin') ? 'Admin' : u.roles.join(', '),
        toSend: (kind) => ({ sub, kind }),
      });
    }
    for (const p of physiciansQuery.data?.data ?? []) {
      if (!p.cognitoSub) continue; // a physician without a Cognito identity can't be a recipient
      opts.push({
        key: p.cognitoSub,
        label: p.fullName,
        sublabel: 'Physician',
        toSend: (kind) => ({ sub: p.cognitoSub as string, kind }),
      });
    }
    return opts;
  }, [usersQuery.data, physiciansQuery.data]);

  const selectedKeys = useMemo(() => new Set(selected.map((s) => s.key)), [selected]);

  const matches = useMemo(() => {
    const q = debounced.trim().toLowerCase();
    if (!q) return [];
    return options
      .filter((o) => !selectedKeys.has(o.key))
      .filter((o) => o.label.toLowerCase().includes(q) || o.sublabel.toLowerCase().includes(q))
      .slice(0, 6);
  }, [debounced, options, selectedKeys]);

  function add(option: Option, kind: RecipientKind) {
    onChange([...selected, { key: option.key, label: option.label, kind, send: option.toSend(kind) }]);
    setQuery('');
  }

  function remove(key: string) {
    onChange(selected.filter((s) => s.key !== key));
  }

  function toggleKind(key: string) {
    onChange(
      selected.map((s) =>
        s.key === key
          ? (() => {
              const nextKind: RecipientKind = s.kind === 'to' ? 'cc' : 'to';
              return { ...s, kind: nextKind, send: { ...s.send, kind: nextKind } as SendRecipient };
            })()
          : s,
      ),
    );
  }

  return (
    <div className="relative">
      {selected.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2">
          {selected.map((s) => (
            <span
              key={s.key}
              className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-700"
            >
              {s.label}
              <button
                type="button"
                className="rounded bg-white px-1 text-[10px] font-medium uppercase text-indigo-600 hover:bg-indigo-50"
                title="Toggle To / Cc"
                aria-label={`Toggle ${s.label} between To and Cc`}
                onClick={() => toggleKind(s.key)}
              >
                {s.kind}
              </button>
              <button
                type="button"
                aria-label={`Remove ${s.label}`}
                className="text-slate-400 hover:text-rose-600"
                onClick={() => remove(s.key)}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <input
        className="input"
        aria-label="Add recipients"
        placeholder="Add people or a group (e.g. All RNs)…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {matches.length > 0 ? (
        <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
          {matches.map((o) => (
            <li key={o.key} className="flex items-center justify-between px-3 py-2 hover:bg-slate-50">
              <button type="button" className="flex flex-1 items-center gap-2 text-left" onClick={() => add(o, 'to')}>
                <span className="text-slate-900">{o.label}</span>
                <span className="text-xs text-slate-400">{o.sublabel}</span>
              </button>
              <button
                type="button"
                className="ml-2 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase text-slate-500 hover:bg-slate-100"
                title="Add as Cc"
                onClick={() => add(o, 'cc')}
              >
                Cc
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
