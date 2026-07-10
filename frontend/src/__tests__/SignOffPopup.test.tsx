import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SignOffPopup } from '../components/SignOffPopup';
import { signOffCase, type SignOff } from '../api/cases';
import { ConflictError } from '../api/client';

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
  // Ryan 2026-07-10: a tall "what changed" diff pushed the vertically-centered modal past both screen
  // edges, making the Approve/sign buttons unreachable. The modal must be viewport-capped with a
  // scrollable body + a pinned footer so the submit button is always present + reachable.
  it('is viewport-capped with a scrollable body so the sign buttons stay reachable when content is tall', () => {
    const { container } = renderPopup();
    // The modal box is height-capped to the viewport ...
    expect(container.querySelector('[class*="max-h-"]')).not.toBeNull();
    // ... has a scroll region for the body ...
    expect(container.querySelector('[class*="overflow-y-auto"]')).not.toBeNull();
    // ... and the submit button is always rendered (in the pinned footer, not scrolled away).
    expect(screen.getByRole('button', { name: /submit sign-off/i })).toBeInTheDocument();
  });

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

  // ── Chart-readiness machine-read gate override (CLM-4DACAF4A80, 2026-06-14) ──

  // A chart_not_ready 409 as the client interceptor throws it: ConflictError(details, message, code).
  function chartNotReady409(): ConflictError {
    return new ConflictError(
      { blockingFiles: [{ fileReadStatusId: 'FRS-1', filePath: 'cases/C/123e4567-e89b-42d3-a456-426614174000-Sleep_Study.pdf', terminalStatus: 'manual_summary_required', lastAttempt: { note: 'empty (0 words)' } }] },
      'Sign-off blocked: 1 uploaded file could not be automatically read…',
      'chart_not_ready',
    );
  }

  it('renders the blocking files + override control on a chart_not_ready 409 (does not dead-end)', async () => {
    signOffCaseMock.mockRejectedValueOnce(chartNotReady409());
    renderPopup();
    screen.getAllByRole('button', { name: 'Yes' }).forEach((b) => fireEvent.click(b));
    fireEvent.click(screen.getByRole('button', { name: /Submit sign-off/i }));

    // The override panel appears, naming the blocking file in plain language.
    await waitFor(() => expect(screen.getByTestId('chart-readiness-override')).toBeInTheDocument());
    expect(screen.getByText('Sleep_Study.pdf')).toBeInTheDocument();
    expect(screen.getByText(/no readable text/i)).toBeInTheDocument();
    // The override checkbox + a "Sign off anyway" button are present.
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sign off anyway/i })).toBeInTheDocument();
  });

  it('re-submits with overrideChartReadiness:true + the reason when the physician overrides', async () => {
    signOffCaseMock.mockRejectedValueOnce(chartNotReady409());
    renderPopup();
    screen.getAllByRole('button', { name: 'Yes' }).forEach((b) => fireEvent.click(b));
    fireEvent.click(screen.getByRole('button', { name: /Submit sign-off/i }));
    await waitFor(() => expect(screen.getByTestId('chart-readiness-override')).toBeInTheDocument());

    // "Sign off anyway" stays disabled until BOTH the ack checkbox + a reason are provided.
    const overrideBtn = screen.getByRole('button', { name: /Sign off anyway/i });
    expect(overrideBtn).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(overrideBtn).toBeDisabled(); // still no reason
    fireEvent.change(screen.getByPlaceholderText(/I reviewed each of these scans/i), { target: { value: 'I read the sleep study in person; it is legible.' } });
    expect(overrideBtn).not.toBeDisabled();

    signOffCaseMock.mockResolvedValueOnce({ data: sampleResponse });
    fireEvent.click(overrideBtn);

    await waitFor(() => {
      expect(signOffCaseMock).toHaveBeenLastCalledWith('CASE-1', expect.objectContaining({
        overrideChartReadiness: true,
        chartReadinessOverrideReason: 'I read the sleep study in person; it is legible.',
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
