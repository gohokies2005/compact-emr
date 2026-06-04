// Shared client-side column sort for list tables (Cases, Veterans). 3-state per column:
// asc -> desc -> default (server/source order). Added 2026-06-03 for Option B1.
// IMPORTANT: sortRows COPIES before sorting — never mutate the source array (it's the
// TanStack Query cache object; in-place .sort() corrupts it on refetch/pagination).
import { useCallback, useState } from 'react';

export type SortDir = 'asc' | 'desc' | null; // null = default (source order)
export type ColType = 'text' | 'date' | 'number';
export interface SortState {
  readonly key: string | null;
  readonly dir: SortDir;
}

function compareValues(a: unknown, b: unknown, type: ColType): number {
  if (type === 'number') {
    const na = typeof a === 'number' ? a : Number(a);
    const nb = typeof b === 'number' ? b : Number(b);
    return (Number.isFinite(na) ? na : -Infinity) - (Number.isFinite(nb) ? nb : -Infinity);
  }
  if (type === 'date') {
    const da = a ? Date.parse(String(a)) : NaN;
    const db = b ? Date.parse(String(b)) : NaN;
    return (Number.isNaN(da) ? -Infinity : da) - (Number.isNaN(db) ? -Infinity : db);
  }
  const sa = a === null || a === undefined ? '' : String(a);
  const sb = b === null || b === undefined ? '' : String(b);
  return sa.localeCompare(sb, undefined, { sensitivity: 'base' });
}

export function useColumnSort() {
  const [sort, setSort] = useState<SortState>({ key: null, dir: null });

  const onHeaderClick = useCallback((key: string) => {
    setSort((prev) => {
      if (prev.key !== key) return { key, dir: 'asc' };
      if (prev.dir === 'asc') return { key, dir: 'desc' };
      return { key: null, dir: null }; // desc (or anything) -> back to default
    });
  }, []);

  const sortRows = useCallback(
    <T,>(
      rows: readonly T[],
      accessor: (key: string) => (row: T) => unknown,
      typeOf: (key: string) => ColType,
    ): T[] => {
      if (sort.key === null || sort.dir === null) return rows.slice();
      const get = accessor(sort.key);
      const type = typeOf(sort.key);
      const dir = sort.dir === 'asc' ? 1 : -1;
      return rows.slice().sort((ra, rb) => dir * compareValues(get(ra), get(rb), type));
    },
    [sort],
  );

  const ariaSort = useCallback(
    (key: string): 'ascending' | 'descending' | 'none' =>
      sort.key !== key || sort.dir === null
        ? 'none'
        : sort.dir === 'asc'
          ? 'ascending'
          : 'descending',
    [sort],
  );

  const indicator = useCallback(
    (key: string): '' | ' ▲' | ' ▼' =>
      sort.key !== key || sort.dir === null ? '' : sort.dir === 'asc' ? ' ▲' : ' ▼',
    [sort],
  );

  return { sort, onHeaderClick, sortRows, ariaSort, indicator };
}
