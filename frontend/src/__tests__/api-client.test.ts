import { describe, expect, test, vi } from 'vitest';

vi.mock('../env', () => ({ env: { apiBaseUrl: 'https://api.example.test', useMockApi: false } }));
vi.mock('aws-amplify/auth', () => ({ fetchAuthSession: vi.fn().mockResolvedValue({ tokens: { idToken: { toString: () => 'test-jwt' } } }), signOut: vi.fn() }));

describe('api client', () => {
  test('attaches Authorization header from Cognito ID token', async () => {
    const { apiClient } = await import('../api/client');
    const adapter = vi.fn().mockResolvedValue({ data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config: {} });
    apiClient.defaults.adapter = adapter;
    await apiClient.get('/api/v1/example');
    const config = adapter.mock.calls[0]?.[0] as { headers?: { Authorization?: string } } | undefined;
    expect(config?.headers?.Authorization).toBe('Bearer test-jwt');
  });
});
