import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CasesPage } from '../routes/cases/CasesPage';
import type { Role } from '../types/prisma';

// vi.mock factories are hoisted above const initializers — hoist the spies they close over.
const { listCasesMock, assignCaseRnMock, getMeMock, listUsersMock, createChartNoteMock } = vi.hoisted(() => ({
  listCasesMock: vi.fn(),
  assignCaseRnMock: vi.fn(),
  getMeMock: vi.fn(),
  listUsersMock: vi.fn(),
  createChartNoteMock: vi.fn(),
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
}));
vi.mock('../api/users', () => ({
  listUsers: listUsersMock,
  getMe: getMeMock,
}));
vi.mock('../api/chart-notes', () => ({ createChartNote: createChartNoteMock }));
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
      createdAt: '2026-05-01T12:00:00Z', updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      veteran: { id: 'VET-1', firstName: 'Matthew', lastName: 'Young', email: 'm@example.com' }, assignedPhysician: null,
      // Latest PERSISTENT quick note surfaced read-only in the Note column (Ryan 2026-06-21).
      latestQuickNote: { id: 'QN-1', body: 'Awaiting records — C-file requested 6/8', createdAt: '2026-06-20T12:00:00Z', createdBy: 'sub-me' },
    },
    {
      id: 'CASE-002', veteranId: 'VET-2', claimedCondition: 'Tinnitus', claimType: 'initial',
      status: 'intake', version: 1, currentVersion: 1, assignedPhysicianId: null, assignedRnId: 'U-SARAH',
      assignedRn: { id: 'U-SARAH', email: 'sarah@x.test', name: 'Sarah Jones' }, refundEligible: false,
      createdAt: '2026-05-02T12:00:00Z', updatedAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
      veteran: { id: 'VET-2', firstName: 'Aaron', lastName: 'Adams', email: 'a@example.com' }, assignedPhysician: null,
    },
  ],
  page: 1, pageSize: 25, total: 2,
};

beforeEach(() => {
  sessionStorage.clear(); // sticky sort/filters persist per-tab — isolate each test
  mockRole = 'ops_staff';
  listCasesMock.mockReset().mockResolvedValue(CASES_RESULT);
  assignCaseRnMock.mockReset().mockResolvedValue({ data: {} });
  getMeMock.mockReset().mockResolvedValue({ data: ME });
  listUsersMock.mockReset().mockResolvedValue({ data: ROSTER });
  createChartNoteMock.mockReset().mockResolvedValue({ data: {} });
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter><CasesPage /></MemoryRouter></QueryClientProvider>);
}

function openRnDropdown() {
  // The trigger button carries the current selection summary text.
  fireEvent.click(screen.getByRole('button', { name: /All active|Me|Unassigned/ }));
}

// Lifecycle section headers are <th scope="colgroup"> rows; return their text in DOM order.
function lifecycleHeaders(): string[] {
  return screen.getAllByRole('columnheader')
    .filter((el) => el.getAttribute('scope') === 'colgroup')
    .map((el) => (el.textContent ?? '').trim());
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
    // No mock row carries invoiced:true → the Invoiced ROW label must be absent by default. (The
    // fixed "Invoiced" lifecycle SECTION HEADER — a <th> — always renders, even empty, so scope this
    // to the row status <span>, not the header.)
    expect(screen.queryAllByText('Invoiced').filter((el) => el.tagName === 'SPAN' && el.className.includes('text-slate-600'))).toHaveLength(0);
  });

  // === Note column: restored quiet ICON + inline '+' add (Dr. Kasky 2026-06-24) ===

  it('Note column shows the quick-note body (full text in the title) when a quick note exists, and a + when none', async () => {
    renderPage();
    await screen.findByText('CASE-001');
    // CASE-001 HAS a quick note → a clickable note button whose aria-label carries the full text and
    // whose visible text shows the body (no "Quick" badge).
    const note = screen.getByLabelText('Quick note: Awaiting records — C-file requested 6/8');
    expect(note).toBeInTheDocument();
    expect(note).toHaveAttribute('title', expect.stringContaining('Awaiting records — C-file requested 6/8'));
    // It is a BUTTON, not a navigation link (clicking edits inline; it must not route to the chart).
    expect(note.tagName).toBe('BUTTON');
    // CASE-002 has NO quick note → its Note cell shows the '+' add button.
    expect(screen.getByLabelText('Add quick note')).toBeInTheDocument();
  });

  it("clicking '+' opens an inline input and Save POSTs a persistent quick note, then refetches", async () => {
    renderPage();
    await screen.findByText('CASE-002');
    fireEvent.click(screen.getByLabelText('Add quick note')); // CASE-002 (VET-2) has no note
    const input = screen.getByLabelText('Quick note') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Called veteran, awaiting STRs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    await waitFor(() => expect(createChartNoteMock).toHaveBeenCalledWith('VET-2', 'Called veteran, awaiting STRs', true));
  });

  it('clicking an EXISTING note opens an inline editor in place (no navigation) pre-filled with the note text', async () => {
    renderPage();
    await screen.findByText('CASE-001');
    // Click the existing CASE-001 quick note. This must NOT navigate — it opens the inline editor.
    fireEvent.click(screen.getByLabelText('Quick note: Awaiting records — C-file requested 6/8'));
    // Still on the Cases page (the case row is still rendered) and the editor is pre-filled.
    expect(screen.getByText('CASE-001')).toBeInTheDocument();
    const input = screen.getByLabelText('Quick note') as HTMLTextAreaElement;
    expect(input.value).toBe('Awaiting records — C-file requested 6/8');
  });

  it('editing an existing note + Enter APPENDS a new chart-note (history preserved), shown as the latest', async () => {
    renderPage();
    await screen.findByText('CASE-001');
    fireEvent.click(screen.getByLabelText('Quick note: Awaiting records — C-file requested 6/8'));
    const input = screen.getByLabelText('Quick note') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Records received 6/25 — ready for review' } });
    // Enter saves (Shift+Enter would instead insert a newline).
    fireEvent.keyDown(input, { key: 'Enter' });
    // Saving goes through createChartNote (a POST that APPENDS a new note to the chart-notes stream),
    // NOT an in-place overwrite — so the prior note stays in the chart's history. VET-1 is CASE-001.
    await waitFor(() => expect(createChartNoteMock).toHaveBeenCalledWith('VET-1', 'Records received 6/25 — ready for review', true));
  });

  it('Shift+Enter in the note editor inserts a newline and does NOT save', async () => {
    renderPage();
    await screen.findByText('CASE-002');
    fireEvent.click(screen.getByLabelText('Add quick note'));
    const input = screen.getByLabelText('Quick note') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'line one' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(createChartNoteMock).not.toHaveBeenCalled();
  });

  it('invoiced delivered case: the STATUS LABEL ITSELF reads "Invoiced", same neutral format, no chip (Ryan 2026-06-12)', async () => {
    listCasesMock.mockResolvedValue({
      ...CASES_RESULT,
      data: [{ ...CASES_RESULT.data[0], status: 'delivered', invoiced: true }],
      total: 1,
    });
    renderPage();
    expect(await screen.findByText('CASE-001')).toBeInTheDocument();
    // "Invoiced" now also names the fixed lifecycle SECTION HEADER (<th>); the row status label is a
    // <span>. Scope to the row span.
    const label = screen.getAllByText('Invoiced').find((el) => el.tagName === 'SPAN') as HTMLElement;
    expect(label).toBeDefined();
    // Same neutral slate row format as every other status — never the green decoration.
    expect(label.className).toContain('text-slate-600');
    expect(label.className).not.toContain('emerald');
    // The ROW status <span> must not say "Ready for delivery" (the filter dropdown <option> and the
    // empty lifecycle section <th> legitimately still do — exclude both, keep only row spans).
    const rowMentions = screen.getAllByText('Ready for delivery').filter((el) => el.tagName === 'SPAN');
    expect(rowMentions).toHaveLength(0);
  });

  it('header sort cycles default -> asc -> desc (3-state) with aria-sort + indicator', async () => {
    renderPage();
    await screen.findByText('CASE-001');
    const order = () => screen.getAllByText(/^CASE-00\d$/).map((el) => el.textContent);
    const vetHeader = () => screen.getByRole('button', { name: /Veteran/ });

    // With fixed lifecycle grouping, CASE-002 (intake → Pre-draft) always renders above CASE-001
    // (drafting → Drafting): a case never leaves its bucket, so the cross-bucket ROW order is constant
    // regardless of the sort. The sort cycle is verified via aria-sort + the indicator here; the
    // WITHIN-bucket reorder behavior has its own dedicated test below.
    expect(order()).toEqual(['CASE-002', 'CASE-001']);
    expect(vetHeader().closest('th')?.getAttribute('aria-sort')).toBe('none');

    // 1st click = ascending
    fireEvent.click(vetHeader());
    expect(vetHeader().closest('th')?.getAttribute('aria-sort')).toBe('ascending');
    expect(vetHeader().textContent).toContain('▲');
    expect(order()).toEqual(['CASE-002', 'CASE-001']);

    // 2nd click = descending
    fireEvent.click(vetHeader());
    expect(vetHeader().closest('th')?.getAttribute('aria-sort')).toBe('descending');
    expect(vetHeader().textContent).toContain('▼');
    expect(order()).toEqual(['CASE-002', 'CASE-001']); // still bucket-ordered

    // 3rd click = back to default
    fireEvent.click(vetHeader());
    expect(vetHeader().closest('th')?.getAttribute('aria-sort')).toBe('none');
    expect(order()).toEqual(['CASE-002', 'CASE-001']);
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

  // === Chunk C (2026-06-11): absolute Submitted date + sticky deterministic sort ===

  it('Submitted shows an absolute month-name date; Updated keeps the relative time', async () => {
    renderPage();
    await screen.findByText('CASE-001');
    // Mock createdAt values are midday UTC so the local date never rolls a day in any test TZ.
    expect(screen.getByText('May 1, 2026')).toBeInTheDocument();
    expect(screen.getByText('May 2, 2026')).toBeInTheDocument();
    // Updated column still renders "how long ago" (mock rows are 3h and 1h old).
    expect(screen.getByText('3 hours ago')).toBeInTheDocument();
    expect(screen.getByText('1 hour ago')).toBeInTheDocument();
  });

  it('sorts Submitted by the actual timestamp (epoch), never the display string — Sep/Oct/Nov stay in timeline order', async () => {
    const mk = (id: string, iso: string) => ({ ...CASES_RESULT.data[0], id, createdAt: iso, updatedAt: iso });
    listCasesMock.mockResolvedValue({
      // Served deliberately scrambled: Sep, Nov, Oct.
      data: [mk('CASE-SEP', '2025-09-05T12:00:00Z'), mk('CASE-NOV', '2025-11-02T12:00:00Z'), mk('CASE-OCT', '2025-10-09T12:00:00Z')],
      page: 1, pageSize: 25, total: 3,
    });
    renderPage();
    await screen.findByText('CASE-SEP');
    const order = () => screen.getAllByText(/^CASE-(SEP|OCT|NOV)$/).map((el) => el.textContent);
    const submittedHeader = screen.getByRole('button', { name: /Submitted/ });
    // Default = Submitted newest-first, with the descending indicator visible.
    expect(submittedHeader.closest('th')?.getAttribute('aria-sort')).toBe('descending');
    expect(order()).toEqual(['CASE-NOV', 'CASE-OCT', 'CASE-SEP']);
    // Ascending = oldest first. A display-STRING sort ("Nov 2, 2025" < "Oct 9, 2025" < "Sep 5, 2025")
    // would invert this — the exact 9/10/11-out-of-order bug Ryan described.
    fireEvent.click(submittedHeader);
    expect(order()).toEqual(['CASE-SEP', 'CASE-OCT', 'CASE-NOV']);
  });

  it('equal timestamps tiebreak on case id ascending, regardless of server order (no refetch jitter)', async () => {
    const t = '2026-04-10T12:00:00Z';
    const mk = (id: string) => ({ ...CASES_RESULT.data[0], id, createdAt: t, updatedAt: t });
    listCasesMock.mockResolvedValue({ data: [mk('CASE-009'), mk('CASE-003')], page: 1, pageSize: 25, total: 2 });
    renderPage();
    await screen.findByText('CASE-009');
    expect(screen.getAllByText(/^CASE-00\d$/).map((el) => el.textContent)).toEqual(['CASE-003', 'CASE-009']);
  });

  it('sort persists across unmount/remount (sessionStorage): Veteran desc survives navigating away and back', async () => {
    const first = renderPage();
    await screen.findByText('CASE-001');
    const vetHeader = () => screen.getByRole('button', { name: /Veteran/ });
    fireEvent.click(vetHeader()); // asc
    fireEvent.click(vetHeader()); // desc
    expect(vetHeader().closest('th')?.getAttribute('aria-sort')).toBe('descending');
    first.unmount();

    renderPage(); // simulates navigating to a claim and back (CasesPage remounts)
    await screen.findByText('CASE-001');
    // The persisted Veteran-DESC sort survives the remount (aria-sort restored, NOT the default
    // Submitted sort). Cross-bucket row order is fixed by the lifecycle grouping (CASE-002 Pre-draft
    // above CASE-001 Drafting), so the assertion that bites here is the restored aria-sort state.
    expect(vetHeader().closest('th')?.getAttribute('aria-sort')).toBe('descending');
    // Row order follows the fixed lifecycle buckets (Pre-draft CASE-002 above Drafting CASE-001).
    expect(screen.getAllByText(/^CASE-00\d$/).map((el) => el.textContent)).toEqual(['CASE-002', 'CASE-001']);
  });

  it('status filter persists across unmount/remount (sessionStorage)', async () => {
    const first = renderPage();
    await screen.findByText('CASE-001');
    const statusSelect = () => screen.getAllByRole('combobox')[0] as HTMLSelectElement; // first select = Status
    fireEvent.change(statusSelect(), { target: { value: 'intake' } });
    await waitFor(() => expect(listCasesMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'intake' })));
    first.unmount();

    listCasesMock.mockClear();
    renderPage();
    await screen.findByText('CASE-001');
    expect(statusSelect().value).toBe('intake');
    expect(listCasesMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'intake' }));
  });

  // === C5 lifecycle (2026-06-13): Active/Closed toggle + status grouping ===

  it('defaults to the Active toggle and queries the ACTIVE status set (paid/rejected excluded, no archived param)', async () => {
    mockRole = 'admin';
    renderPage();
    await screen.findByText('CASE-001');
    expect(screen.getByRole('tab', { name: 'Active' })).toHaveAttribute('aria-selected', 'true');
    // Default query: a statuses[] set that EXCLUDES paid + rejected, and no archived param.
    const params = listCasesMock.mock.calls.at(-1)?.[0] as { statuses?: string[]; archived?: unknown };
    expect(params.statuses).toBeDefined();
    expect(params.statuses).not.toContain('paid');
    expect(params.statuses).not.toContain('rejected');
    expect(params.statuses).toContain('drafting');
    expect(params.archived).toBeUndefined();
  });

  it('Closed toggle queries [paid, rejected] with archived=all (paid + rejected + archived in one page)', async () => {
    mockRole = 'admin';
    renderPage();
    await screen.findByText('CASE-001');
    fireEvent.click(screen.getByRole('tab', { name: 'Closed' }));
    await waitFor(() => {
      const params = listCasesMock.mock.calls.at(-1)?.[0] as { statuses?: string[]; archived?: unknown };
      expect(params.statuses?.slice().sort()).toEqual(['paid', 'rejected']);
      expect(params.archived).toBe('all');
    });
  });

  it('closed cases (paid + archived rejected) fall under the terminal Invoiced lifecycle bucket', async () => {
    mockRole = 'admin';
    listCasesMock.mockResolvedValue({
      data: [
        { ...CASES_RESULT.data[0], id: 'CASE-PAID', status: 'paid' },
        { ...CASES_RESULT.data[1], id: 'CASE-ARCH', status: 'rejected', archivedAt: '2026-06-12T00:00:00Z' },
      ],
      page: 1, pageSize: 25, total: 2,
    });
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Closed' }));
    await screen.findByText('CASE-PAID');
    // Both paid and rejected fold into the terminal 'Invoiced' lifecycle bucket; that header carries
    // a count of 2. The archived row still shows Restore (keyed on archivedAt), the paid row Archive.
    const invoicedHeader = lifecycleHeaders().find((t) => t.startsWith('Invoiced'));
    expect(invoicedHeader).toBe('Invoiced (2)');
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
  });

  // === Fixed lifecycle grouping (Dr. Kasky 2026-06-24) ===

  it('renders all six lifecycle headers in the FIXED locked order, even when buckets are empty', async () => {
    mockRole = 'admin';
    // Two rows: one drafting, one physician_review. The other four buckets are empty.
    listCasesMock.mockResolvedValue({
      data: [
        { ...CASES_RESULT.data[0], id: 'CASE-DRAFT', status: 'drafting' },
        { ...CASES_RESULT.data[1], id: 'CASE-MD', status: 'physician_review' },
      ],
      page: 1, pageSize: 25, total: 2,
    });
    renderPage();
    await screen.findByText('CASE-DRAFT');
    // Strip the trailing "(n)" count and assert the exact locked order, empties included.
    const labels = lifecycleHeaders().map((t) => t.replace(/\s*\(\d+\)\s*$/, ''));
    expect(labels).toEqual(['Pre-draft', 'Drafting', 'RN review', 'Physician review', 'Ready for delivery', 'Invoiced']);
    // Empty buckets show the "— none —" placeholder; the two populated ones show their count.
    expect(lifecycleHeaders().find((t) => t.startsWith('Drafting'))).toBe('Drafting (1)');
    expect(lifecycleHeaders().find((t) => t.startsWith('Physician review'))).toBe('Physician review (1)');
    expect(screen.getAllByText('— none —').length).toBe(4);
  });

  it('sorting reorders rows WITHIN a bucket but never moves a case across buckets', async () => {
    mockRole = 'admin';
    // Two drafting rows (Young, Adams) + one physician_review row. Sorting by Veteran must reorder
    // the two drafting rows among themselves while every row stays under its own lifecycle header.
    listCasesMock.mockResolvedValue({
      data: [
        { ...CASES_RESULT.data[0], id: 'CASE-YOUNG', status: 'drafting', createdAt: '2026-05-01T12:00:00Z', veteran: { id: 'V-Y', firstName: 'Matthew', lastName: 'Young', email: 'y@x.test' } },
        { ...CASES_RESULT.data[0], id: 'CASE-ADAMS', status: 'drafting', createdAt: '2026-05-02T12:00:00Z', veteran: { id: 'V-A', firstName: 'Aaron', lastName: 'Adams', email: 'a@x.test' } },
        { ...CASES_RESULT.data[0], id: 'CASE-MD', status: 'physician_review', createdAt: '2026-05-03T12:00:00Z', veteran: { id: 'V-Z', firstName: 'Zed', lastName: 'Zimmer', email: 'z@x.test' } },
      ],
      page: 1, pageSize: 25, total: 3,
    });
    renderPage();
    await screen.findByText('CASE-YOUNG');
    const order = () => screen.getAllByText(/^CASE-(YOUNG|ADAMS|MD)$/).map((el) => el.textContent);

    // Default = Submitted newest-first WITHIN each bucket: drafting bucket [Adams(5/2), Young(5/1)],
    // then physician_review bucket [MD]. MD never floats above the drafting rows despite being newest.
    expect(order()).toEqual(['CASE-ADAMS', 'CASE-YOUNG', 'CASE-MD']);

    // Sort by Veteran ascending: the two DRAFTING rows swap (Adams < Young), MD stays last in its own
    // bucket — a case never leaves its lifecycle bucket regardless of the sort.
    fireEvent.click(screen.getByRole('button', { name: /Veteran/ }));
    expect(order()).toEqual(['CASE-ADAMS', 'CASE-YOUNG', 'CASE-MD']);

    // Veteran descending: drafting rows reverse to [Young, Adams]; MD still alone, still last.
    fireEvent.click(screen.getByRole('button', { name: /Veteran/ }));
    expect(order()).toEqual(['CASE-YOUNG', 'CASE-ADAMS', 'CASE-MD']);
  });

  it('legacy stored archived=true blob maps to the Closed toggle on remount (back-compat)', async () => {
    sessionStorage.setItem('emr.cases.filters.v1', JSON.stringify({ status: '', rnSel: [], archived: true, pageSize: 25, veteran: null }));
    mockRole = 'admin';
    renderPage();
    await screen.findByText('CASE-001');
    expect(screen.getByRole('tab', { name: 'Closed' })).toHaveAttribute('aria-selected', 'true');
  });
});
