import axios, { AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import { fetchAuthSession, signOut } from 'aws-amplify/auth';
import { env } from '../env';

export class ForbiddenError extends Error { constructor(message = 'Forbidden') { super(message); this.name = 'ForbiddenError'; } }
export class ConflictError<T = unknown> extends Error { constructor(readonly current?: T) { super('Optimistic locking conflict'); this.name = 'ConflictError'; } }

export const apiClient: AxiosInstance = axios.create({ baseURL: env.apiBaseUrl, timeout: 30000 });

apiClient.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

apiClient.interceptors.response.use((response) => response, async (error: AxiosError<{ error?: { code?: string; message?: string; details?: unknown } }>) => {
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
export async function apiDelete(path: string): Promise<void> { await apiClient.delete(path); }
