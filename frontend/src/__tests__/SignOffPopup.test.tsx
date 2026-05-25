import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SignOffPopup } from '../components/SignOffPopup';
import { signOffCase, type SignOff } from '../api/cases';

vi.mock('../api/cases', async () => {
  const actual = await vi.importActual<typeof import('../api/cases')>('../api/cases');
  return { ...actual, signOffCase: vi.fn() };
});

const signOffCaseMock = vi.mocked(signOffCase);

const sampleResponse: SignOff = {
  id: 'SO-1',
  caseId: 'CASE-1',
  physicianId: 'PHYS-001',
  signedAt: '2026-05-25T18:00:00.000Z',
  answersJson: {
    records_reviewed: true,
    diagnosis_documented: true,
    nexus_supported: true,
    no_phi_in_letter: true,
    final_pdf_correct: true,
  },
  notes: null,
  createdAt: '2026-05-25T18:00:00.000Z',
  updatedAt: '2026-05-25T18:00:00.000Z',
  version: 1,
};

function renderPopup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onClose = vi.fn();
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <SignOffPopup caseId="CASE-1" open={true} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { ...utils, queryClient, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  signOffCaseMock.mockResolvedValue({ data: sampleResponse });
});

describe('SignOffPopup', () => {
  it('renders all five sign-off questions', () => {
    renderPopup();
    expect(screen.getByText('I reviewed all uploaded records and the chart.')).toBeInTheDocument();
    expect(screen.getByText('The claimed diagnosis is documented in the records.')).toBeInTheDocument();
    expect(screen.getByText('Medical literature supports >50% probability.')).toBeInTheDocument();
    expect(screen.getByText('The letter contains no PHI that should not be there.')).toBeInTheDocument();
    expect(screen.getByText('The final PDF preview is correct (name, condition, date).')).toBeInTheDocument();
  });

  it('Submit button is disabled until all five questions have an explicit answer', () => {
    renderPopup();
    const submit = screen.getByRole('button', { name: /Submit sign-off/i });
    expect(submit).toBeDisabled();

    const yesButtons = screen.getAllByRole('button', { name: 'Yes' });
    // Answer first 4 only.
    yesButtons.slice(0, 4).forEach((b) => fireEvent.click(b));
    expect(submit).toBeDisabled();

    // Answer the fifth — submit unlocks.
    const lastYes = yesButtons[4];
    if (lastYes) fireEvent.click(lastYes);
    expect(submit).not.toBeDisabled();
  });

  it('toggles between Yes and No on the same question', () => {
    renderPopup();
    const yesButtons = screen.getAllByRole('button', { name: 'Yes' });
    const noButtons = screen.getAllByRole('button', { name: 'No' });
    const firstYes = yesButtons[0];
    const firstNo = noButtons[0];
    if (!firstYes || !firstNo) throw new Error('expected first Yes/No buttons');

    fireEvent.click(firstYes);
    expect(firstYes.className).toContain('bg-emerald-100');
    expect(firstNo.className).not.toContain('bg-rose-100');

    fireEvent.click(firstNo);
    expect(firstNo.className).toContain('bg-rose-100');
    expect(firstYes.className).not.toContain('bg-emerald-100');
  });

  it('calls signOffCase with the exact answers payload on submit', async () => {
    renderPopup();
    // Click Yes on every question.
    screen.getAllByRole('button', { name: 'Yes' }).forEach((b) => fireEvent.click(b));
    fireEvent.click(screen.getByRole('button', { name: /Submit sign-off/i }));

    await waitFor(() => {
      expect(signOffCaseMock).toHaveBeenCalledWith('CASE-1', {
        answers: {
          records_reviewed: true,
          diagnosis_documented: true,
          nexus_supported: true,
          no_phi_in_letter: true,
          final_pdf_correct: true,
        },
      });
    });
  });

  it('includes notes in the payload when provided', async () => {
    renderPopup();
    screen.getAllByRole('button', { name: 'Yes' }).forEach((b) => fireEvent.click(b));
    fireEvent.change(screen.getByPlaceholderText('Optional physician sign-off note.'), {
      target: { value: 'Final review complete.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Submit sign-off/i }));

    await waitFor(() => {
      expect(signOffCaseMock).toHaveBeenCalledWith('CASE-1', expect.objectContaining({
        notes: 'Final review complete.',
      }));
    });
  });

  it('invalidates both case and sign-offs queries on success', async () => {
    const { queryClient } = renderPopup();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    screen.getAllByRole('button', { name: 'Yes' }).forEach((b) => fireEvent.click(b));
    fireEvent.click(screen.getByRole('button', { name: /Submit sign-off/i }));

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({ queryKey: ['case', 'CASE-1'] });
      expect(spy).toHaveBeenCalledWith({ queryKey: ['case', 'CASE-1', 'sign-offs'] });
    });
  });
});
