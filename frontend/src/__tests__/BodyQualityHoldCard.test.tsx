import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Gate2HaltPanel } from '../components/Gate2HaltPanel';
import { postDraft } from '../api/drafter';
import { transitionCaseStatus, type CaseDetail } from '../api/cases';
import type { DraftJob } from '../types/prisma';

vi.mock('../api/drafter', async () => {
  const actual = await vi.importActual<typeof import('../api/drafter')>('../api/drafter');
  return { ...actual, postDraft: vi.fn() };
});
const postDraftMock = vi.mocked(postDraft);

vi.mock('../api/cases', async () => {
  const actual = await vi.importActual<typeof import('../api/cases')>('../api/cases');
  return { ...actual, transitionCaseStatus: vi.fn() };
});
const transitionCaseStatusMock = vi.mocked(transitionCaseStatus);

const parkedCase: CaseDetail = {
  id: 'CASE-9',
  veteranId: 'VET-9',
  claimedCondition: 'Obstructive sleep apnea',
  claimType: 'initial',
  status: 'needs_rn_decision',
  version: 6,
  currentVersion: 3,
  refundEligible: false,
  cdsVerdict: 'accept',
  createdAt: '2026-06-22T12:00:00.000Z',
  updatedAt: '2026-06-22T12:00:00.000Z',
  veteran: { id: 'VET-9', firstName: 'Test', lastName: 'Veteran', email: 't@example.com' },
  assignedPhysician: null,
  documents: [], draftJobs: [], corrections: [], emails: [], payments: [],
  operatorMessage: 'Drafting completed but the quality gate found a fabricated PMID.',
};

function jobWith(o: Partial<DraftJob> = {}): DraftJob {
  return {
    id: 'job-9', caseId: 'CASE-9', state: 'halted', version: 3,
    enqueuedAt: '2026-06-22T12:00:00.000Z', updatedAt: '2026-06-22T12:20:00.000Z',
    haltPayloadJson: {
      haltGate: 'body_quality', reasonCode: 'body_quality_critical',
      plainEnglish: 'Drafting completed but the quality gate found a fabricated PMID.',
      materialIds: ['pmid_not_found'],
    },
    ...o,
  };
}

function renderPanel(job: DraftJob, onOpenEditor = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Gate2HaltPanel c={parkedCase} job={job} onChanged={vi.fn()} onOpenEditor={onOpenEditor} />
    </QueryClientProvider>,
  );
  return onOpenEditor;
}

describe('BodyQualityHoldCard (via Gate2HaltPanel)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postDraftMock.mockResolvedValue({ data: { job: {}, publish: {} } });
    // jsdom has no usable window.confirm; auto-accept so confirm()-gated actions proceed. Assign
    // directly (spyOn the missing prop is unreliable) AFTER clearAllMocks so it isn't reset to falsy.
    globalThis.confirm = vi.fn(() => true);
  });

  it('with a produced draft (artifactTxtS3Key present): PRIMARY action opens the editor; re-draft is secondary', () => {
    const onOpenEditor = renderPanel(jobWith({ artifactTxtS3Key: 'drafter-artifacts/CASE-9/v3/v3.txt' }));
    // Advisory, not re-draft-only: the held letter can be opened + fixed by hand.
    const openEditorBtn = screen.getByRole('button', { name: /open letter editor/i });
    fireEvent.click(openEditorBtn);
    expect(onOpenEditor).toHaveBeenCalledTimes(1);
    // Re-draft is still offered (secondary), but the editor is the lead.
    expect(screen.getByRole('button', { name: /re-draft/i })).toBeInTheDocument();
    // The specific defect is still surfaced (the human-readable defect label).
    expect(screen.getByText('A cited PMID was not found (possible fabricated citation)')).toBeInTheDocument();
  });

  it('with NO produced draft (no artifact key): re-draft only, no editor button', () => {
    renderPanel(jobWith({})); // no artifactTxtS3Key / artifactPdfS3Key
    expect(screen.queryByRole('button', { name: /open letter editor/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send to doctor/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /re-draft/i })).toBeInTheDocument();
  });

  // ── FORWARD DOOR (2026-06-22, "see/edit/FORWARD — never a trap") ──
  it('with a produced draft: offers "Send to doctor for review" and it FORWARDS needs_rn_decision -> physician_review', async () => {
    transitionCaseStatusMock.mockResolvedValue({ data: { status: 'physician_review', version: 7 } } as never);
    renderPanel(jobWith({ artifactTxtS3Key: 'drafter-artifacts/CASE-9/v3/v3.txt' }));

    const sendBtn = screen.getByRole('button', { name: /send to doctor for review/i });
    fireEvent.click(sendBtn);

    // The held letter moves FORWARD to the doctor — not trapped requiring a re-draft to escape the park.
    await waitFor(() => expect(transitionCaseStatusMock).toHaveBeenCalledTimes(1));
    expect(transitionCaseStatusMock).toHaveBeenCalledWith('CASE-9', expect.objectContaining({
      from: 'needs_rn_decision',
      to: 'physician_review',
      version: 6,
    }));
    // The forward path does NOT re-draft (no spend, no discarded fix).
    expect(postDraftMock).not.toHaveBeenCalled();
  });
});
