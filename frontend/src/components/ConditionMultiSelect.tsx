import { useEffect, useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getConditions, type ConditionGroup } from '../api/lookup';

const OTHER_VALUE = '__other__';

// A grouped multi-condition picker for clustered claims. An RN may pick MULTIPLE claimed conditions
// for ONE letter, but ONLY within a single body system (Hip + Lumbar/back = both Musculoskeletal;
// MDD + Anxiety = both Mental health). A cross-system condition needs a separate claim.
//
// Behaviour:
//  1. Once the first condition is selected, only that condition's SYSTEM group stays selectable —
//     other systems' options are disabled.
//  2. Selected conditions render as removable chips.
//  3. A persistent helper note explains the single-body-system rule.
//  4. An "Other (type manually)" escape hatch yields a SINGLE free-text condition; choosing it
//     clears + locks the canonical multi-select (free-text is one condition, exempt from grouping).
//  5. Emits the value as string[]; the parent treats [0] as the primary.
//
// Controlled: `value` is the current string[]; `onChange` fires with the next string[].
export function ConditionMultiSelect({
  value,
  onChange,
  label = 'Claimed conditions',
  id: idProp,
}: {
  readonly value: readonly string[];
  readonly onChange: (next: string[]) => void;
  readonly label?: string;
  readonly id?: string;
}) {
  const autoId = useId();
  const selectId = idProp ?? `condition-multi-${autoId}`;
  const manualId = `${selectId}-manual`;
  const catalog = useQuery({ queryKey: ['lookup', 'conditions'], queryFn: getConditions, staleTime: 60 * 60 * 1000 });
  const groups: readonly ConditionGroup[] = catalog.data?.groups ?? [];

  // value -> system lookup so we can lock the picker to the first chosen condition's system.
  const systemByValue = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of groups) for (const c of g.conditions) map.set(c.value, g.system);
    return map;
  }, [groups]);

  const canonicalValues = useMemo(() => {
    const set = new Set<string>();
    for (const g of groups) for (const c of g.conditions) set.add(c.value);
    return set;
  }, [groups]);

  // Manual (free-text) mode: a single typed condition that bypasses the canonical grouping. Sticky.
  const [manualMode, setManualMode] = useState(false);
  const [manualText, setManualText] = useState('');
  useEffect(() => {
    // If the preset value is a single non-canonical entry, treat it as free-text.
    if (groups.length > 0 && value.length === 1 && value[0] && !canonicalValues.has(value[0])) {
      setManualMode(true);
      setManualText(value[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups.length]);
  useEffect(() => {
    if (catalog.isError) setManualMode(true);
  }, [catalog.isError]);

  // The locked system = the system of the first selected canonical condition (null = nothing yet).
  const lockedSystem = useMemo(() => {
    for (const v of value) {
      const s = systemByValue.get(v);
      if (s) return s;
    }
    return null;
  }, [value, systemByValue]);

  const selectedSet = useMemo(() => new Set(value), [value]);

  function addCondition(next: string) {
    if (next === OTHER_VALUE) {
      setManualMode(true);
      setManualText('');
      onChange([]); // clear the canonical multi-select when switching to free-text
      return;
    }
    if (!next || selectedSet.has(next)) return;
    onChange([...value, next]);
  }

  function removeCondition(target: string) {
    onChange(value.filter((v) => v !== target));
  }

  function onManualChange(text: string) {
    setManualText(text);
    const trimmed = text.trim();
    onChange(trimmed.length > 0 ? [trimmed] : []);
  }

  function exitManualMode() {
    setManualMode(false);
    setManualText('');
    onChange([]);
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-500">
        One letter covers conditions in a single body system. A different body system needs a separate claim.
      </p>

      {manualMode ? (
        <div className="space-y-2">
          <input
            id={manualId}
            aria-label={`${label} (manual entry)`}
            className="input"
            placeholder="Type the condition name"
            value={manualText}
            onChange={(e) => onManualChange(e.target.value)}
          />
          <button type="button" className="text-xs text-indigo-600" onClick={exitManualMode}>
            ← Back to the condition list
          </button>
        </div>
      ) : (
        <>
          <select
            id={selectId}
            aria-label={label}
            className="input"
            value=""
            onChange={(e) => { addCondition(e.target.value); e.target.value = ''; }}
            disabled={catalog.isLoading}
          >
            <option value="">{catalog.isLoading ? 'Loading conditions…' : 'Add a condition…'}</option>
            {groups.map((g) => {
              // Lock to the first-picked condition's system once one is selected.
              const groupDisabled = lockedSystem !== null && g.system !== lockedSystem;
              return (
                <optgroup key={g.system} label={groupDisabled ? `${g.system} (different body system)` : g.system}>
                  {g.conditions.map((c) => (
                    <option key={c.value} value={c.value} disabled={groupDisabled || selectedSet.has(c.value)}>
                      {c.label}{c.noBvaData ? ' (no BVA data)' : ''}
                    </option>
                  ))}
                </optgroup>
              );
            })}
            <option value={OTHER_VALUE}>Other (type manually)…</option>
          </select>

          {value.length > 0 ? (
            <ul className="flex flex-wrap gap-2" aria-label={`${label} selected`}>
              {value.map((v) => (
                <li key={v} className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs text-indigo-800">
                  <span>{v}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${v}`}
                    className="text-indigo-500 hover:text-indigo-700"
                    onClick={() => removeCondition(v)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}

      {catalog.isError ? (
        <p className="text-xs text-rose-600">Could not load the condition list — use “Other” to type the condition.</p>
      ) : null}
    </div>
  );
}
