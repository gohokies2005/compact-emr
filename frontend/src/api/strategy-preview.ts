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

// E5 trustworthy viability (2026-06-13) — INPUT VISIBILITY. The exact fact set the verdict was
// computed from; absent on legacy payloads (the card hides the section).
export interface StrategyInputSet {
  readonly scConditions: readonly string[];
  readonly medications: ReadonlyArray<{ readonly drugName: string; readonly indication: string | null }>;
  readonly activeProblems: readonly string[];
  readonly keyFacts: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  readonly factCount: number;
}

// E5 — INTERMEDIARY CHECK. A two-hop SC → intermediary → claimed pathway recovered when no direct
// granted-SC pair existed. `pathway` null = searched but none found (the honest "we looked").
export interface ChainHop {
  readonly from: string;
  readonly to: string;
  readonly tier: 'high' | 'moderate' | 'low';
}
export interface ChainPathway {
  readonly anchor: string;
  readonly intermediary: string;
  readonly hops: readonly [ChainHop, ChainHop];
  readonly intermediarySource: 'comorbid_dx' | 'medication_indication';
}
export interface ChainAttempt {
  readonly searched: boolean;
  readonly pathway: ChainPathway | null;
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
  /** E5 INPUT VISIBILITY — the fact set this verdict was computed from. Absent on legacy payloads. */
  readonly inputSet?: StrategyInputSet;
  /** E5 INTERMEDIARY CHECK — present only when the direct pathway failed and the chain was searched. */
  readonly chainAttempt?: ChainAttempt;
}

export function getStrategyPreview(caseId: string): Promise<{ data: StrategyPreview }> {
  return apiGet(`/api/v1/cases/${encodeURIComponent(caseId)}/strategy-preview`);
}
