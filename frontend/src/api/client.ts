import axios, { AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import { fetchAuthSession, signOut } from 'aws-amplify/auth';
import { env } from '../env';

export class ForbiddenError extends Error { constructor(message = 'Forbidden') { super(message); this.name = 'ForbiddenError'; } }
// 409. `current` carries the server envelope's error.details (optimistic-lock payloads, gate
// reasons). serverMessage/serverCode carry the envelope's REAL message + code — the sign-off
// incident 2026-06-09: the approve 409's precise signer-name-gate message was thrown away here,
// so every catch downstream could only guess. describeApiError prefers serverMessage when present.
export class ConflictError<T = unknown> extends Error {
  readonly serverMessage: string | undefined;
  readonly serverCode: string | undefined;
  constructor(readonly current?: T, serverMessage?: string, serverCode?: string) {
    const real = typeof serverMessage === 'string' && serverMessage.trim().length > 0 ? serverMessage : undefined;
    super(real ?? 'Optimistic locking conflict');
    this.name = 'ConflictError';
    this.serverMessage = real;
    this.serverCode = serverCode;
  }
}
// 503 from the API (e.g. the letter editor's render/surgical-AI when the render Lambda or
// Anthropic key isn't configured in this environment). Lets the UI show a calm "not available
// in this environment" instead of a generic failure.
export class ServiceUnavailableError extends Error { readonly status = 503; constructor(readonly details?: unknown) { super('Service unavailable'); this.name = 'ServiceUnavailableError'; } }
// 422 from the surgical-AI PROPOSE path: the LLM ran (its cost was metered) but its proposed edit
// does not apply to the current draft. Distinct from a 409/conflict because the physician WAS
// charged — the UI must say so ("the AI ran but its edit didn't fit; try rephrasing") rather than
// show a generic failure. details carries { reason: 'edit_unappliable', costUsd, proposal }.
export class SurgicalEditUnappliableError extends Error {
  readonly status = 422;
  readonly costUsd: number | undefined;
  constructor(readonly details?: { reason?: string; costUsd?: number; proposal?: unknown }) {
    super('Proposed AI edit does not apply');
    this.name = 'SurgicalEditUnappliableError';
    this.costUsd = typeof details?.costUsd === 'number' ? details.costUsd : undefined;
  }
}

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
  // DEV/DEMO ONLY: send the locally minted bypass token, skip Amplify entirely.
  if (env.demoMode && env.devBypassToken) {
    config.headers.Authorization = `Bearer ${env.devBypassToken}`;
    return config;
  }
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

apiClient.interceptors.response.use((response) => response, async (error: AxiosError<{ error?: { code?: string; message?: string; details?: unknown } }>) => {
  // Phase 8.1 G3: detect expired S3-signed URLs BEFORE the generic 403 -> ForbiddenError
  // path so the DownloadButton can show "click Download again" instead of "Forbidden."
  if (isLikelyExpiredPresignedUrlError(error)) throw new PresignedUrlExpiredError(error);
  // DEV/DEMO ONLY: a 401 in demo mode must not trigger the Amplify sign-out + redirect loop.
  if (error.response?.status === 401 && !env.demoMode) { await signOut(); window.location.assign('/'); }
  if (error.response?.status === 403) throw new ForbiddenError();
  if (error.response?.status === 409) throw new ConflictError(error.response.data?.error?.details, error.response.data?.error?.message, error.response.data?.error?.code);
  if (error.response?.status === 422) throw new SurgicalEditUnappliableError(error.response.data?.error?.details as { reason?: string; costUsd?: number; proposal?: unknown } | undefined);
  if (error.response?.status === 503) throw new ServiceUnavailableError(error.response.data?.error?.details);
  throw error;
});

// Human-readable description of a caught API error for surfacing to the operator. The recurring
// FRN failure mode (Ryan: "every catch must surface the real reason") is an opaque "could not do
// X" alert that hides the server's own reason, forcing hours of log forensics — and HttpErrors
// aren't logged server-side, so the alert is often the ONLY place the reason ever appears. This
// pulls the HTTP status + the server's error.message (or the axios network message) so the
// operator — and the next debugging session — see WHY, not just THAT.
export function describeApiError(error: unknown): string {
  if (error instanceof ForbiddenError) return 'not permitted for your role (403)';
  if (error instanceof ServiceUnavailableError) return 'not available in this environment (503)';
  // 409: surface the server's own gate message when it sent one (the approve gates' messages are
  // precise + actionable); the canned guess survives ONLY when no server message exists.
  if (error instanceof ConflictError) {
    return error.serverMessage !== undefined
      ? `server returned 409: ${error.serverMessage}`
      : 'the case changed or a job is already running (409)';
  }
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const serverMsg = (error.response?.data as { error?: { message?: string } } | undefined)?.error?.message;
    if (status === undefined) return `could not reach the server (${error.message || 'network error'})`;
    return serverMsg ? `server returned ${status}: ${serverMsg}` : `server returned ${status}`;
  }
  if (error instanceof Error && error.message) return error.message;
  return 'unknown error';
}

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
