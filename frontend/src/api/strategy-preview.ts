import { apiGet } from './client';

export type StrategyTier = 'Strong' | 'Plausible' | 'Thin' | 'Stop';

export interface StrategyCriterion {
  readonly key: string;
  readonly label: string;
  readonly pass: boolean;
  readonly detail: string;
}

export interface StrategyPreview {
  readonly primaryArgument: string;
  readonly proposedMechanism: string | null;
  readonly anchor: string | null;
  readonly tier: StrategyTier;
  readonly criteria: readonly StrategyCriterion[];
  readonly summary: string;
}

export function getStrategyPreview(caseId: string): Promise<{ data: StrategyPreview }> {
  return apiGet(`/api/v1/cases/${encodeURIComponent(caseId)}/strategy-preview`);
}
