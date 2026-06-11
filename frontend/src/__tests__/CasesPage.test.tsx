import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CasesPage } from '../routes/cases/CasesPage';
import type { Role } from '../types/prisma';

// vi.mock factories are hoisted above const initializers — hoist the spies they close over.
const { listCasesMock, assignCaseRnMock, getMeMock, listUsersMock } = vi.hoisted(() => ({
  listCasesMock: vi.fn(),
  assignCaseRnMock: vi.fn(),
  getMeMock: vi.fn(),
  listUsersMock: vi.fn(),
}));

let mockRole: Role = 'ops_staff';
vi.mock('../auth/useAuth', () => ({
  useAuth: () => ({ user: { sub: 'sub-me', email: 'me@x.test', roles: [mockRole], role: mockRole }, role: mockRole, loading: false }),
}));

vi.mock('../api/cases', () => ({
  listCases: listCasesMock,
  assignCaseRn: assignCaseRnMock,
  deleteCase: vi.fn(async () => undefined),
  restoreCase: vi.fn(async () => ({ data: {} })),
  updateQuickNote: vi.fn(async () => ({ data: {} })),
}));
vi.mock('../api/users', () => ({
  listUsers: listUsersMock,
  getMe: getMeMock,
}));
vi.mock('../api/veterans', () => ({ listVeterans: vi.fn(async () => ({ data: [] })) }));
vi.mock('../layout/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

const ME = { id: 'U-ME', email: 'me@x.test', name: 'Me Nurse', roles: ['ops_staff'] };
const ROSTER = [
  { id: 'U-ME', email: 'me@x.test', name: 'Me Nurse', active: true, roles: ['ops_staff'], version: 1 },
  { id: 'U-SARAH', email: 'sarah@x.test', name: 'Sarah Jones', active: true, roles: ['ops_staff'], version: 1 },
];
const CASES_RESULT = {
  data: [
    {
      id: 'CASE-001', veteranId: 'VET-1', claimedCondition: 'Obstructive sleep apnea', claimType: 'initial',
      status: 'drafting', version: 3, currentVersion: 2, assignedPhysicianId: null, assignedRnId: null, assignedRn: null, refundEligible: false,
      createdAt: '2026-05-01T00:00:00Z', updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      veteran: { id: 'VET-1', firstName: 'Matthew', lastName: 'Young', email: 'm@example.com' }, assignedPhysician: null,
    },
    {
      id: 'CASE-002', veteranId: 'VET-2', claimedCondition: 'Tinnitus', claimType: 'initial',
      status: 'intake', version: 1, currentVersion: 1, assignedPhysicianId: null, assignedRnId: 'U-SARAH',
      assignedRn: { id: 'U-SARAH', email: 'sarah@x.test', name: 'Sarah Jones' }, refundEligible: false,
      createdAt: '2026-05-02T00:00:00Z', updatedAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
      veteran: { id: 'VET-2', firstName: 'Aaron', lastName: 'Adams', email: 'a@example.com' }, assignedPhysician: null,
    },
  ],
  page: 1, pageSize: 25, total: 2,
};

beforeEach(() => {
  mockRole = 'ops_staff';
  listCasesMock.mockReset().mockResolvedValue(CASES_RESULT);
  assignCaseRnMock.mockReset().mockResolvedValue({ data: {} });
  getMeMock.mockReset().mockResolvedValue({ data: ME });
  listUsersMock.mockReset().mockResolvedValue({ data: ROSTER });
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><CasesPage /></MemoryRouter></QueryClientProvider>);
}

function openRnDropdown() {
  // The trigger button carries the current selection summary text.
  fireEvent.click(screen.getByRole('button', { name: /All active|Me|Unassigned/ }));
}

describe('CasesPage', () => {
  it('renders filters and a case row with status badge', async () => {
    renderPage();
    expect(screen.getByText('All statuses')).toBeInTheDocument();
    expect(await screen.findByText('CASE-001')).toBeInTheDocument();
    expect(screen.getByText('Young, Matthew')).toBeInTheDocument();
    // The Cases-list status is now a NEUTRAL slate label (Fix 1, "christmas tree" de-color 2026-06-08),
    // NOT the colored CaseStatusBadge. "Drafting" appears in the status filter option AND the row cell —
    // assert the neutral row label specifically (centered slate text, no bg-* fill).
    expect(screen.getAllByText('Drafting').some((el) => el.className.includes('text-slate-600') && !el.className.includes('bg-'))).toBe(true);
    // Records column renders the neutral one-word "Pending" label (mock rows have no recordsUploaded).
    expect(screen.getAllByText('Pending').length).toBeGreaterThan(0);
  });

  it('sorts by a column header: default -> asc -> desc (3-state) with aria-sort + indicator', async () => {
    renderPage();
    await screen.findByText('CASE-001');
    const order = () => screen.getAllByText(/^CASE-00\d$/).map((el) => el.textContent);
    const vetHeader = () => screen.getByRole('button', { name: /Veteran/ });

    // default = server/mock order
    expect(order()).toEqual(['CASE-001', 'CASE-002']);
    expect(vetHeader().closest('th')?.getAttribute('aria-sort')).toBe('none');

    // 1st click = ascending by veteran name (Aaron Adams < Matthew Young)
    fireEvent.click(vetHeader());
    expect(order()).toEqual(['CASE-002', 'CASE-001']);
    expect(vetHeader().closest('th')?.getAttribute('aria-sort')).toBe('ascending');
    expect(vetHeader().textContent).toContain('▲');

    // 2nd click = descending
    fireEvent.click(vetHeader());
    expect(order()).toEqual(['CASE-001', 'CASE-002']);
    expect(vetHeader().closest('th')?.getAttribute('aria-sort')).toBe('descending');
    expect(vetHeader().textContent).toContain('▼');

    // 3rd click = back to default
    fireEvent.click(vetHeader());
    expect(vetHeader().closest('th')?.getAttribute('aria-sort')).toBe('none');
    expect(order()).toEqual(['CASE-001', 'CASE-002']);
  });

  // === P3.2: the claim-type FILTER is gone; the Type COLUMN stays ===

  it('has no claim-type filter, but the Type column still renders claim-type labels', async () => {
    renderPage();
    await screen.findByText('CASE-001');
    expect(screen.queryByText('All claim types')).not.toBeInTheDocument();
    expect(screen.queryByText('Claim type')).not.toBeInTheDocument();
    // Type column (CLAIM_TYPE_LABELS) still renders for both rows.
    expect(screen.getAllByText('Initial')).toHaveLength(2);
  });

  // === P3.3: Assigned-RN dropdown-checkbox filter ===

  it('ops_staff defaults to [Me]: lists with assignedRnId = my AppUser id', async () => {
    renderPage();
    await screen.findByText('CASE-001');
    expect(listCasesMock).toHaveBeenCalledWith(expect.objectContaining({ assignedRnId: 'U-ME' }));
    // Trigger summary reflects the default.
    expect(screen.getByRole('button', { name: /^Me/ })).toBeInTheDocument();
  });

  it('admin defaults to All active: assignedRnId param omitted', async () => {
    mockRole = 'admin';
    renderPage();
    await screen.findByText('CASE-001');
    expect(listCasesMock).toHaveBeenCalled();
    for (const call of listCasesMock.mock.calls) {
      expect((call[0] as { assignedRnId?: string }).assignedRnId).toBeUndefined();
    }
    expect(screen.getByRole('button', { name: /All active/ })).toBeInTheDocument();
  });

  it('checkbox exclusivity: checking others un-checks All; checking All clears the others', async () => {
    mockRole = 'admin';
    renderPage();
    await screen.findByText('CASE-001');
    openRnDropdown();

    const all = () => screen.getByLabelText('All active') as HTMLInputElement;
    const unassigned = () => screen.getByLabelText('Unassigned') as HTMLInputElement;
    const sarah = () => screen.getByLabelText('Sarah Jones') as HTMLInputElement;

    expect(all().checked).toBe(true); // admin default

    fireEvent.click(unassigned());
    expect(unassigned().checked).toBe(true);
    expect(all().checked).toBe(false); // any other selection un-checks All
    await waitFor(() => expect(listCasesMock).toHaveBeenCalledWith(expect.objectContaining({ assignedRnId: '__none__' })));

    fireEvent.click(sarah());
    expect(sarah().checked).toBe(true);
    await waitFor(() => expect(listCasesMock).toHaveBeenCalledWith(expect.objectContaining({ assignedRnId: '__none__,U-SARAH' })));

    fireEvent.click(all()); // All is exclusive: clears every other checkbox
    expect(all().checked).toBe(true);
    expect(unassigned().checked).toBe(false);
    expect(sarah().checked).toBe(false);
    const lastParams = listCasesMock.mock.calls.at(-1)?.[0] as { assignedRnId?: string };
    await waitFor(() => expect(lastParams.assignedRnId).toBeUndefined());
  });

  it('multi-select Me + Unassigned sends a comma-joined assignedRnId', async () => {
    renderPage();
    await screen.findByText('CASE-001');
    openRnDropdown();
    fireEvent.click(screen.getByLabelText('Unassigned'));
    await waitFor(() => expect(listCasesMock).toHaveBeenCalledWith(expect.objectContaining({ assignedRnId: 'U-ME,__none__' })));
  });

  it('degrades gracefully when /users/me 404s: [Me] hidden, falls back to All active, no crash', async () => {
    getMeMock.mockReset().mockRejectedValue(Object.assign(new Error('No staff profile maps to this login'), { status: 404 }));
    renderPage(); // ops_staff whose default WOULD be [Me]
    await screen.findByText('CASE-001');
    // The unresolvable Me token is pruned → unfiltered list (param omitted).
    for (const call of listCasesMock.mock.calls) {
      expect((call[0] as { assignedRnId?: string }).assignedRnId).toBeUndefined();
    }
    openRnDropdown();
    expect(screen.queryByLabelText('Me')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Unassigned')).toBeInTheDocument();
  });

  // === P3.4: RN column '+' assign affordance ===

  it("renders the '+' assign button ONLY on unassigned rows; assigned rows show the RN's name", async () => {
    renderPage();
    await screen.findByText('CASE-001');
    expect(screen.getAllByLabelText('Assign RN')).toHaveLength(1); // CASE-001 only
    expect(screen.getByText('Sarah Jones')).toBeInTheDocument(); // CASE-002 shows name (not email)
  });

  it("clicking '+' opens the popup and assigning fires assignCaseRn with the row's version", async () => {
    renderPage();
    await screen.findByText('CASE-001');
    fireEvent.click(screen.getByLabelText('Assign RN'));
    expect(screen.getByText('Assign RN · CASE-001')).toBeInTheDocument();
    // In the popup the staff entries are BUTTONS (the table cell name + filter labels are not).
    fireEvent.click(screen.getByRole('button', { name: 'Sarah Jones' }));
    await waitFor(() => expect(assignCaseRnMock).toHaveBeenCalledWith('CASE-001', { rnUserId: 'U-SARAH', version: 3 }));
  });
});
