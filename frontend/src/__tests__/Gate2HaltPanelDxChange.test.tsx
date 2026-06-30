// Gate2HaltPanel — inline "Change diagnosis & re-draft" affordance (Michael Dick 2026-06-29). The
// dx-verification halt previously offered a dx change ONLY when the drafter surfaced a switchProposal.
// When the drafter buried the better-fit dx in prose (no switchProposal), the RN saw no inline way to
// re-aim the letter. This pins: (1) an ALWAYS-PRESENT input + "Change diagnosis & re-draft" button that
// patchCase(s) the chart dx THEN postDraft(s) the re-aim; (2) the existing "Switch to {dx}" button now
// ALSO patchCase(s) so the chart dx can't go stale while the letter drafts the new one.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Gate2HaltPanel } from '../components/Gate2HaltPanel';
import { postDraft } from '../api/drafter';
import { patchCase, type CaseDetail } from '../api/cases';
import type { DraftJob, Gate2HaltPayload } from '../types/prisma';

vi.mock('../api/drafter', async () => {
  const actual = await vi.importActual<typeof import('../api/drafter')>('../api/drafter');
  return { ...actual, postDraft: vi.fn() };
});
const postDraftMock = vi.mocked(postDraft);

vi.mock('../api/cases', async () => {
  const actual = await vi.importActual<typeof import('../api/cases')>('../api/cases');
  return { ...actual, patchCase: vi.fn(), transitionCaseStatus: vi.fn() };
});
const patchCaseMock = vi.mocked(patchCase);

const parkedCase: CaseDetail = {
  id: 'CASE-9', veteranId: 'VET-9', claimedCondition: 'lumbar strain', claimType: 'initial',
  status: 'needs_rn_decision', version: 6, currentVersion: 3, refundEligible: false, cdsVerdict: 'accept',
  createdAt: '2026-06-29T12:00:00.000Z', updatedAt: '2026-06-29T12:00:00.000Z',
  veteran: { id: 'VET-9', firstName: 'Test', lastName: 'Veteran', email: 't@example.com' },
  assignedPhysician: null, documents: [], draftJobs: [], corrections: [], emails: [], payments: [],
  operatorMessage: 'The pre-draft check could not confirm the claimed diagnosis.',
};

function jobWith(payload: Gate2HaltPayload): DraftJob {
  return {
    id: 'job-9', caseId: 'CASE-9', state: 'halted', version: 3,
    enqueuedAt: '2026-06-29T12:00:00.000Z', updatedAt: '2026-06-29T12:20:00.000Z',
    haltPayloadJson: payload,
  } as DraftJob;
}

function renderPanel(payload: Gate2HaltPayload, onChanged = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Gate2HaltPanel c={parkedCase} job={jobWith(payload)} onChanged={onChanged} onOpenEditor={vi.fn()} />
    </QueryClientProvider>,
  );
  return onChanged;
}

// A dx-verification halt (NOT a body-quality park). No switchProposal = the Michael Dick case.
const DX_HALT_NO_PROPOSAL: Gate2HaltPayload = {
  plainEnglish: 'The pre-draft check could not confirm the claimed diagnosis in the records.',
  claimedDxFound: 'uncertain', claimedDxEvidence: 'no explicit diagnosis line found',
  inServiceEventFound: 'found', inServiceEventEvidence: 'STR notes back complaints in service',
};
const DX_HALT_WITH_PROPOSAL: Gate2HaltPayload = {
  ...DX_HALT_NO_PROPOSAL,
  switchProposal: { dx: 'lumbar degenerative disc disease', whyMoreViable: 'imaging confirms DDD' },
};

describe('Gate2HaltPanel — inline Change diagnosis & re-draft (Michael Dick)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postDraftMock.mockResolvedValue({ data: { job: {}, publish: {} } } as never);
    patchCaseMock.mockResolvedValue({ data: { id: 'CASE-9' } } as never);
    // jsdom prompt/confirm: auto-accept the reason gate so the change proceeds.
    globalThis.prompt = vi.fn(() => 'records show osteoarthritis, not strain');
    globalThis.confirm = vi.fn(() => true);
  });

  it('NO switchProposal → the inline dx input + button is STILL present, and changing the dx patchCases THEN postDrafts', async () => {
    renderPanel(DX_HALT_NO_PROPOSAL);
    // The always-present affordance: there is no "Switch to {dx}" button (no proposal) but the input IS here.
    expect(screen.queryByRole('button', { name: /^Switch to /i })).not.toBeInTheDocument();
    const input = screen.getByPlaceholderText(/new diagnosis/i);
    fireEvent.change(input, { target: { value: 'osteoarthritis' } });
    fireEvent.click(screen.getByRole('button', { name: /change diagnosis & re-draft/i }));

    // (a) the chart dx is persisted FIRST (version-guarded), (b) THEN the draft is re-aimed.
    await waitFor(() => expect(patchCaseMock).toHaveBeenCalledTimes(1));
    expect(patchCaseMock).toHaveBeenCalledWith('CASE-9', { version: 6, claimedCondition: 'osteoarthritis' });
    await waitFor(() => expect(postDraftMock).toHaveBeenCalledTimes(1));
    expect(postDraftMock).toHaveBeenCalledWith('CASE-9', { rnDecision: { switchToCondition: 'osteoarthritis', reason: 'records show osteoarthritis, not strain' } });
    // ORDER: patchCase was invoked before postDraft (chart persisted first, then the letter re-aimed).
    const patchOrder = patchCaseMock.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    const draftOrder = postDraftMock.mock.invocationCallOrder[0] ?? -1;
    expect(patchOrder).toBeLessThan(draftOrder);
  });

  it('the reason gate is honored — cancelling the prompt makes NO calls', () => {
    globalThis.prompt = vi.fn(() => null); // RN cancels
    renderPanel(DX_HALT_NO_PROPOSAL);
    fireEvent.change(screen.getByPlaceholderText(/new diagnosis/i), { target: { value: 'osteoarthritis' } });
    fireEvent.click(screen.getByRole('button', { name: /change diagnosis & re-draft/i }));
    expect(patchCaseMock).not.toHaveBeenCalled();
    expect(postDraftMock).not.toHaveBeenCalled();
  });

  it('the existing "Switch to {dx}" button now ALSO patchCases the chart dx (was the stale-chart bug)', async () => {
    renderPanel(DX_HALT_WITH_PROPOSAL);
    fireEvent.click(screen.getByRole('button', { name: /switch to lumbar degenerative disc disease/i }));
    // The pre-existing bug: the switch re-aimed the letter but never patched the chart. It must now do both.
    await waitFor(() => expect(patchCaseMock).toHaveBeenCalledTimes(1));
    expect(patchCaseMock).toHaveBeenCalledWith('CASE-9', { version: 6, claimedCondition: 'lumbar degenerative disc disease' });
    await waitFor(() => expect(postDraftMock).toHaveBeenCalledWith('CASE-9', { rnDecision: expect.objectContaining({ switchToCondition: 'lumbar degenerative disc disease' }) }));
  });

  it('with a switchProposal → the inline input is pre-filled with the suggested dx', () => {
    renderPanel(DX_HALT_WITH_PROPOSAL);
    expect(screen.getByPlaceholderText(/new diagnosis/i)).toHaveValue('lumbar degenerative disc disease');
  });
});
