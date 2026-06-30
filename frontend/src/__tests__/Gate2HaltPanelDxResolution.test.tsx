// Gate2HaltPanel — dx-resolution chooser (#218a). The FRN drafter (contract fixed, image not yet
// redeployed) emits `haltPayloadJson.dxResolution = { mode, adoptedDx?, candidates[], allowFreeType,
// confidence, note }` on a dx-verification HALT. This pins the EMR-side consumption:
//   - 'needs_clarification' → candidate buttons render + clicking one re-aims via the SAME #213
//     changeDx flow (patchCase chart dx THEN postDraft switchToCondition), reason-gated.
//   - free-type box → still present (allowFreeType) and re-drafts.
//   - dxResolution ABSENT/null → identical to the current #213-only render (NO REGRESSION) — the
//     common path until the drafter ships.
//   - 'no_dx' → today's real-reason behavior (override / re-run / pause), note optionally surfaced.
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
} as unknown as CaseDetail;

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

const BASE_DX_HALT: Gate2HaltPayload = {
  plainEnglish: 'The pre-draft check could not confirm the claimed diagnosis in the records.',
  claimedDxFound: 'uncertain', claimedDxEvidence: 'no explicit diagnosis line found',
  inServiceEventFound: 'found', inServiceEventEvidence: 'STR notes back complaints in service',
};

const NEEDS_CLARIFICATION: Gate2HaltPayload = {
  ...BASE_DX_HALT,
  dxResolution: {
    mode: 'needs_clarification',
    candidates: ['lumbar degenerative disc disease', 'lumbar radiculopathy'],
    allowFreeType: true,
    confidence: 'medium',
    note: 'The records support more than one back diagnosis — pick the one the letter should argue.',
  },
};

describe('Gate2HaltPanel — dx-resolution chooser (#218a)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postDraftMock.mockResolvedValue({ data: { job: {}, publish: {} } } as never);
    patchCaseMock.mockResolvedValue({ data: { id: 'CASE-9' } } as never);
    globalThis.prompt = vi.fn(() => 'records best support DDD');
    globalThis.confirm = vi.fn(() => true);
  });

  it("needs_clarification → renders the note + a clickable button per candidate, and clicking re-aims via patchCase THEN postDraft", async () => {
    renderPanel(NEEDS_CLARIFICATION);
    expect(screen.getByText(/pick the one the letter should argue/i)).toBeInTheDocument();
    // One button per candidate, by the candidate text.
    const btn = screen.getByRole('button', { name: 'lumbar degenerative disc disease' });
    expect(btn).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'lumbar radiculopathy' })).toBeInTheDocument();

    fireEvent.click(btn);
    // Same #213 flow: chart dx persisted FIRST (version-guarded), THEN the draft re-aimed.
    await waitFor(() => expect(patchCaseMock).toHaveBeenCalledTimes(1));
    expect(patchCaseMock).toHaveBeenCalledWith('CASE-9', { version: 6, claimedCondition: 'lumbar degenerative disc disease' });
    await waitFor(() => expect(postDraftMock).toHaveBeenCalledTimes(1));
    expect(postDraftMock).toHaveBeenCalledWith('CASE-9', { rnDecision: { switchToCondition: 'lumbar degenerative disc disease', reason: 'records best support DDD' } });
    const patchOrder = patchCaseMock.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    const draftOrder = postDraftMock.mock.invocationCallOrder[0] ?? -1;
    expect(patchOrder).toBeLessThan(draftOrder);
  });

  it('needs_clarification candidate click honors the reason gate — cancelling makes NO calls', () => {
    globalThis.prompt = vi.fn(() => null);
    renderPanel(NEEDS_CLARIFICATION);
    fireEvent.click(screen.getByRole('button', { name: 'lumbar radiculopathy' }));
    expect(patchCaseMock).not.toHaveBeenCalled();
    expect(postDraftMock).not.toHaveBeenCalled();
  });

  it('needs_clarification with allowFreeType → the free-type box is STILL present and re-drafts', async () => {
    renderPanel(NEEDS_CLARIFICATION);
    const input = screen.getByPlaceholderText(/new diagnosis/i);
    expect(input).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'spondylolisthesis' } });
    fireEvent.click(screen.getByRole('button', { name: /change diagnosis & re-draft/i }));
    await waitFor(() => expect(patchCaseMock).toHaveBeenCalledWith('CASE-9', { version: 6, claimedCondition: 'spondylolisthesis' }));
    await waitFor(() => expect(postDraftMock).toHaveBeenCalledWith('CASE-9', { rnDecision: expect.objectContaining({ switchToCondition: 'spondylolisthesis' }) }));
  });

  it('needs_clarification with allowFreeType:false → the free-type box is suppressed but candidates + pause remain (not dead-ended)', () => {
    renderPanel({ ...NEEDS_CLARIFICATION, dxResolution: { ...NEEDS_CLARIFICATION.dxResolution!, allowFreeType: false } });
    expect(screen.queryByPlaceholderText(/new diagnosis/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'lumbar degenerative disc disease' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /pause to get records/i })).toBeInTheDocument();
  });

  it('dxResolution ABSENT → renders identical to the current #213-only path (NO REGRESSION): no chooser, free-type box present', () => {
    renderPanel(BASE_DX_HALT);
    // No candidate chooser heading.
    expect(screen.queryByText(/which diagnosis should the letter argue/i)).not.toBeInTheDocument();
    // The #213 box + the standard halt actions are exactly as today.
    expect(screen.getByPlaceholderText(/new diagnosis/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /draft anyway \(override\)/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /records are in — re-run/i })).toBeInTheDocument();
  });

  it('no_dx → today real-reason behavior (override / re-run / pause), no candidate chooser, note surfaced', () => {
    renderPanel({
      ...BASE_DX_HALT,
      dxResolution: { mode: 'no_dx', candidates: [], allowFreeType: true, confidence: 'low', note: 'No diagnosis could be resolved from the records on file.' },
    });
    expect(screen.queryByText(/which diagnosis should the letter argue/i)).not.toBeInTheDocument();
    expect(screen.getByText(/no diagnosis could be resolved from the records/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /draft anyway \(override\)/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /records are in — re-run/i })).toBeInTheDocument();
    // free-type box (allowFreeType true) stays — RN never dead-ended.
    expect(screen.getByPlaceholderText(/new diagnosis/i)).toBeInTheDocument();
  });
});
