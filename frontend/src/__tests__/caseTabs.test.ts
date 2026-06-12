import { describe, expect, it } from 'vitest';
import { NOTES_TAB, SHARED_TABS } from '../lib/caseTabs';

// Tab-list locks (UI sweep P2b, Ryan item 12) — same no-orphan pattern as caseStatus.test.ts.
// SHARED_TABS is the shared TAIL both the claim page and the veteran chart append, so its order
// IS the cross-page order contract: Documents, SC Conditions, Active Problems, Medications.
// Staff Notes moved out of the shared list (each page places it near the top explicitly) but its
// id/label stay shared via NOTES_TAB so the two pages can't drift on the label.
describe('caseTabs shared list', () => {
  it('locks the shared tail order (Documents, SC Conditions, Active Problems, Medications)', () => {
    expect(SHARED_TABS.map((t) => t.id)).toEqual(['documents', 'conditions', 'problems', 'medications']);
    expect(SHARED_TABS.map((t) => t.label)).toEqual([
      'Documents', 'SC Conditions', 'Active Problems', 'Medications',
    ]);
  });

  it('no orphans: every tab has a non-empty label and a unique id', () => {
    const all = [...SHARED_TABS, NOTES_TAB];
    for (const t of all) expect(t.label.trim().length).toBeGreaterThan(0);
    expect(new Set(all.map((t) => t.id)).size).toBe(all.length);
  });

  it('Staff Notes stays a shared definition (page-placed, label cannot drift)', () => {
    expect(NOTES_TAB).toEqual({ id: 'notes', label: 'Staff Notes' });
  });
});
