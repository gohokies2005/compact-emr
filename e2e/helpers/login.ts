import { authenticator } from 'otplib';
import { expect, type Page } from '@playwright/test';
import { E2E_USERNAME, E2E_PASSWORD, E2E_TOTP_SECRET } from './credentials';

/**
 * Drives the Compact-EMR Cognito sign-in flow against the live site.
 *
 * Flow (see frontend/src/auth/SignInScreen.tsx + AuthProvider.tsx):
 *   1. Password step: "Email" + "Password" fields, "Sign in" button.
 *   2. software_token_mfa step: single "6-digit code" field, "Verify" button.
 *      The TOTP is computed from the shared secret with otplib
 *      (authenticator.generate == Cognito SHA-1 / 6-digit / 30s).
 *   3. On success the SPA replaces the SignInScreen with the authenticated app
 *      shell (TopNav showing "Compact EMR" + nav links).
 *
 * Selectors use getByLabel / getByRole, not brittle CSS — the SignInScreen
 * Field component renders the label text inside a <label> wrapping the input.
 */
export async function login(page: Page): Promise<void> {
  await page.goto('/');

  // The app may briefly show a loading state, then redirect to /signin (or render
  // the SignInScreen inline). Wait for the password field to be ready.
  const emailField = page.getByLabel('Email', { exact: true });
  const passwordField = page.getByLabel('Password', { exact: true });

  await expect(emailField).toBeVisible({ timeout: 30_000 });
  await emailField.fill(E2E_USERNAME);
  await passwordField.fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  // MFA step: software_token_mfa renders a single "6-digit code" field + "Verify".
  const codeField = page.getByLabel('6-digit code', { exact: true });
  await expect(codeField).toBeVisible({ timeout: 30_000 });

  // Generate the TOTP at the moment we're about to submit so it is fresh.
  const code = authenticator.generate(E2E_TOTP_SECRET);
  await codeField.fill(code);
  await page.getByRole('button', { name: 'Verify', exact: true }).click();

  // Wait for the authenticated app shell. The TopNav renders "Veterans" nav link
  // for admin/ops_staff; the sign-in screen never shows it. Surface any sign-in
  // error (role="alert") with a clear message if auth failed.
  const alert = page.getByRole('alert');
  const veteransNav = page.getByRole('link', { name: 'Veterans', exact: true });

  await Promise.race([
    veteransNav.waitFor({ state: 'visible', timeout: 45_000 }),
    alert.waitFor({ state: 'visible', timeout: 45_000 }).then(async () => {
      const text = (await alert.textContent())?.trim() ?? '(no text)';
      throw new Error(`Sign-in failed at MFA/login step. Cognito error: "${text}"`);
    }),
  ]);

  await expect(veteransNav).toBeVisible();
}
