// useHaltExplanation (Dr. Kasky 2026-07-02) — the ONE owner of the halt-explanation query, shared by the
// OpsHeldPanel and Gate2HaltPanel so a case shown in both surfaces fetches once (React Query dedupes by key).
//
// Returns a resolved `explanation` (only when the backend produced a usable plain-language answer) plus the
// loading flag. When the case is not paused, the LLM was unavailable, or the call failed, the backend returns
// { available: false } → `explanation` is null and the panel falls back to its raw/technical halt message.

import { useQuery } from '@tanstack/react-query';
import { getHaltExplanation } from '../api/halt-explanation';

export interface HaltExplanation {
  readonly summary: string;
  readonly what_to_do: string;
  readonly confidence: 'high' | 'medium' | 'low';
}

export interface UseHaltExplanation {
  readonly explanation: HaltExplanation | null;
  readonly isLoading: boolean;
}

export function useHaltExplanation(caseId: string, opts?: { readonly enabled?: boolean }): UseHaltExplanation {
  const q = useQuery({
    queryKey: ['case', caseId, 'halt-explanation'],
    queryFn: () => getHaltExplanation(caseId),
    enabled: (opts?.enabled ?? true) && caseId.length > 0,
    retry: false,
    // The explanation is derived from the halt reason + framing; those don't change while the RN reads. The
    // backend also caches, so a short client staleTime avoids re-billing on remount.
    staleTime: 5 * 60_000,
  });
  const d = q.data?.data;
  const explanation: HaltExplanation | null =
    d && d.available !== false && typeof d.summary === 'string' && d.summary.length > 0 && typeof d.what_to_do === 'string' && d.what_to_do.length > 0
      ? { summary: d.summary, what_to_do: d.what_to_do, confidence: d.confidence ?? 'medium' }
      : null;
  return { explanation, isLoading: q.isLoading };
}
