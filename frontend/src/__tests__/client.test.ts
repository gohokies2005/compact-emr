import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { describe, expect, it } from 'vitest';
import { apiClient, PresignedUrlExpiredError } from '../api/client';

function makeAxiosError(url: string, status: number, data: string): AxiosError {
  return new AxiosError(
    'Request failed',
    'ERR_BAD_REQUEST',
    {
      url,
      method: 'get',
      headers: {},
    } as InternalAxiosRequestConfig,
    {},
    {
      data,
      status,
      statusText: String(status),
      headers: {},
      config: {
        url,
        method: 'get',
        headers: {},
      } as InternalAxiosRequestConfig,
    },
  );
}

// Our repo uses a named apiClient instance (not the default axios export). Test that
// instance's response interceptor directly so the wrap-expired-URL branch is exercised
// without making a real network call.
describe('api client presigned URL handling', () => {
  it('wraps expired S3 presigned URL errors', async () => {
    const expiredError = makeAxiosError(
      'https://bucket.s3.us-east-1.amazonaws.com/file.pdf?X-Amz-Signature=abc&X-Amz-Date=20260525T120000Z',
      403,
      '<Error><Code>AccessDenied</Code></Error>',
    );

    // Axios's `handlers` array is typed as a private internal — cast through the public
    // interceptors object to access it for testing without `as any`.
    const handlers = (apiClient.interceptors.response as unknown as { handlers: Array<{ rejected?: (err: unknown) => unknown }> }).handlers;
    const rejected = handlers[0]?.rejected;
    if (!rejected) throw new Error('apiClient response interceptor not installed');

    await expect(Promise.reject(expiredError).catch(rejected)).rejects.toBeInstanceOf(
      PresignedUrlExpiredError,
    );
  });

  it('does not wrap non-S3 403 errors', async () => {
    const forbiddenError = makeAxiosError(
      '/api/v1/cases/CASE-1',
      403,
      '{"error":{"code":"forbidden"}}',
    );

    const handlers = (apiClient.interceptors.response as unknown as { handlers: Array<{ rejected?: (err: unknown) => unknown }> }).handlers;
    const rejected = handlers[0]?.rejected;
    if (!rejected) throw new Error('apiClient response interceptor not installed');

    // Non-S3 403 is converted to ForbiddenError (NOT PresignedUrlExpiredError). The exact
    // class is the key signal; assert "not a presigned expiry" via the typeguard.
    await expect(Promise.reject(forbiddenError).catch(rejected)).rejects.not.toBeInstanceOf(
      PresignedUrlExpiredError,
    );
  });
});
