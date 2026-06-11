import { apiGet } from './client';
import type { CaseViability } from './case-viability';

export type StrategyTier = 'Strong' | 'Plausible' | 'Thin' | 'Stop';

export interface StrategyCriterion {
  readonly key: string;
  readonly label: string;
  readonly pass: boolean;
  readonly detail: string;
  /** 'amber' = distinct caution state (veteran-stated-only in-service hook) — renders △, not a red ✗. */
  readonly tone?: 'amber';
}

export interface PathwaySuggestion {
  readonly kind: 'direct' | 'secondary';
  readonly anchor: string | null;
  readonly basis: string | null;
  readonly differsFromCurrent: boolean;
}

export interface StrategyPreview {
  readonly evaluable: boolean;
  readonly recommendedPathway: PathwaySuggestion;
  readonly primaryArgument: string;
  readonly proposedMechanism: string | null;
  readonly anchor: string | null;
  readonly tier: StrategyTier;
  readonly criteria: readonly StrategyCriterion[];
  readonly summary: string;
  /**
   * The viability-engine read riding the same response (P1 re-source 2026-06-11) — band-drives the
   * headline chip on secondary claims. null/absent = fail-open → legacy criteria copy.
   */
  readonly viability?: CaseViability | null;
}

export function getStrategyPreview(caseId: string): Promise<{ data: StrategyPreview }> {
  return apiGet(`/api/v1/cases/${encodeURIComponent(caseId)}/strategy-preview`);
}
