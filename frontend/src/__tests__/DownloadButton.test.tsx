import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadButton } from '../components/DownloadButton';
import { PresignedUrlExpiredError } from '../api/client';

describe('DownloadButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a friendly expired-link message and retry button', async () => {
    const getUrl = vi.fn().mockRejectedValueOnce(new PresignedUrlExpiredError());

    render(<DownloadButton getUrl={getUrl} />);

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));

    expect(await screen.findByText('Download link expired - click Download again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('opens the returned URL in a new anchor click', async () => {
    const click = vi.fn();
    const anchor = {
      href: '',
      download: '',
      rel: '',
      target: '',
      click,
    };

    // Render BEFORE installing the spy so React's createElement calls aren't intercepted —
    // jsdom needs real DOM nodes during render. We only want to intercept the runtime
    // `document.createElement('a')` inside the click handler.
    const getUrl = vi.fn().mockResolvedValueOnce('https://example.com/file.pdf');
    render(<DownloadButton getUrl={getUrl} filename="file.pdf" />);

    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi
      .spyOn(document, 'createElement')
      .mockImplementation((tagName: string, options?: ElementCreationOptions) => {
        if (tagName === 'a') return anchor as unknown as HTMLAnchorElement;
        return originalCreateElement(tagName, options);
      });

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));

    await waitFor(() => {
      expect(click).toHaveBeenCalled();
    });

    expect(anchor.href).toBe('https://example.com/file.pdf');
    expect(anchor.download).toBe('file.pdf');

    createElementSpy.mockRestore();
  });
});
