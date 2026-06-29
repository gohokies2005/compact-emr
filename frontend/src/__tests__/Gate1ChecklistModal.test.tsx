// Gate-1 is a PLAIN RN ATTESTATION (Dr. Kasky 2026-06-29). These lock: every radio starts UNSET (no
// machine-computed ✓/⚠ / no Yes pre-fill), NO "Essential documents missing" caution is ever rendered,
// the readiness auto-evaluation is no longer consulted, the nexus-judgment item is present + highlighted,
// the Start-draft gate is the human attestation (all resolved, no "No"), and the attestation write
// contract posts the four item keys.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Gate1ChecklistModal } from '../components/Gate1ChecklistModal';
import { postGate1Attestations } from '../api/drafter';

vi.mock('../api/drafter', () => ({
  postGate1Attestations: vi.fn(),
}));

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

/** The radio input for a given item key + option label. */
function radio(itemKey: string, label: string): HTMLInputElement {
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(`input[name="${itemKey}"]`));
  const target = inputs.find((el) => el.parentElement?.textContent?.trim() === label);
  if (target === undefined) throw new Error(`no ${label} radio for ${itemKey}`);
  return target;
}

const ITEM_KEYS = ['dx_present', 'sc_conditions', 'prior_denial', 'nexus_judgment'] as const;

beforeEach(() => {
  vi.clearAllMocks();
  postMock.mockResolvedValue({ data: { written: 4 } });
});

describe('Gate1ChecklistModal — human attestation (no auto-evaluation)', () => {
  it('renders Dr. Kasky\'s four items, every radio UNSET, Start disabled', () => {
    renderModal();
    for (const key of ITEM_KEYS) {
      expect(radio(key, 'Yes').checked).toBe(false);
      expect(radio(key, 'No').checked).toBe(false);
    }
    expect(screen.getByRole('button', { name: 'Start draft' })).toBeDisabled();
  });

  it('renders the nexus-judgment question as the highlighted primary call', () => {
    renderModal();
    expect(screen.getByText(/Clinical judgment/i)).toBeInTheDocument();
    expect(screen.getByText(/plausible medical nexus to author/i)).toBeInTheDocument();
  });

  it('NEVER renders an "Essential documents missing" caution, even with a documented-but-differently-named dx', () => {
    // The exact false-firing case: chart documents a related foot pathology, claim is "Plantar Fasciitis".
    renderModal({ claimedCondition: 'Plantar Fasciitis' });
    expect(screen.queryByText(/Essential documents missing/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/not on file/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/diagnosis missing/i)).not.toBeInTheDocument();
    // no machine ✓/⚠ marks
    expect(document.body.textContent).not.toContain('✓');
    expect(document.body.textContent).not.toContain('⚠');
  });

  it('sc_conditions and prior_denial offer Not applicable; dx and nexus do not', () => {
    renderModal({ claimType: 'initial' });
    expect(() => radio('sc_conditions', 'Not applicable')).not.toThrow();
    expect(() => radio('prior_denial', 'Not applicable')).not.toThrow();
    expect(() => radio('dx_present', 'Not applicable')).toThrow();
    expect(() => radio('nexus_judgment', 'Not applicable')).toThrow();
  });

  it('a "No" on any item blocks the draft and shows the stop message', () => {
    renderModal();
    fireEvent.click(radio('dx_present', 'Yes'));
    fireEvent.click(radio('sc_conditions', 'Not applicable'));
    fireEvent.click(radio('prior_denial', 'Not applicable'));
    fireEvent.click(radio('nexus_judgment', 'No'));
    expect(screen.getByText(/A "No" stops the draft/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start draft' })).toBeDisabled();
  });

  it('resolving every item (no "No") enables Start and posts the four attestations', async () => {
    const onConfirmed = vi.fn();
    renderModal({ onConfirmed });
    fireEvent.click(radio('dx_present', 'Yes'));
    fireEvent.click(radio('sc_conditions', 'Yes'));
    fireEvent.click(radio('prior_denial', 'Not applicable'));
    fireEvent.click(radio('nexus_judgment', 'Yes'));
    const start = screen.getByRole('button', { name: 'Start draft' });
    expect(start).not.toBeDisabled();
    fireEvent.click(start);
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('CASE-1', 1, [
      { item: 'dx_present', decision: 'yes' },
      { item: 'sc_conditions', decision: 'yes' },
      { item: 'prior_denial', decision: 'not_applicable' },
      { item: 'nexus_judgment', decision: 'yes' },
    ]));
    await waitFor(() => expect(onConfirmed).toHaveBeenCalled());
  });

  it('an override requires a reason before the attestation is accepted', async () => {
    renderModal();
    fireEvent.click(radio('dx_present', 'Override'));
    fireEvent.click(radio('sc_conditions', 'Yes'));
    fireEvent.click(radio('prior_denial', 'Not applicable'));
    fireEvent.click(radio('nexus_judgment', 'Yes'));
    // override reason still empty → Start disabled
    expect(screen.getByRole('button', { name: 'Start draft' })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/Reason \(required for override\)/i), { target: { value: 'records pending upload' } });
    const start = screen.getByRole('button', { name: 'Start draft' });
    expect(start).not.toBeDisabled();
    fireEvent.click(start);
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('CASE-1', 1, [
      { item: 'dx_present', decision: 'override', reason: 'records pending upload' },
      { item: 'sc_conditions', decision: 'yes' },
      { item: 'prior_denial', decision: 'not_applicable' },
      { item: 'nexus_judgment', decision: 'yes' },
    ]));
  });
});
