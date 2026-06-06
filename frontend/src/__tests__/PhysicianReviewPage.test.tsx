import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PhysicianReviewPage } from '../routes/physician/PhysicianReviewPage';
import { getCase, type CaseDetail } from '../api/cases';
import type { DraftJob } from '../types/prisma';

vi.mock('../api/cases', async () => {
  const actual = await vi.importActual<typeof import('../api/cases')>('../api/cases');
  return { ...actual, getCase: vi.fn() };
});

vi.mock('../api/drafter', () => ({
  getArtifactPdfUrl: vi.fn(),
}));

vi.mock('../layout/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const getCaseMock = vi.mocked(getCase);

const readyJob: DraftJob = {
  id: 'draft-job-1',
  caseId: 'CASE-1',
  state: 'done',
  version: 2,
  enqueuedAt: '2026-05-25T12:00:00.000Z',
  startedAt: '2026-05-25T12:01:00.000Z',
  completedAt: '2026-05-25T12:20:00.000Z',
  updatedAt: '2026-05-25T12:20:00.000Z',
  artifactPdfS3Key: 'drafter-artifacts/CASE-1/v2/v2.pdf',
};

const readyCase: CaseDetail = {
  id: 'CASE-1',
  veteranId: 'VET-1',
  claimedCondition: 'Sleep apnea',
  claimType: 'supplemental',
  status: 'physician_review',
  version: 3,
  currentVersion: 2,
  refundEligible: false,
  cdsVerdict: 'accept',
  createdAt: '2026-05-25T12:00:00.000Z',
  updatedAt: '2026-05-25T12:00:00.000Z',
  veteran: { id: 'VET-1', firstName: 'Matthew', lastName: 'Young', email: 'm@example.com' },
  assignedPhysician: null,
  documents: [],
  draftJobs: [readyJob],
  corrections: [],
  emails: [],
  payments: [],
  probativeScore: 8,
  grade: 'A-',
  shipRecommendation: 'ship',
  operatorState: 'ready',
  runComplete: true,
};

function renderReview() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/p/review/CASE-1']}>
        <Routes>
          <Route path="/p/review/:caseId" element={<PhysicianReviewPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PhysicianReviewPage', () => {
  it('renders the ready panel and exposes no A/B decision buttons in the disclosure region', async () => {
    getCaseMock.mockResolvedValue({ data: readyCase });
    renderReview();

    expect(await screen.findByText('Letter is ready for your review')).toBeInTheDocument();
    // Header shows the veteran name + case id.
    expect(screen.getAllByText(/Young, Matthew/).length).toBeGreaterThan(0);
  });

  it('shows the not-ready empty state when the case is not ready', async () => {
    getCaseMock.mockResolvedValue({
      data: { ...readyCase, runComplete: false, shipRecommendation: 'revise' },
    });
    renderReview();

    expect(
      await screen.findByText('This case is not ready for physician review.'),
    ).toBeInTheDocument();
  });
});
