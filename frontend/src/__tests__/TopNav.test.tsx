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
  // Ryan 2026-06-10 P2.2: physician tab order is Queue (far left) | Letters | Inbox. The shared
  // nav array's filter order rendered Inbox first — locked here so it can't regress.
  it('physician sees Queue | Letters | Inbox in that order', () => {
    renderNav('physician');
    expect(navLabels()).toEqual(['Queue', 'Letters', 'Inbox']);
  });

  it('staff nav order is unchanged (Home first, Inbox in its shared slot)', () => {
    renderNav('ops_staff');
    const labels = navLabels();
    expect(labels[0]).toBe('Home');
    expect(labels).toContain('Inbox');
    expect(labels).toContain('Cases');
    // Physician-only tabs never leak into the staff nav.
    expect(labels).not.toContain('Queue');
    expect(labels).not.toContain('Letters');
  });
});
