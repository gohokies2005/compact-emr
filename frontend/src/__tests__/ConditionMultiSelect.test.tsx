import type { ReactNode } from 'react';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConditionMultiSelect } from '../components/ConditionMultiSelect';

vi.mock('../api/lookup', () => ({
  getConditions: vi.fn(async () => ({
    groups: [
      { system: 'Musculoskeletal', conditions: [{ value: 'Hip', label: 'Hip' }, { value: 'Lumbar / back', label: 'Lumbar / back' }] },
      { system: 'Respiratory / Sleep', conditions: [{ value: 'Obstructive sleep apnea', label: 'Obstructive sleep apnea' }] },
    ],
  })),
}));

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

// A tiny controlled host so onChange round-trips into the component's value prop.
function Host() {
  const [value, setValue] = useState<string[]>([]);
  return <ConditionMultiSelect label="Claimed conditions" value={value} onChange={setValue} />;
}

describe('ConditionMultiSelect', () => {
  it('shows the single-body-system helper note', async () => {
    render(wrap(<Host />));
    await screen.findByRole('option', { name: 'Hip' });
    expect(screen.getByText(/single body system/i)).toBeInTheDocument();
  });

  it('renders selected conditions as removable chips and supports removal', async () => {
    render(wrap(<Host />));
    await screen.findByRole('option', { name: 'Hip' });
    fireEvent.change(screen.getByLabelText('Claimed conditions'), { target: { value: 'Hip' } });
    // Chip appears (the selected list region).
    expect(await screen.findByLabelText('Remove Hip')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Remove Hip'));
    expect(screen.queryByLabelText('Remove Hip')).not.toBeInTheDocument();
  });

  it('locks selection to the first-picked system (other systems disabled)', async () => {
    render(wrap(<Host />));
    await screen.findByRole('option', { name: 'Hip' });
    fireEvent.change(screen.getByLabelText('Claimed conditions'), { target: { value: 'Hip' } });
    // Same-system option stays enabled; cross-system option is disabled.
    const lumbar = await screen.findByRole('option', { name: 'Lumbar / back' });
    const osa = screen.getByRole('option', { name: 'Obstructive sleep apnea' });
    expect((lumbar as HTMLOptionElement).disabled).toBe(false);
    expect((osa as HTMLOptionElement).disabled).toBe(true);
  });

  it('switches to single free-text when "Other" is chosen and clears the canonical list', async () => {
    render(wrap(<Host />));
    await screen.findByRole('option', { name: 'Hip' });
    fireEvent.change(screen.getByLabelText('Claimed conditions'), { target: { value: 'Hip' } });
    expect(await screen.findByLabelText('Remove Hip')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Claimed conditions'), { target: { value: '__other__' } });
    // Manual input appears; chip cleared.
    expect(await screen.findByLabelText('Claimed conditions (manual entry)')).toBeInTheDocument();
    expect(screen.queryByLabelText('Remove Hip')).not.toBeInTheDocument();
  });
});
