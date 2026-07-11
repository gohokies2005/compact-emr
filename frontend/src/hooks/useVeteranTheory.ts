// useVeteranTheory (Ryan 2026-07-11, Part B "Ankle nowhere") — the ONE owner of the veteran-theory query,
// shared by the desktop (PhysicianLetterReadyPanel) and mobile (PhysicianMobileReviewPage) physician review
// surfaces so the two CANNOT drift and a case shown in both fetches once (React Query dedupes by key).
//
// COST HYGIENE: the restatement is derived from the veteran's statement, which does not change while the
// physician reads. `staleTime: Infinity` + `refetchOnWindowFocus: false` mean a normal open (and every
// window-focus / remount) is served from cache — the paid Sonnet call fires at most once per case per session,
// never on refetch. On null (flag off / ungrounded / failure) the panel falls back to the deterministic line.
import { useQuery } from '@tanstack/react-query';
import { getVeteranTheory, type VeteranTheoryData } from '../api/veteran-theory';

export interface UseVeteranTheory {
  readonly data: VeteranTheoryData | null;
  readonly isLoading: boolean;
}

export function useVeteranTheory(caseId: string, opts?: { readonly enabled?: boolean }): UseVeteranTheory {
  const q = useQuery({
    queryKey: ['case', caseId, 'veteran-theory'],
    queryFn: () => getVeteranTheory(caseId),
    enabled: (opts?.enabled ?? true) && caseId.length > 0,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const d = q.data?.data ?? null;
  const data: VeteranTheoryData | null = d && typeof d.theory === 'string' && d.theory.trim().length > 0 ? d : null;
  return { data, isLoading: q.isLoading };
}
