// Gate-1 pre-fill tests (work order Task 3 — the modal previously "read nothing"). Locks: the seed
// from the draft-readiness feed, the deliberate absent-evidence-stays-UNSET policy, the RN-edit
// survival guarantee, the untouched attestation write contract, and full fail-open to today's
// blank modal when the feed is loading/erroring/still-building.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Gate1ChecklistModal } from '../components/Gate1ChecklistModal';
import { getDraftReadiness, type DraftReadinessResult } from '../api/draft-readiness';
import { postGate1Attestations } from '../api/drafter';

vi.mock('../api/draft-readiness', () => ({
  getDraftReadiness: vi.fn(),
}));
vi.mock('../api/drafter', () => ({
  postGate1Attestations: vi.fn(),
}));

const readinessMock = vi.mocked(getDraftReadiness);
const postMock = vi.mocked(postGate1Attestations);

function renderModal(props: Partial<Parameters<typeof Gate1ChecklistModal>[0]> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  function Wrapper({ children }: { readonly children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return render(
    <Gate1ChecklistModal
      caseId="CASE-1"
      claimType="supplemental"
      claimedCondition="Obstructive Sleep Apnea"
      draftAttempt={1}
      onConfirmed={vi.fn()}
      onClose={vi.fn()}
      {...props}
    />,
    { wrapper: Wrapper },
  );
}

function readiness(overrides: Partial<DraftReadinessResult> = {}): { data: DraftReadinessResult } {
  return {
    data: {
      ready: true,
      items: [
        { key: 'current_diagnosis', label: 'Current diagnosis', present: true, basis: '"Obstructive Sleep Apnea" found in problem list' },
        { key: 'in_service_event', label: 'In-service event / service record', present: true, basis: 'satisfied by granted SC anchor Anxiety (70%)' },
        { key: 'sc_conditions', label: 'Service-connected primary', present: true, basis: '1 granted SC condition(s) on file' },
        { key: 'denial_letter', label: 'VA denial letter (appeal)', present: true, basis: 'denial/decision document on file' },
      ],
      missing: [],
      summary: 'All essential documents are on file.',
      buildState: 'chart_ready',
      caseFraming: {
        version: 1,
        framing: 'secondary',
        grantedScAnchors: [{ condition: 'Anxiety', ratingPct: 70, status: 'service_connected' }],
        upstreamScCondition: 'Anxiety / GAD',
        framingChoice: null,
        claimType: 'supplemental',
        source: 'derived',
        derivedAt: '2026-06-10T00:00:00.000Z',
      },
      ...overrides,
    },
  };
}

/** The radio input for a given item key + option label. */
function radio(itemKey: string, label: string): HTMLInputElement {
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(`input[name="${itemKey}"]`));
  const target = inputs.find((el) => el.parentElement?.textContent?.trim() === label);
  if (target === undefined) throw new Error(`no ${label} radio for ${itemKey}`);
  return target;
}

beforeEach(() => {
  vi.clearAllMocks();
  postMock.mockResolvedValue({ data: { written: 4 } });
});

describe('Gate1ChecklistModal pre-fill', () => {
  it('seeds Yes from present evidence and renders the basis lines + provenance', async () => {
    readinessMock.mockResolvedValue(readiness());
    renderModal();
    await waitFor(() => expect(radio('dx_present', 'Yes').checked).toBe(true));
    expect(radio('in_service_event', 'Yes').checked).toBe(true);
    expect(screen.getByText(/satisfied by granted SC anchor Anxiety \(70%\)/)).toBeInTheDocument();
    expect(screen.getByText(/"Obstructive Sleep Apnea" found in problem list/)).toBeInTheDocument();
    expect(screen.getByText(/auto-derived from the granted SC conditions/)).toBeInTheDocument();
    expect(screen.getByText(/anchor: Anxiety \/ GAD/)).toBeInTheDocument();
  });

  it('does NOT pre-pick No for absent evidence — radio unset, amber message shown, Start disabled', async () => {
    readinessMock.mockResolvedValue(readiness({
      items: [
        { key: 'current_diagnosis', label: 'Current diagnosis', present: false, basis: 'not in problem list', message: 'Essential documents missing: A current diagnosis for Obstructive Sleep Apnea is not on file. Please upload a medical record showing the current diagnosis and redraft.' },
        { key: 'in_service_event', label: 'In-service event / service record', present: true, basis: 'DD-214 / service record on file' },
      ],
    }));
    renderModal();
    await waitFor(() => expect(radio('in_service_event', 'Yes').checked).toBe(true));
    expect(radio('dx_present', 'Yes').checked).toBe(false);
    expect(radio('dx_present', 'No').checked).toBe(false);
    expect(screen.getByText(/A current diagnosis for Obstructive Sleep Apnea is not on file/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start draft' })).toBeDisabled();
  });

  it('an RN answer survives the seed (prev wins in the merge)', async () => {
    let resolve!: (v: { data: DraftReadinessResult }) => void;
    readinessMock.mockReturnValue(new Promise((r) => { resolve = r; }));
    renderModal();
    // RN clicks No on dx_present BEFORE the feed lands
    fireEvent.click(radio('dx_present', 'No'));
    resolve(readiness());
    await waitFor(() => expect(radio('in_service_event', 'Yes').checked).toBe(true));
    expect(radio('dx_present', 'No').checked).toBe(true); // not clobbered by the seed's Yes
    expect(radio('dx_present', 'Yes').checked).toBe(false);
  });

  it('the attestation write contract is unchanged — pre-filled answers post the same shape', async () => {
    readinessMock.mockResolvedValue(readiness());
    renderModal();
    const start = screen.getByRole('button', { name: 'Start draft' });
    await waitFor(() => expect(start).not.toBeDisabled());
    fireEvent.click(start);
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('CASE-1', 1, [
      { item: 'in_service_event', decision: 'yes' },
      { item: 'dx_present', decision: 'yes' },
      { item: 'sc_conditions', decision: 'yes' },
      { item: 'prior_denial', decision: 'yes' },
    ]));
  });

  it('fail-open: chart still building → blank modal exactly as today', async () => {
    readinessMock.mockResolvedValue(readiness({ buildState: 'extracting', items: [], caseFraming: undefined as never }));
    renderModal();
    await waitFor(() => expect(readinessMock).toHaveBeenCalled());
    for (const key of ['dx_present', 'in_service_event', 'sc_conditions', 'prior_denial']) {
      expect(radio(key, 'Yes').checked).toBe(false);
      expect(radio(key, 'No').checked).toBe(false);
    }
    expect(screen.getByRole('button', { name: 'Start draft' })).toBeDisabled();
  });

  it('fail-open: feed error → blank modal, manual fill still works', async () => {
    readinessMock.mockRejectedValue(new Error('boom'));
    renderModal();
    await waitFor(() => expect(readinessMock).toHaveBeenCalled());
    expect(radio('dx_present', 'Yes').checked).toBe(false);
    fireEvent.click(radio('dx_present', 'Yes'));
    expect(radio('dx_present', 'Yes').checked).toBe(true);
  });
});
