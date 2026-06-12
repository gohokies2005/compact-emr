import type { TabItem } from '../components/ui/TabBar';

// SHARED tabs — the vet-scoped sections that render IDENTICALLY on both the claim (CaseDetailPage)
// and the veteran chart (VeteranChart). They operate on the same veteran data via the same panels
// (Documents, ConditionsPanel, ProblemsPanel, MedicationsPanel), so both pages must source this
// single list — extracted here so the two pages can't drift (architect design 2026-06-08).
//
// Order is owner-specified (Ryan item 12, UI sweep P2b): this is the shared TAIL of both pages —
// Documents, SC Conditions, Active Problems, Medications. Staff Notes was pulled OUT of this list
// because Ryan's global order places it near the TOP of each page (claim: after Draft jobs; chart:
// after Claims), so each page now declares its own explicit `notes` entry instead.
export type SharedTabId = 'documents' | 'conditions' | 'problems' | 'medications';

export const SHARED_TABS: readonly TabItem<SharedTabId>[] = [
  { id: 'documents', label: 'Documents' },
  { id: 'conditions', label: 'SC Conditions' },
  { id: 'problems', label: 'Active Problems' },
  { id: 'medications', label: 'Medications' },
];

// The Staff Notes tab both pages place explicitly (near the top, per-page position). Shared here so
// the label can't drift between the claim page and the chart.
export const NOTES_TAB: TabItem<'notes'> = { id: 'notes', label: 'Staff Notes' };
