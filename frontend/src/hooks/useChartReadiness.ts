// useChartReadiness (2026-06-16, Phase 2) — the ONE owner of the chart-readiness query.
//
// Lifted out of SendToDrafterPanel so BOTH the page (the guaranteed always-mounted observer — keeps
// the 8s poll alive after the panel unmounts when a draft goes in-flight) and the panel call it.
// React Query dedupes by queryKey, so N callers = one fetch + one poll while ≥1 observer is mounted.
//
// Returns the RAW query truth (deriveReadiness) — it deliberately does NOT compute `stillBuilding`
// (that folds in the panel's mutation-armed flag and would re-create the auto-resume dead-spot bug).
// The panel ORs its local `awaitingAutoResume` into a LOCAL stillBuilding; the auto-resume effect
// gates on this hook's raw `buildingFromExtraction`.

import { useQuery } from '@tanstack/react-query';
import { getChartReadiness, type ChartReadinessResult } from '../api/chart-readiness';
import { deriveReadiness, readinessPollInterval, type DerivedReadiness } from '../lib/chartReadiness';

export interface UseChartReadiness extends DerivedReadiness {
  /** The raw payload — for the few banner reads that need extractionState / reason verbatim. */
  readonly readiness: ChartReadinessResult | undefined;
  readonly isLoading: boolean;
  readonly isError: boolean;
}

export function useChartReadiness(caseId: string, opts?: { readonly enabled?: boolean }): UseChartReadiness {
  const q = useQuery({
    queryKey: ['case', caseId, 'chart-readiness'],
    queryFn: () => getChartReadiness(caseId),
    enabled: (opts?.enabled ?? true) && caseId.length > 0,
    // Poll while building so the draft button unlocks itself; stops once settled. Same predicate as before.
    refetchInterval: (query) => readinessPollInterval(query.state.data?.data),
  });
  const data = q.data?.data;
  return { ...deriveReadiness(data), readiness: data, isLoading: q.isLoading, isError: q.isError };
}
