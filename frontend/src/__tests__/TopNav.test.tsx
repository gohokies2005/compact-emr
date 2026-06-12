import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { TopNav } from '../layout/TopNav';
import type { Role } from '../types/prisma';

let mockRole: Role = 'physician';

vi.mock('../auth/useAuth', () => ({
  useAuth: () => ({ user: { role: mockRole }, role: mockRole, loading: false }),
}));

// No QueryClient in this test — the badge hook must stay unmounted (the reason it's split out).
vi.mock('../api/messaging', () => ({
  useHasQueryClient: () => false,
  useInboxUnreadCount: () => 0,
}));

function navLabels(): string[] {
  // Scope to the <nav> element so the logo home-link doesn't pollute the order assertion.
  const nav = screen.getByRole('navigation');
  return within(nav).getAllByRole('link').map((a) => a.textContent ?? '');
}

function renderNav(role: Role) {
  mockRole = role;
  render(
    <MemoryRouter>
      <TopNav />
    </MemoryRouter>,
  );
}

describe('TopNav ordering', () => {
  // Ryan 2026-06-11 P4: physician tabs renamed to "Letters in Queue" | "Completed Letters" and
  // Inbox moved to the RIGHT cluster next to the identity block. Doctor-pay build (same day)
  // adds "Track pay" third in the LEFT group. Locked here so neither the labels, the order,
  // nor the left/right split can regress.
  it('physician left nav is Letters in Queue | Completed Letters | Track pay; Inbox right-aligned outside it', () => {
    renderNav('physician');
    expect(navLabels()).toEqual(['Letters in Queue', 'Completed Letters', 'Track pay']);
    const inbox = screen.getByRole('link', { name: 'Inbox' });
    const nav = screen.getByRole('navigation');
    // Inbox lives in the right cluster — outside the left <nav> and AFTER the left tabs in DOM order.
    expect(nav.contains(inbox)).toBe(false);
    const leftLinks = within(nav).getAllByRole('link');
    const lastLeft = leftLinks[leftLinks.length - 1]!;
    expect(lastLeft.compareDocumentPosition(inbox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Full header order (logo excluded): the renamed tabs, then Inbox by the identity cluster.
    const headerLabels = screen
      .getAllByRole('link')
      .filter((a) => a.getAttribute('aria-label') !== 'Aegis home')
      .map((a) => a.textContent ?? '');
    expect(headerLabels).toEqual(['Letters in Queue', 'Completed Letters', 'Track pay', 'Inbox']);
  });

  it('staff left nav is Home | Intake | Cases | Veterans; Inbox right-aligned outside it', () => {
    // Ryan 2026-06-12: staff left order is Home, Intake, Cases, Veterans (Cases BEFORE Veterans), and
    // Inbox is pulled out of the left list to the right cluster next to the identity menu — the same
    // treatment the physician nav already had.
    renderNav('ops_staff');
    const labels = navLabels();
    expect(labels).toEqual(['Home', 'Intake', 'Cases', 'Veterans']);
    // Inbox is no longer in the left nav — it's right-aligned outside it.
    const nav = screen.getByRole('navigation');
    expect(within(nav).queryByRole('link', { name: 'Inbox' })).toBeNull();
    const inbox = screen.getByRole('link', { name: 'Inbox' });
    expect(nav.contains(inbox)).toBe(false);
    // Inbox follows the left tabs in DOM order (right cluster).
    const leftLinks = within(nav).getAllByRole('link');
    const lastLeft = leftLinks[leftLinks.length - 1]!;
    expect(lastLeft.compareDocumentPosition(inbox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Physician-only tabs never leak into the staff nav.
    expect(labels).not.toContain('Letters in Queue');
    expect(labels).not.toContain('Completed Letters');
    expect(labels).not.toContain('Track pay');
    // P2c (Ryan item 13): Refunds left the nav — the refund signal lives on the case page now.
    expect(labels).not.toContain('Refunds');
  });

  it('admin nav has no Refunds entry either (route stays admin-reachable by URL only)', () => {
    renderNav('admin');
    expect(navLabels()).not.toContain('Refunds');
  });
});
