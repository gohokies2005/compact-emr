import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

  it('submits the selected canonical claimed condition as a single-element cluster', async () => {
    const onSubmit = vi.fn(async () => {});
    render(wrap(<NewClaimModal open onClose={() => {}} onSubmit={onSubmit} saving={false} />));
    // The catalog loads async; the page has two condition pickers (claimed + upstream), so scope to
    // the claimed-conditions multi-select.
    const claimed = await screen.findByLabelText('Claimed condition(s)');
    await within(claimed).findByRole('option', { name: 'Obstructive sleep apnea' });
    fireEvent.change(claimed, { target: { value: 'Obstructive sleep apnea' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create claim' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.stringMatching(/^CLM-[0-9A-Z]{10}$/),
      claimedCondition: 'Obstructive sleep apnea',
      claimedConditions: ['Obstructive sleep apnea'],
      claimType: 'initial',
    })));
  });

  it('keeps claimedCondition (primary) = the first pick in the cluster', async () => {
    const onSubmit = vi.fn(async () => {});
    render(wrap(<NewClaimModal open onClose={() => {}} onSubmit={onSubmit} saving={false} />));
    const claimed = await screen.findByLabelText('Claimed condition(s)');
    await within(claimed).findByRole('option', { name: 'Obstructive sleep apnea' });
    fireEvent.change(claimed, { target: { value: 'Obstructive sleep apnea' } });
    // The chip for the first pick appears (removable chip carries an accessible Remove label).
    expect(await screen.findByLabelText('Remove Obstructive sleep apnea')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create claim' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      claimedCondition: 'Obstructive sleep apnea',
      claimedConditions: ['Obstructive sleep apnea'],
    })));
  });

  it('supports free-text via the "Other (type manually)" escape hatch (single condition)', async () => {
    const onSubmit = vi.fn(async () => {});
    render(wrap(<NewClaimModal open onClose={() => {}} onSubmit={onSubmit} saving={false} />));
    const claimed = await screen.findByLabelText('Claimed condition(s)');
    await within(claimed).findByRole('option', { name: 'Other (type manually)…' });
    fireEvent.change(claimed, { target: { value: '__other__' } });
    fireEvent.change(await screen.findByLabelText('Claimed condition(s) (manual entry)'), { target: { value: 'Rare unlisted condition' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create claim' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      claimedCondition: 'Rare unlisted condition',
      claimedConditions: ['Rare unlisted condition'],
    })));
  });
});
