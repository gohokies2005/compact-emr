import { useEffect, useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getConditions, type ConditionGroup } from '../api/lookup';

const OTHER_VALUE = '__other__';

// A searchable grouped condition picker. Offers the canonical CDS condition catalog (grouped by
// body system) so an RN's pick resolves to a CDS-recognized key — plus an "Other (type manually)"
// escape hatch so an unlisted condition is never blocked. Controlled: `value` is the canonical (or
// free-typed) condition string; `onChange` fires with that string.
//
// Renders a native <select> (with <optgroup>) wired to the given `label` for accessibility, so
// callers/tests can resolve it with getByLabelText(label). When "Other" is chosen a free-text
// input appears (labelled `${label} (manual entry)`).
export function ConditionSelect({
  value,
  onChange,
  label,
  placeholder = 'Select a condition…',
  id: idProp,
}: {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly label: string;
  readonly placeholder?: string;
  readonly id?: string;
}) {
  const autoId = useId();
  const selectId = idProp ?? `condition-select-${autoId}`;
  const manualId = `${selectId}-manual`;
  const catalog = useQuery({ queryKey: ['lookup', 'conditions'], queryFn: getConditions, staleTime: 60 * 60 * 1000 });
  const groups: readonly ConditionGroup[] = catalog.data?.groups ?? [];

  const canonicalValues = useMemo(() => {
    const set = new Set<string>();
    for (const g of groups) for (const c of g.conditions) set.add(c.value);
    return set;
  }, [groups]);

  // "Manual mode" = the current value isn't a canonical option (and isn't empty), OR the user
  // explicitly picked "Other". We keep it sticky once on so typing a partial value doesn't snap
  // the select back the moment it happens to (not) match.
  const [manualMode, setManualMode] = useState(false);
  useEffect(() => {
    // Once the catalog has loaded, if there's a preset value that isn't canonical, switch to manual.
    if (groups.length > 0 && value && !canonicalValues.has(value)) setManualMode(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups.length]);
  useEffect(() => {
    // If the catalog fails to load, fall back to free-text so the form is never blocked.
    if (catalog.isError) setManualMode(true);
  }, [catalog.isError]);

  const selectValue = manualMode ? OTHER_VALUE : canonicalValues.has(value) ? value : value === '' ? '' : OTHER_VALUE;

  function onSelectChange(next: string) {
    if (next === OTHER_VALUE) {
      setManualMode(true);
      onChange('');
      return;
    }
    setManualMode(false);
    onChange(next);
  }

  return (
    <div className="space-y-2">
      <select
        id={selectId}
        aria-label={label}
        className="input"
        value={selectValue}
        onChange={(e) => onSelectChange(e.target.value)}
        disabled={catalog.isLoading}
      >
        <option value="">{catalog.isLoading ? 'Loading conditions…' : placeholder}</option>
        {groups.map((g) => (
          <optgroup key={g.system} label={g.system}>
            {g.conditions.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </optgroup>
        ))}
        <option value={OTHER_VALUE}>Other (type manually)…</option>
      </select>
      {manualMode ? (
        <input
          id={manualId}
          aria-label={`${label} (manual entry)`}
          className="input"
          placeholder="Type the condition name"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : null}
      {catalog.isError ? (
        <p className="text-xs text-rose-600">Could not load the condition list — use “Other” to type the condition.</p>
      ) : null}
    </div>
  );
}
