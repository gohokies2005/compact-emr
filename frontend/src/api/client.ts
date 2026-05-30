import axios, { AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import { fetchAuthSession, signOut } from 'aws-amplify/auth';
import { env } from '../env';

export class ForbiddenError extends Error { constructor(message = 'Forbidden') { super(message); this.name = 'ForbiddenError'; } }
export class ConflictError<T = unknown> extends Error { constructor(readonly current?: T) { super('Optimistic locking conflict'); this.name = 'ConflictError'; } }

// Phase 8.1 G3: when an S3-signed URL has expired (5-min TTL on Doctor Pack / drafter
// artifact downloads), axios sees a 403 from AWS with a specific XML body. The generic
// 403 -> ForbiddenError branch hides that the right RN action is "click Download again"
// (a fresh URL is one click away — no Ryan intervention needed). This typed error +
// detector lets the DownloadButton (and any future axios consumer) show the recoverable
// message instead.
export class PresignedUrlExpiredError extends Error {
  readonly isPresignedUrlExpired = true;
  constructor(readonly cause?: unknown) {
    super('Download link expired');
    this.name = 'PresignedUrlExpiredError';
  }
}

export function isPresignedUrlExpiredError(error: unknown): error is PresignedUrlExpiredError {
  return error instanceof PresignedUrlExpiredError;
}

function isLikelyExpiredPresignedUrlError(error: unknown): boolean {
  if (!axios.isAxiosError(error) || error.response?.status !== 403) return false;
  const rawUrl = error.config?.url;
  if (!rawUrl) return false;
  let url: URL;
  try {
    url = new URL(rawUrl, window.location.origin);
  } catch {
    return false;
  }
  const isAmazonHost = /\.amazonaws\.com$/i.test(url.hostname);
  const hasSignature = url.search.includes('X-Amz-Signature=');
  const hasDate = url.search.includes('X-Amz-Date=');
  if (!isAmazonHost || !hasSignature || !hasDate) return false;
  const responseData = error.response.data;
  if (typeof responseData !== 'string') return true;
  return (
    responseData.includes('<Code>AccessDenied</Code>') ||
    responseData.includes('<Code>Request has expired</Code>')
  );
}

export const apiClient: AxiosInstance = axios.create({ baseURL: env.apiBaseUrl, timeout: 30000 });

apiClient.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

apiClient.interceptors.response.use((response) => response, async (error: AxiosError<{ error?: { code?: string; message?: string; details?: unknown } }>) => {
  // Phase 8.1 G3: detect expired S3-signed URLs BEFORE the generic 403 -> ForbiddenError
  // path so the DownloadButton can show "click Download again" instead of "Forbidden."
  if (isLikelyExpiredPresignedUrlError(error)) throw new PresignedUrlExpiredError(error);
  if (error.response?.status === 401) { await signOut(); window.location.assign('/'); }
  if (error.response?.status === 403) throw new ForbiddenError();
  if (error.response?.status === 409) throw new ConflictError(error.response.data?.error?.details);
  throw error;
});

export async function apiGet<T>(path: string): Promise<T> {
  const response = await apiClient.get<T>(path);
  return response.data;
}
export async function apiPost<TResponse, TBody = unknown>(path: string, body: TBody): Promise<TResponse> {
  const response = await apiClient.post<TResponse>(path, body);
  return response.data;
}
export async function apiPatch<TResponse, TBody = unknown>(path: string, body: TBody): Promise<TResponse> {
  const response = await apiClient.patch<TResponse>(path, body);
  return response.data;
}
export async function apiPut<TResponse, TBody = unknown>(path: string, body: TBody): Promise<TResponse> {
  const response = await apiClient.put<TResponse>(path, body);
  return response.data;
}
export async function apiDelete(path: string): Promise<void> { await apiClient.delete(path); }
