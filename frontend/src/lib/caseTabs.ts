import type { TabItem } from '../components/ui/TabBar';

// SHARED tabs — the vet-scoped sections that render IDENTICALLY on both the claim (CaseDetailPage)
// and the veteran chart (VeteranChart). They operate on the same veteran data via the same panels
// (Documents, ConditionsPanel, ProblemsPanel, MedicationsPanel, ChartNotesPanel), so both pages must
// source this single list — extracted here so the two pages can't drift (architect design 2026-06-08).
//
// Order is owner-specified: Documents, then the clinical chart sections
// (SC Conditions, Active Problems, Medications, Staff Notes).
export type SharedTabId = 'documents' | 'conditions' | 'problems' | 'medications' | 'notes';

export const SHARED_TABS: readonly TabItem<SharedTabId>[] = [
  { id: 'documents', label: 'Documents' },
  { id: 'conditions', label: 'Service Connected Conditions' },
  { id: 'problems', label: 'Active Problems' },
  { id: 'medications', label: 'Medications' },
  { id: 'notes', label: 'Staff Notes' },
];
