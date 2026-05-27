import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NewClaimModal } from '../routes/cases/NewClaimModal';

vi.mock('../api/lookup', () => ({
  getConditions: vi.fn(async () => ({
    groups: [
      { system: 'Respiratory / Sleep', conditions: [{ value: 'Obstructive sleep apnea', label: 'Obstructive sleep apnea' }] },
      { system: 'Mental health', conditions: [{ value: 'PTSD', label: 'PTSD' }] },
    ],
  })),
}));

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

describe('NewClaimModal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(wrap(<NewClaimModal open={false} onClose={() => {}} onSubmit={async () => {}} saving={false} />));
    expect(container.firstChild).toBeNull();
  });

  it('submits the selected canonical claimed condition (omitting empty optionals)', async () => {
    const onSubmit = vi.fn(async () => {});
    render(wrap(<NewClaimModal open onClose={() => {}} onSubmit={onSubmit} saving={false} />));
    // The catalog loads async; wait for the canonical option to appear, then select it.
    await screen.findByRole('option', { name: 'Obstructive sleep apnea' });
    fireEvent.change(screen.getByLabelText('Claimed condition'), { target: { value: 'Obstructive sleep apnea' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create claim' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ id: expect.stringMatching(/^CLM-[0-9A-Z]{10}$/), claimedCondition: 'Obstructive sleep apnea', claimType: 'initial' })));
  });

  it('supports free-text via the "Other (type manually)" escape hatch', async () => {
    const onSubmit = vi.fn(async () => {});
    render(wrap(<NewClaimModal open onClose={() => {}} onSubmit={onSubmit} saving={false} />));
    await screen.findByRole('option', { name: 'Other (type manually)…' });
    fireEvent.change(screen.getByLabelText('Claimed condition'), { target: { value: '__other__' } });
    fireEvent.change(await screen.findByLabelText('Claimed condition (manual entry)'), { target: { value: 'Rare unlisted condition' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create claim' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ claimedCondition: 'Rare unlisted condition' })));
  });
});
