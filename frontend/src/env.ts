import { z } from 'zod';

const envSchema = z.object({
  VITE_AWS_REGION: z.string().min(1),
  VITE_COGNITO_USER_POOL_ID: z.string().min(1),
  VITE_COGNITO_CLIENT_ID: z.string().min(1),
  VITE_API_BASE_URL: z.string().url(),
  VITE_USE_MOCK_API: z.enum(['true', 'false']).default('true')
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
  useMockApi: parsed.data.VITE_USE_MOCK_API === 'true'
} as const;
