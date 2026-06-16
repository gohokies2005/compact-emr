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
// The auto-fired sanity line fires this; mock it (null = no impression) so the test makes no network call.
vi.mock('../api/sanity-impression', () => ({ getSanityImpression: vi.fn(async () => ({ data: null })) }));
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
  return { ...actual, getCaseViability: vi.fn(async () => ({ data: {
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

describe('CaseDetailPage — pre-draft Overview story order (locked)', () => {
  it('renders the six sections in Ryan’s SOAP order: Background → Chart extraction → Anchor viability → Recommended plan → Assignments → Send to Drafter', async () => {
    renderPage();
    // Wait for the lead section, then collect all six section headings.
    const background = await screen.findByRole('heading', { name: 'Background & argument' });
    const extraction = screen.getByRole('heading', { name: 'Chart extraction' });
    const assessment = screen.getByRole('heading', { name: 'Anchor viability' });
    const plan = screen.getByRole('heading', { name: 'Recommended plan' });
    const assignments = screen.getByRole('heading', { name: 'Assignments' });
    const send = screen.getByRole('heading', { name: 'Send to Drafter' });

    const ordered = [background, extraction, assessment, plan, assignments, send];
    // each heading must precede the next in document order
    ordered.reduce((prev, cur) => {
      expect(prev.compareDocumentPosition(cur) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      return cur;
    });
  });
});
