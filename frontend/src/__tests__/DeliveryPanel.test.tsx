import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeliveryPanel } from '../components/DeliveryPanel';
import { getDelivery, openMemoPdf, sendDelivery, type DeliveryPreview, type DeliverySendResult } from '../api/delivery';

vi.mock('../api/delivery', async () => {
  const actual = await vi.importActual<typeof import('../api/delivery')>('../api/delivery');
  return { ...actual, getDelivery: vi.fn(), sendDelivery: vi.fn(), openMemoPdf: vi.fn() };
});

const getDeliveryMock = vi.mocked(getDelivery);
const sendDeliveryMock = vi.mocked(sendDelivery);
const openMemoPdfMock = vi.mocked(openMemoPdf);

function preview(overrides: Partial<DeliveryPreview> = {}): { data: DeliveryPreview } {
  return {
    data: {
      version: 1,
      excerpt: { opinion: 'op', references: ['1. Ref'], block: 'Opinion block' },
      email: { subject: 'Your nexus letter is ready, invoice enclosed', fromAddress: 'info@flatratenexus.com', body: 'Hi Jane,\n\nemail body' },
      memo: { applies: true, pathway: 'supplemental', reason: 'administrative_pathway', text: 'PHYSICIAN COVER MEMORANDUM' },
      stripe: { configured: true, link: 'https://buy.stripe.com/x?client_reference_id=CASE_C1' },
      emailTransport: { configured: true },
      savedEmail: null,
      savedPayment: null,
      status: 'delivered',
      ...overrides,
    } as DeliveryPreview,
  };
}

function sendResult(overrides: Partial<DeliverySendResult> = {}): { data: DeliverySendResult } {
  const base: DeliverySendResult = {
    emailId: 'EMAIL-1',
    paymentId: 'PAY-1',
    status: 'delivered',
    emailTransportConfigured: true,
    stripeConfigured: true,
    emailSent: true,
    emailStatus: 'sent',
    messageId: 'ses-1',
    message: 'Sent to jane@example.com.',
  };
  return { data: { ...base, ...overrides } as DeliverySendResult };
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DeliveryPanel caseId="CASE-1" onVerifyLetter={() => undefined} hasLetterPdf={true} />
    </QueryClientProvider>,
  );
}

describe('DeliveryPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDeliveryMock.mockResolvedValue(preview());
    sendDeliveryMock.mockResolvedValue(sendResult());
    openMemoPdfMock.mockResolvedValue(undefined);
  });

  it('"Verify the cover memo" opens the memo PDF (no raw <pre> text dump)', async () => {
    renderPanel();
    const btn = await screen.findByRole('button', { name: 'Verify the cover memo' });
    fireEvent.click(btn);
    await waitFor(() => { expect(openMemoPdfMock).toHaveBeenCalledWith('CASE-1'); });
    // The old raw-text rendering is gone.
    expect(document.querySelector('pre')).toBeNull();
  });

  it('surfaces the REAL error when the memo PDF cannot be opened', async () => {
    openMemoPdfMock.mockRejectedValue(new Error('server returned 404: No cover memo applies to this case'));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Verify the cover memo' }));
    await screen.findByText(/Could not open the cover memo PDF: server returned 404: No cover memo applies/);
  });

  it('sends the (editable) email after both confirms and shows the send result', async () => {
    renderPanel();
    await screen.findByRole('button', { name: 'Verify the cover memo' });
    fireEvent.click(screen.getByLabelText(/I verified the final letter is correct/));
    fireEvent.click(screen.getByLabelText(/I verified the cover memo is correct/));
    const sendBtn = screen.getByRole('button', { name: 'Send the invoice email' });
    expect(sendBtn).not.toBeDisabled();
    fireEvent.click(sendBtn);
    await waitFor(() => { expect(sendDeliveryMock).toHaveBeenCalledWith('CASE-1', { emailBody: 'Hi Jane,\n\nemail body' }); });
    await screen.findByText('Sent to jane@example.com.');
  });

  it('a 200 response with emailSent:false (transport failure) shows the real error message in red', async () => {
    sendDeliveryMock.mockResolvedValue(sendResult({
      emailSent: false,
      emailStatus: 'queued',
      error: 'Email address is not verified (SES sandbox)',
      message: 'Email send failed: Email address is not verified (SES sandbox). The email is saved (queued); it can be sent again once the issue is fixed.',
    }));
    renderPanel();
    await screen.findByRole('button', { name: 'Verify the cover memo' });
    fireEvent.click(screen.getByLabelText(/I verified the final letter is correct/));
    fireEvent.click(screen.getByLabelText(/I verified the cover memo is correct/));
    fireEvent.click(screen.getByRole('button', { name: 'Send the invoice email' }));
    const msg = await screen.findByText(/Email send failed: Email address is not verified/);
    expect(msg.className).toContain('text-rose-600');
  });

  it('no memo case: the memo verify button and confirm are absent; letter confirm alone enables send', async () => {
    getDeliveryMock.mockResolvedValue(preview({ memo: { applies: false, pathway: null, reason: 'original_claim_no_denial', text: null } }));
    renderPanel();
    await screen.findByRole('button', { name: 'Send the invoice email' });
    expect(screen.queryByRole('button', { name: 'Verify the cover memo' })).toBeNull();
    // P0d: instead of a silent absence, explain WHY no memo applies + how to fix it for appeals.
    expect(screen.getByText(/No cover memo applies/)).toBeInTheDocument();
    expect(screen.getByText(/appeal, supplemental, HLR, or TDIU/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/I verified the final letter is correct/));
    expect(screen.getByRole('button', { name: 'Send the invoice email' })).not.toBeDisabled();
  });
});
