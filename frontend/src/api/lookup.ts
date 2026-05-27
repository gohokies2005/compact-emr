import { apiGet } from './client';
import type { Envelope } from './veterans';

export interface ConditionOption {
  readonly value: string;
  readonly label: string;
  // True for supplemental conditions not in the BVA atlas (CDS returns caution/no-odds). Optional.
  readonly noBvaData?: boolean;
}
export interface ConditionGroup {
  readonly system: string;
  readonly conditions: readonly ConditionOption[];
}
export interface ConditionsCatalog {
  readonly groups: readonly ConditionGroup[];
}

// Canonical condition catalog sourced from the CDS BVA atlas, grouped by body system. Used to
// drive the chart/claim condition dropdowns so RN picks resolve to CDS-recognized keys.
export async function getConditions(): Promise<ConditionsCatalog> {
  const res = await apiGet<Envelope<ConditionsCatalog>>('/api/v1/lookup/conditions');
  return res.data;
}
