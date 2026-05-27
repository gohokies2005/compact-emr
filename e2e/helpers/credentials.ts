/**
 * E2E credentials. Pulled from env for CI; falls back to the dedicated
 * Cognito e2e test user for local runs. This user is admin-role with
 * REQUIRED software-token MFA (TOTP) already enrolled.
 */
export const E2E_USERNAME = process.env.E2E_USERNAME ?? 'e2e-test@flatratenexus.com';
export const E2E_PASSWORD = process.env.E2E_PASSWORD ?? 'E2eTest!2026nexus';
export const E2E_TOTP_SECRET =
  process.env.E2E_TOTP_SECRET ?? 'R7EBLII5LVY2SYYLWWC4U5DQWOFRPZLQJJRQNWT7EKYLUYRBNE2A';
