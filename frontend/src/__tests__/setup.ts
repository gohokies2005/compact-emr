import * as matchers from '@testing-library/jest-dom/matchers';
import { expect, vi } from 'vitest';

expect.extend(matchers);

// Stub VITE_ env vars so the Zod env validator passes in tests.
// Set BEFORE any module under test imports env.ts.
import.meta.env.VITE_AWS_REGION ??= 'us-east-1';
import.meta.env.VITE_COGNITO_USER_POOL_ID ??= 'us-east-1_TEST';
import.meta.env.VITE_COGNITO_CLIENT_ID ??= 'test-client-id';
import.meta.env.VITE_API_BASE_URL ??= 'https://test.invalid';
import.meta.env.VITE_USE_MOCK_API ??= 'true';

Object.defineProperty(window, 'matchMedia', { value: vi.fn().mockImplementation((query: string) => ({ matches: false, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })) });
