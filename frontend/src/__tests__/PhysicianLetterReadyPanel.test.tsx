import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PhysicianLetterReadyPanel } from '../components/PhysicianLetterReadyPanel';
import type { CaseDetail } from '../api/cases';
import type { DraftJob } from '../types/prisma';

// PhysicianLetterReadyPanel renders SendBackToRnModal which uses useMutation, so each
// render needs a QueryClientProvider in the tree.
function withQueryClient(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

// Fixture matches our actual Case / CaseDetail / CaseVeteranLite shapes (email not dob;
// currentVersion + refundEligible + cdsVerdict required).
const baseCase: CaseDetail = {
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
  veteran: {
    id: 'VET-1',
    firstName: 'Test',
    lastName: 'Veteran',
    email: 'test@example.com',
  },
  assignedPhysician: null,
  documents: [],
  draftJobs: [],
  corrections: [],
  emails: [],
  payments: [],
  probativeScore: 8,
  grade: 'A-',
  shipRecommendation: 'ship',
  operatorState: 'ready',
  runComplete: true,
};

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
  gradeSidecarJson: {
    targeted_revision_hints: [
      {
        section: 'VI',
        issue: 'preferred pediatric-onset framing over genetic-predisposition language.',
        suggested_fix: 'Do not show this.',
      },
      {
        section: 'VII',
        issue: 'kept aggravation as a secondary prong.',
        suggested_fix: 'Do not show this either.',
      },
      {
        section: 'VIII',
        issue: 'cited Khurana 2019 over Yang 2021.',
      },
    ],
  },
};

describe('PhysicianLetterReadyPanel', () => {
  it('renders the ready header and three disclosure cards without buttons inside the disclosure list', () => {
    render(withQueryClient(
      <PhysicianLetterReadyPanel
        c={baseCase}
        job={readyJob}
        canSendBack
        onOpenPdf={vi.fn()}
        onOpenSignOff={vi.fn()}
        onChanged={vi.fn()}
      />,
    ));

    expect(screen.getByText('Letter is ready for your review')).toBeInTheDocument();
    expect(screen.getByText('Grade: A-')).toBeInTheDocument();
    expect(screen.getByText('Probative score: 8/10')).toBeInTheDocument();
    expect(screen.getByText('3 things the system chose for you on close calls:')).toBeInTheDocument();

    expect(
      screen.getByText('preferred pediatric-onset framing over genetic-predisposition language.'),
    ).toBeInTheDocument();
    expect(screen.getByText('kept aggravation as a secondary prong.')).toBeInTheDocument();
    expect(screen.getByText('cited Khurana 2019 over Yang 2021.')).toBeInTheDocument();
    expect(screen.queryByText('Do not show this.')).not.toBeInTheDocument();

    const disclosureRegion = screen
      .getByText('3 things the system chose for you on close calls:')
      .closest('div');

    expect(disclosureRegion).not.toBeNull();

    if (disclosureRegion) {
      expect(within(disclosureRegion).queryAllByRole('button')).toHaveLength(0);
    }
  });

  it('opens PDF through the injected callback', async () => {
    const onOpenPdf = vi.fn();

    render(withQueryClient(
      <PhysicianLetterReadyPanel
        c={baseCase}
        job={readyJob}
        canSendBack={false}
        onOpenPdf={onOpenPdf}
        onOpenSignOff={vi.fn()}
        onChanged={vi.fn()}
      />,
    ));

    screen.getByRole('button', { name: 'Open PDF' }).click();

    expect(onOpenPdf).toHaveBeenCalledWith('drafter-artifacts/CASE-1/v2/v2.pdf');
  });

  it('uses the existing sign-off path for approve and sign', () => {
    const onOpenSignOff = vi.fn();

    render(withQueryClient(
      <PhysicianLetterReadyPanel
        c={baseCase}
        job={readyJob}
        canSendBack={false}
        onOpenPdf={vi.fn()}
        onOpenSignOff={onOpenSignOff}
        onChanged={vi.fn()}
      />,
    ));

    screen.getByRole('button', { name: 'Approve and sign' }).click();

    expect(onOpenSignOff).toHaveBeenCalled();
  });

  it('surfaces template/anchor-gate findings (qa_report criticals) at sign-off, skipping audit-only', () => {
    const jobWithGate: DraftJob = {
      ...readyJob,
      gradeSidecarJson: {
        template_gate_findings: [
          { id: 'anchor_a1_missing_institutional', message: 'Section VI is missing an institutional anchor (A1).', severity: 'critical', physician_decision: true },
          { id: 'epi_anchor_offtopic', message: 'The epidemiologic anchor does not match the claimed condition.', severity: 'warning', physician_decision: true },
          { id: 'audit_only_note', message: 'Should never render to the physician.', severity: 'warning', audit_only: true },
        ],
      },
    };
    render(withQueryClient(
      <PhysicianLetterReadyPanel c={baseCase} job={jobWithGate} canSendBack={false} onOpenPdf={vi.fn()} onOpenSignOff={vi.fn()} onChanged={vi.fn()} />,
    ));
    expect(screen.getByText('Anchor and template quality - physician review (overridable)')).toBeInTheDocument();
    expect(screen.getByText('Section VI is missing an institutional anchor (A1).')).toBeInTheDocument();
    expect(screen.getByText('The epidemiologic anchor does not match the claimed condition.')).toBeInTheDocument();
    expect(screen.queryByText('Should never render to the physician.')).not.toBeInTheDocument();
  });

  it('renders no anchor-gate callout when there are no findings (forward-compatible)', () => {
    render(withQueryClient(
      <PhysicianLetterReadyPanel c={baseCase} job={readyJob} canSendBack={false} onOpenPdf={vi.fn()} onOpenSignOff={vi.fn()} onChanged={vi.fn()} />,
    ));
    expect(screen.queryByText('Anchor and template quality - physician review (overridable)')).not.toBeInTheDocument();
  });

  it('degrades gracefully on a malformed findings payload (untrusted worker) without crashing', () => {
    // null/non-object/blank elements + a valid one mixed in — must not throw the render.
    const malformed = { ...readyJob, gradeSidecarJson: { template_gate_findings: [null, 'x', 42, {}, { message: '  ' }, { message: 'Real finding survives.', severity: 'critical' }] } } as unknown as DraftJob;
    render(withQueryClient(
      <PhysicianLetterReadyPanel c={baseCase} job={malformed} canSendBack={false} onOpenPdf={vi.fn()} onOpenSignOff={vi.fn()} onChanged={vi.fn()} />,
    ));
    expect(screen.getByText('Real finding survives.')).toBeInTheDocument();
    expect(screen.getByText('Letter is ready for your review')).toBeInTheDocument(); // panel rendered, no crash
  });

  it('does not crash when template_gate_findings is not an array', () => {
    const badShape = { ...readyJob, gradeSidecarJson: { template_gate_findings: 'oops' } } as unknown as DraftJob;
    render(withQueryClient(
      <PhysicianLetterReadyPanel c={baseCase} job={badShape} canSendBack={false} onOpenPdf={vi.fn()} onOpenSignOff={vi.fn()} onChanged={vi.fn()} />,
    ));
    expect(screen.getByText('Letter is ready for your review')).toBeInTheDocument();
    expect(screen.queryByText('Anchor and template quality - physician review (overridable)')).not.toBeInTheDocument();
  });

  it('calls onEditText when Edit text is clicked', () => {
    const onEditText = vi.fn();
    render(withQueryClient(
      <PhysicianLetterReadyPanel c={baseCase} job={readyJob} canSendBack={false} onOpenPdf={vi.fn()} onEditText={onEditText} onOpenSignOff={vi.fn()} onChanged={vi.fn()} />,
    ));
    screen.getByRole('button', { name: 'Edit text' }).click();
    expect(onEditText).toHaveBeenCalled();
  });

  it('disables Edit text when no onEditText is provided', () => {
    render(withQueryClient(
      <PhysicianLetterReadyPanel c={baseCase} job={readyJob} canSendBack={false} onOpenPdf={vi.fn()} onOpenSignOff={vi.fn()} onChanged={vi.fn()} />,
    ));
    expect(screen.getByRole('button', { name: 'Edit text' })).toBeDisabled();
  });
});
