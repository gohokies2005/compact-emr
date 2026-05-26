import { useState } from 'react';
import { Button } from './ui/Button';
import { isPresignedUrlExpiredError } from '../api/client';

interface DownloadButtonProps {
  readonly label?: string;
  readonly retryLabel?: string;
  readonly getUrl: () => Promise<string>;
  readonly filename?: string;
}

export function DownloadButton({
  label = 'Download',
  retryLabel = 'Retry',
  getUrl,
  filename,
}: DownloadButtonProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [expired, setExpired] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleDownload() {
    setIsLoading(true);
    setExpired(false);
    setErrorMessage(null);

    try {
      const url = await getUrl();
      const anchor = document.createElement('a');
      anchor.href = url;
      if (filename) anchor.download = filename;
      anchor.rel = 'noopener noreferrer';
      anchor.target = '_blank';
      anchor.click();
    } catch (error: unknown) {
      if (isPresignedUrlExpiredError(error)) {
        setExpired(true);
        setErrorMessage('Download link expired - click Download again.');
      } else {
        setErrorMessage('Download failed. Please retry.');
      }
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button type="button" variant="secondary" loading={isLoading} disabled={isLoading} onClick={handleDownload}>
        {expired ? retryLabel : label}
      </Button>

      {errorMessage ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          {errorMessage}
        </div>
      ) : null}
    </div>
  );
}
