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
  // Inbox moved to the RIGHT cluster next to the identity block. Locked here so neither the
  // labels nor the left/right split can regress.
  it('physician left nav is Letters in Queue | Completed Letters; Inbox right-aligned outside it', () => {
    renderNav('physician');
    expect(navLabels()).toEqual(['Letters in Queue', 'Completed Letters']);
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
    expect(headerLabels).toEqual(['Letters in Queue', 'Completed Letters', 'Inbox']);
  });

  it('staff nav order is unchanged (Home first, Inbox in its shared slot)', () => {
    renderNav('ops_staff');
    const labels = navLabels();
    expect(labels[0]).toBe('Home');
    expect(labels).toContain('Inbox');
    expect(labels).toContain('Cases');
    // Physician-only tabs never leak into the staff nav.
    expect(labels).not.toContain('Letters in Queue');
    expect(labels).not.toContain('Completed Letters');
    // P2c (Ryan item 13): Refunds left the nav — the refund signal lives on the case page now.
    expect(labels).not.toContain('Refunds');
  });

  it('admin nav has no Refunds entry either (route stays admin-reachable by URL only)', () => {
    renderNav('admin');
    expect(navLabels()).not.toContain('Refunds');
  });
});
