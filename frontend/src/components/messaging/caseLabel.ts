import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { listCases } from '../../api/cases';
import { formatConditionLabel } from '../../lib/conditionLabel';
import { formatNameLastFirst } from '../../lib/format';

// C4/C4c messaging, 2026-06-14 — caseId -> "Veteran — Condition" resolver.
//
// Threads carry only a raw `caseId` (see InboxThreadSummary/ThreadDetail), so the inbox list, the
// ThreadView header, and the chart-tab locked-case chip were all rendering a bare UUID. This hook
// resolves the DISTINCT caseIds present on screen into a friendly "Last, First — Condition" label
// using the SAME formatters the CasePicker chip already uses (formatNameLastFirst + formatConditionLabel)
// so the link reads identically everywhere it appears.
//
// Why per-id /cases/:id is NOT used here: the inbox can reference many distinct cases at once, and
// case access is gated server-side — a staff member listing the inbox may legitimately not have detail
// access to every linked case (a 404/403 per id would noise the console + the label). Instead we resolve
// against the CASE LIST the viewer can already see (listCases, page-bounded), which is a single cached
// query shared with the rest of the app, and fall back to the raw caseId for anything not in view. The
// label is cosmetic — an unresolved id degrades to the UUID exactly as before, never to a broken state.

export interface CaseLabelParts {
  readonly veteran: string; // "Last, First" (or fallback) — empty string when unknown
  readonly condition: string; // formatted condition label — empty string when unknown
  readonly label: string; // "Veteran — Condition", or just one side, or the raw id when unresolved
}

// Build a "Veteran — Condition" string from the pieces, degrading gracefully when a side is missing.
export function joinCaseLabel(veteran: string, condition: string, fallback: string): string {
  const v = veteran.trim();
  const c = condition.trim();
  if (v && c) return `${v} — ${c}`;
  return v || c || fallback;
}

// Resolve a single caseId against a prebuilt map (map keys are caseIds). Pure — easy to unit-test.
export function resolveCaseLabel(
  caseId: string,
  byId: Readonly<Record<string, CaseLabelParts>>,
): CaseLabelParts {
  return byId[caseId] ?? { veteran: '', condition: '', label: caseId };
}

// Map of caseId -> label parts for every case the viewer can see. One shared, cached listCases query
// (keyed 'cases'/'directory-labels') feeds all messaging surfaces; the page size is generous enough to
// cover an active inbox without paging. Unknown ids simply aren't in the map (callers fall back to the
// raw id via resolveCaseLabel).
export function useCaseLabelDirectory(enabled = true): Readonly<Record<string, CaseLabelParts>> {
  const [casesQuery] = useQueries({
    queries: [
      {
        queryKey: ['cases', 'directory-labels'],
        queryFn: () => listCases({ pageSize: 200, archived: 'all' as const }),
        enabled,
        staleTime: 60_000,
      },
    ],
  });

  return useMemo(() => {
    const byId: Record<string, CaseLabelParts> = {};
    for (const c of casesQuery.data?.data ?? []) {
      const veteran = formatNameLastFirst(c.veteran?.firstName, c.veteran?.lastName, '');
      const condition = formatConditionLabel(c.claimedCondition);
      byId[c.id] = { veteran, condition, label: joinCaseLabel(veteran, condition, c.id) };
    }
    return byId;
  }, [casesQuery.data]);
}
