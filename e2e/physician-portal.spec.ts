import { test, expect } from '@playwright/test';
import { login } from './helpers/login';

/**
 * P2 physician portal — tab order, queue landing, banner rotation placement (build plan Chunk A).
 *
 * The shared login helper authenticates the STAFF e2e user (it waits on the "Veterans" nav link,
 * which physicians never see). The physician-only assertions are therefore skipped until a
 * physician e2e credential exists (mirror of the seeded-case skip pattern in
 * rn-viability-panel.spec.ts). The banner-on-Inbox assertion runs today — Inbox is shared and the
 * staff user sees the same [data-bridge] band.
 */

const PHYSICIAN_SKIP = 'TODO(P2 e2e): needs a physician e2e Cognito user — helpers/login.ts only drives the staff user.';

test.describe('physician portal chrome', () => {
  test('Inbox carries the bridge banner (shared page, staff-visible proof)', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page);
    await page.goto('/inbox', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-bridge]')).toBeVisible({ timeout: 30_000 });
  });

  test('physician login lands on /p/queue', async ({ page }) => {
    test.skip(true, PHYSICIAN_SKIP);
    await login(page); // would need loginAsPhysician
    await expect(page).toHaveURL(/\/p\/queue$/);
  });

  test('physician nav: Letters in Queue | Completed Letters left, Inbox right-aligned by the identity cluster', async ({ page }) => {
    test.skip(true, PHYSICIAN_SKIP);
    await login(page);
    // P4 renames + split: the left <nav> carries only the two letter tabs; Inbox renders in the
    // right cluster next to the identity block (outside the <nav> landmark).
    const nav = page.getByRole('navigation');
    const labels = await nav.getByRole('link').allTextContents();
    expect(labels).toEqual(['Letters in Queue', 'Completed Letters']);
    await expect(page.getByRole('link', { name: 'Inbox' })).toBeVisible();
    expect(await nav.getByRole('link', { name: 'Inbox' }).count()).toBe(0);
  });

  test('banner present on Queue + Letters, absent inside a review view', async ({ page }) => {
    test.skip(true, PHYSICIAN_SKIP);
    await login(page);
    for (const path of ['/p/queue', '/p/letters']) {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('[data-bridge]')).toBeVisible();
    }
    // Any claim/letter view must NOT mount the banner (Ryan: banner disappears inside a claim).
    await page.goto('/p/queue', { waitUntil: 'domcontentloaded' });
    const firstCase = page.getByRole('link', { name: /open|review/i }).first();
    if (await firstCase.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await firstCase.click();
      await expect(page.locator('[data-bridge]')).toHaveCount(0);
    }
  });
});
