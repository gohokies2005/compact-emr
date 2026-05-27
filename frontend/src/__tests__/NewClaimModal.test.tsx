import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NewClaimModal } from '../routes/cases/NewClaimModal';

describe('NewClaimModal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<NewClaimModal open={false} onClose={() => {}} onSubmit={async () => {}} saving={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('submits the entered claim fields (omitting empty optionals)', async () => {
    const onSubmit = vi.fn(async () => {});
    render(<NewClaimModal open onClose={() => {}} onSubmit={onSubmit} saving={false} />);
    fireEvent.change(screen.getByLabelText('Claimed condition'), { target: { value: 'Obstructive sleep apnea' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create claim' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ id: expect.stringMatching(/^CLM-[0-9A-Z]{10}$/), claimedCondition: 'Obstructive sleep apnea', claimType: 'initial' })));
  });
});
