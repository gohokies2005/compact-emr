import { z } from 'zod';

const envSchema = z.object({
  VITE_AWS_REGION: z.string().min(1),
  VITE_COGNITO_USER_POOL_ID: z.string().min(1),
  VITE_COGNITO_CLIENT_ID: z.string().min(1),
  VITE_API_BASE_URL: z.string().url(),
  VITE_USE_MOCK_API: z.enum(['true', 'false']).default('false'),
  // DEV/DEMO ONLY (default off). When VITE_DEMO_MODE=true the app skips Amplify/Cognito and
  // signs in as a fixed physician, and the API client sends VITE_DEV_BYPASS_TOKEN (a locally
  // minted HS256 JWT the backend accepts via AUTH_TEST_JWT_SECRET). Never set in production.
  VITE_DEMO_MODE: z.enum(['true', 'false']).default('false'),
  VITE_DEV_BYPASS_TOKEN: z.string().optional()
});

const parsed = envSchema.safeParse(import.meta.env);
if (!parsed.success) {
  throw new Error(`Compact EMR frontend env is invalid: ${parsed.error.message}`);
}

export const env = {
  awsRegion: parsed.data.VITE_AWS_REGION,
  cognitoUserPoolId: parsed.data.VITE_COGNITO_USER_POOL_ID,
  cognitoClientId: parsed.data.VITE_COGNITO_CLIENT_ID,
  apiBaseUrl: parsed.data.VITE_API_BASE_URL,
  useMockApi: parsed.data.VITE_USE_MOCK_API === 'true',
  // Demo mode must never activate under tests (vitest loads .env.local, which may carry
  // VITE_DEMO_MODE=true for local dev) — gate it off when MODE === 'test'.
  demoMode: parsed.data.VITE_DEMO_MODE === 'true' && import.meta.env.MODE !== 'test',
  devBypassToken: parsed.data.VITE_DEV_BYPASS_TOKEN
} as const;
