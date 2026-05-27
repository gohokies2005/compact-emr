import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E config for the Compact-EMR frontend.
 *
 * Targets the LIVE deployed site (real backend) by default. Override the target
 * with E2E_BASE_URL. Credentials come from env (E2E_USERNAME / E2E_PASSWORD /
 * E2E_TOTP_SECRET) with local-dev fallbacks to the dedicated e2e test user.
 */
export default defineConfig({
  testDir: './e2e',
  // Each spec creates uniquely-named staging data, so serial is not required,
  // but the suite is small and we keep things deterministic with one worker on CI.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 1,
  workers: process.env.CI ? 1 : undefined,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'https://emr.flatratenexus.com',
    // Generous nav timeout — live site behind CloudFront + Cognito + cold-start Lambda.
    navigationTimeout: 45_000,
    actionTimeout: 20_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
