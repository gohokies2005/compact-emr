// Story-order regression test (2026-06-16, architect fast-follow). The Overview "story" sections share
// ONE container and their order is product-meaningful (Ryan's SOAP-style flow) but driven only by
// static JSX source order — nothing asserted it. This locks the 6-section DOM order so a future edit
// can't silently re-scramble the column. Renders a PRE-DRAFT staff case with the story-data APIs
// stubbed so all six sections mount, then asserts their headings appear in order.
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { CaseDetailPage } from '../routes/cases/CaseDetailPage';

vi.mock('../auth/useAuth', () => ({ useAuth: () => ({ user: { sub: 's', email: 'a@x.com', roles: ['ops_staff'], role: 'ops_staff' } }) }));
vi.mock('../api/cases', () => ({
  getCase: vi.fn(async () => ({ data: {
    id: 'CASE-1', veteranId: 'VET-1', claimedCondition: 'Obstructive sleep apnea', claimType: 'initial',
    status: 'records', cdsVerdict: 'not_yet_run', refundEligible: false, currentVersion: 0,
    framingChoice: null, upstreamScCondition: null, veteranStatement: '', inServiceEvent: '',
    createdAt: '2026-05-01T00:00:00Z', updatedAt: new Date(Date.now() - 3_600_000).toISOString(), version: 2,
    veteran: { id: 'VET-1', firstName: 'Jane', lastName: 'Doe', email: 'j@x.com' },
    assignedPhysician: { fullName: 'Ryan Kasky' }, assignedRn: { fullName: 'RN One' },
    documents: [], draftJobs: [], corrections: [], emails: [], payments: [],
  } })),
  patchCase: vi.fn(), transitionCaseStatus: vi.fn(), deleteCase: vi.fn(),
  archiveCase: vi.fn(async () => undefined), restoreCase: vi.fn(async () => ({ data: {} })),
  listDraftJobs: vi.fn(async () => ({ data: [] })), listCorrections: vi.fn(async () => ({ data: [] })),
}));
vi.mock('../api/veterans', () => ({
  getVeteran: vi.fn(async () => ({ data: { id: 'VET-1', firstName: 'Jane', lastName: 'Doe', email: 'j@x.com', version: 1, scConditions: [], activeProblems: [], activeMedications: [], cases: [] } })),
  listDocuments: vi.fn(async () => ({ data: [] })), reocrDocument: vi.fn(), deleteDocument: vi.fn(async () => undefined),
  addScCondition: vi.fn(), updateScCondition: vi.fn(), deleteScCondition: vi.fn(), addProblem: vi.fn(), deleteProblem: vi.fn(),
  addMedication: vi.fn(), deleteMedication: vi.fn(),
  presignDocument: vi.fn(), uploadToPresignedUrl: vi.fn(), recordDocument: vi.fn(), viewDocument: vi.fn(),
}));
vi.mock('../api/chart-notes', () => ({ listChartNotes: vi.fn(async () => ({ data: [] })), createChartNote: vi.fn(), deleteChartNote: vi.fn(), patchChartNote: vi.fn() }));
// The pre-draft "AI Sanity Check" card was RETIRED 2026-06-25 (Ryan #68) — the page no longer fires the
// pre_draft impression. The post-draft line still uses this API (not exercised in this pre-draft case).
// Return a NON-NULL impression so that IF the card were still mounted it WOULD render — the test below
// asserts it does not, proving the retirement holds.
vi.mock('../api/sanity-impression', () => ({
  getSanityImpression: vi.fn(async () => ({ data: { stage: 'pre_draft', impression: 'concern', summary: 'should not render', missed: null } })),
}));
vi.mock('../api/letter', () => ({ getLetter: vi.fn() }));
vi.mock('../api/lookup', () => ({ getConditions: vi.fn(async () => ({ groups: [] })) }));
vi.mock('../layout/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
// The four story-data APIs — stubbed so all six sections mount.
vi.mock('../api/strategy-preview', () => ({
  getStrategyPreview: vi.fn(async () => ({ data: {
    evaluable: true, primaryArgument: 'OSA — secondary to PTSD', proposedMechanism: null, anchor: 'PTSD',
    tier: 'Strong', recommendedPathway: { kind: 'secondary', anchor: 'PTSD', basis: 'x', differsFromCurrent: false },
    criteria: [], summary: 'ok',
  } })),
}));
vi.mock('../api/case-viability', async () => {
  const actual = await vi.importActual<typeof import('../api/case-viability')>('../api/case-viability');
  return { ...actual, getSoapNote: vi.fn(async () => ({ data: null })), getCaseViability: vi.fn(async () => ({ data: {
    version: 2, claimed_canonical: 'Obstructive sleep apnea', viability: 'strong',
    best_anchor: { upstream_canonical: 'PTSD', upstream_verbatim: 'PTSD', M_static: 4, M_eff: 4, E: null, tier: 'blessed', basis: '3.310a', is_granted_sc: true, mechanism_class: null, requires: null },
    alternatives: [], why: 'Strong.', missing_fact: null, presumptive_redirect: null, graveyard_redirect: null,
    excluded_traps: [], confidence: 'high', mode: 'info_light', table_version: null, table_content_hash: null,
  } })) };
});
vi.mock('../api/chart-readiness', async () => {
  const actual = await vi.importActual<typeof import('../api/chart-readiness')>('../api/chart-readiness');
  return { ...actual, getChartReadiness: vi.fn(async () => ({ data: { ready: true, extractionState: 'chart_ready' } })) };
});
vi.mock('../api/extraction-coverage', async () => {
  const actual = await vi.importActual<typeof import('../api/extraction-coverage')>('../api/extraction-coverage');
  return { ...actual, getExtractionCoverage: vi.fn(async () => ({ data: { status: 'complete', coveragePct: 100, extractedPages: 40, totalPages: 40, totalFiles: 5, unknownPageFiles: 0, gaps: [] } })) };
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/cases/CASE-1']}>
        <Routes><Route path="/cases/:id" element={<CaseDetailPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CaseDetailPage — pre-draft Action-tab story order (locked)', () => {
  it('renders the Action-tab order (2026-06-29): Chart extraction → [collapsed: Background] → Assignments → Send to Drafter', async () => {
    renderPage();
    // RESTRUCTURE (2026-06-20): the clinical SOAP note moved to the new Summary tab; the static M/E
    // "Anchor viability" card (CaseViabilityCard) was ERASED from the page (item #64). The Action tab is
    // the operational story: Chart extraction stays visible; the dense analysis panel (Background &
    // argument) is nested in a collapsed "View full analysis" <details> — it still MOUNTS (so it's in the
    // DOM), just below extraction.
    // DE-NOISE (2026-06-29): the deterministic "Recommended plan" verdict card (RecommendedPlanCard) was
    // REMOVED from the page — it was a second pre-draft verdict that could contradict the SOAP card. The
    // SOAP/viability card is now the single pre-draft signal; Background & argument is a quiet summary.
    const extraction = await screen.findByRole('heading', { name: 'Chart extraction' });
    const background = screen.getByRole('heading', { name: 'Background & argument' });
    const assignments = screen.getByRole('heading', { name: 'Assignments' });
    const send = screen.getByRole('heading', { name: 'Send to Drafter' });
    // The erased M/E card must NOT render anywhere on the page.
    expect(screen.queryByRole('heading', { name: 'Anchor viability' })).not.toBeInTheDocument();
    // The retired deterministic "Recommended plan" verdict card must NOT render (2026-06-29).
    expect(screen.queryByRole('heading', { name: 'Recommended plan' })).not.toBeInTheDocument();
    // The retired pre-draft "AI Sanity Check" card must NOT render (Ryan #68, 2026-06-25) even though the
    // sanity-impression API is mocked to return a non-null impression — the card was unmounted.
    expect(screen.queryByRole('heading', { name: 'AI Sanity Check' })).not.toBeInTheDocument();
    expect(screen.queryByText('should not render')).not.toBeInTheDocument();

    const ordered = [extraction, background, assignments, send];
    // each heading must precede the next in document order
    ordered.reduce((prev, cur) => {
      expect(prev.compareDocumentPosition(cur) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      return cur;
    });
  });
});
