import axios, { AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import { fetchAuthSession, signOut } from 'aws-amplify/auth';
import { env } from '../env';
import { mockRequest } from './mockApi';

export class ForbiddenError extends Error { constructor(message = 'Forbidden') { super(message); this.name = 'ForbiddenError'; } }

export const apiClient: AxiosInstance = axios.create({ baseURL: env.apiBaseUrl, timeout: 30000 });

apiClient.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

apiClient.interceptors.response.use((response) => response, async (error: AxiosError) => {
  if (error.response?.status === 401) { await signOut(); window.location.assign('/'); }
  if (error.response?.status === 403) throw new ForbiddenError();
  throw error;
});

export async function apiGet<T>(path: string): Promise<T> {
  if (env.useMockApi) return mockRequest<T>(path);
  const response = await apiClient.get<T>(path);
  return response.data;
}
