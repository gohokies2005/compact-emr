import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailLogPanel, cleanEmailText } from '../components/EmailLogPanel';
import { getGmailThread } from '../api/emails';

// Live Gmail (read-only) section — ships DARK: until the Workspace gmail.readonly scope is
// granted the endpoint returns {available:false} and the panel shows a quiet note, never an error.
vi.mock('../api/emails', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/emails')>()),
  getGmailThread: vi.fn(),
  getEmailAttachment: vi.fn(),
}));
const getGmailThreadMock = vi.mocked(getGmailThread);

function renderPanel(scope: 'veteran' | 'claim' = 'claim') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <EmailLogPanel
        queryKey={scope === 'claim' ? ['case', 'CASE-1', 'emails'] : ['veteran', 'VET-1', 'emails']}
        fetcher={async () => ({ data: [] })}
        scope={scope}
        // Explicit caseId prop (architect post-QA) — the claim tab passes it; veteran scope omits
        // it, which is exactly what keeps the Gmail section off that surface.
        caseId={scope === 'claim' ? 'CASE-1' : undefined}
      />
    </QueryClientProvider>,
  );
}

describe('EmailLogPanel — Live Gmail section', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('shows the quiet not-connected note while the Workspace scope is ungranted', async () => {
    getGmailThreadMock.mockResolvedValue({ data: { available: false, reason: 'workspace_scope_not_granted' } });
    renderPanel('claim');
    expect(await screen.findByText('Live Gmail (read-only)')).toBeTruthy();
    expect(await screen.findByText(/one-time Google Workspace authorization is needed/)).toBeTruthy();
    expect(getGmailThreadMock).toHaveBeenCalledWith('CASE-1');
  });

  it('shows the unavailable note on gmail_unreachable', async () => {
    getGmailThreadMock.mockResolvedValue({ data: { available: false, reason: 'gmail_unreachable' } });
    renderPanel('claim');
    expect(await screen.findByText('Live Gmail is temporarily unavailable.')).toBeTruthy();
  });

  it('renders live rows (otherParty + subject + snippet) once available', async () => {
    getGmailThreadMock.mockResolvedValue({
      data: {
        available: true,
        messages: [{ id: 'm1', direction: 'inbound', otherParty: 'vet@example.com', subject: 'About my records', snippet: 'I uploaded the sleep study', date: '2026-06-10T21:03:00.000Z' }],
      },
    });
    renderPanel('claim');
    expect(await screen.findByText('About my records')).toBeTruthy();
    expect(screen.getByText(/I uploaded the sleep study/)).toBeTruthy();
    expect(screen.getByText(/vet@example\.com/)).toBeTruthy();
  });

  it('does not render the Gmail section on the veteran-scope tab (no caseId)', async () => {
    renderPanel('veteran');
    expect(await screen.findByText('No email correspondence yet')).toBeTruthy();
    expect(screen.queryByText('Live Gmail (read-only)')).toBeNull();
    expect(getGmailThreadMock).not.toHaveBeenCalled();
  });
});

describe('cleanEmailText — decode entities + strip quoted reply (Ryan 2026-06-12)', () => {
  it('decodes the HTML entities that showed up raw in the bubbles', () => {
    expect(cleanEmailText('that&#39;s something I try to do')).toBe("that's something I try to do");
    expect(cleanEmailText('Flat Rate Nexus &lt;info@flatratenexus.com&gt; wrote')).toContain('<info@flatratenexus.com>');
  });

  it('strips the quoted reply chain, keeping only the new response', () => {
    const reply = 'Awesome 👍\nOn Fri, Jun 12, 2026 at 12:18 AM, Flat Rate Nexus <info@flatratenexus.com> wrote: Hi Arturo, We did receive your records';
    expect(cleanEmailText(reply)).toBe('Awesome 👍');
  });

  it('strips a Yahoo mobile footer that precedes the quote', () => {
    expect(cleanEmailText('Awesome 👍 Yahoo Mail: Search, Organize, Conquer On Fri wrote: prior')).toBe('Awesome 👍');
  });

  it('leaves a clean single-message body untouched', () => {
    expect(cleanEmailText('I uploaded the sleep study results.')).toBe('I uploaded the sleep study results.');
  });

  it('falls back to the decoded text when stripping would empty it (pure quote)', () => {
    const pureQuote = 'On Fri, Jun 12 wrote: everything is quoted';
    expect(cleanEmailText(pureQuote).length).toBeGreaterThan(0);
  });
});

// C4c (messaging, 2026-06-14): the EXPANDED bubble uses mode 'full' — it must NOT clip legitimate
// body text (the prior bug cut mid-sentence). 'full' strips only an unambiguous quoted reply chain;
// footers/bare-quote lines are trimmed in 'preview' (collapsed snippet) only.
describe('cleanEmailText — full mode keeps the complete new message (C4c, 2026-06-14)', () => {
  it('keeps a long multi-sentence body intact in full mode', () => {
    const body =
      'Thanks for the update. I reviewed the sleep study and the AHI clearly supports the claim. ' +
      'I will draft the nexus letter today and send it for your review tomorrow morning.';
    expect(cleanEmailText(body, 'full')).toBe(body);
  });

  it('does not clip on the word "on" when there is no quote attribution', () => {
    const body = 'I worked on the records on Monday and everything looks good on our end.';
    expect(cleanEmailText(body, 'full')).toBe(body);
  });

  it('full mode keeps a mobile footer that preview mode would trim', () => {
    const body = 'Here is the document you asked for.\nSent from my iPhone';
    // 'full' leaves the footer (it is legit-text-adjacent); 'preview' trims it for brevity.
    expect(cleanEmailText(body, 'full')).toContain('Sent from my iPhone');
    expect(cleanEmailText(body, 'preview')).toBe('Here is the document you asked for.');
  });

  it('full mode still strips an unambiguous quoted reply chain', () => {
    const reply = 'My new reply with real content.\nOn Fri, Jun 12, 2026 at 12:18 AM, Someone <a@b.com> wrote: old quoted text';
    expect(cleanEmailText(reply, 'full')).toBe('My new reply with real content.');
  });
});
