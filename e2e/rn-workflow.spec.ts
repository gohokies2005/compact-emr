import { test, expect } from '@playwright/test';
import { login } from './helpers/login';

/**
 * Core RN workflow smoke test against the LIVE deployed site (real backend).
 *
 * login -> Veterans -> create veteran -> chart loads (name + MRN-) ->
 * add an Active Problem -> create a claim (stays on chart, claim appears) ->
 * open the case -> case-detail page loads with "Send to Drafter" panel + button.
 *
 * Creates uniquely-named real staging data (acceptable per the test brief).
 * Does NOT click Send to Drafter / does not start a drafting run.
 *
 * Selectors derived from:
 *   - routes/veterans/VeteransPage.tsx     ("+ New veteran")
 *   - routes/veterans/NewVeteranModal.tsx  ("Email *","First name *","Last name *","DOB *","Create veteran")
 *   - routes/veterans/VeteranChart.tsx     (h1 name, "MRN <id>", tabs, "+ New claim", Cases panel links)
 *   - routes/cases/NewClaimModal.tsx       ("Claimed condition","Claim type","Create claim")
 *   - routes/cases/CaseDetailPage.tsx      (h1 claimedCondition, "Case <id>", "Send to Drafter")
 */
test('RN core workflow: veteran -> problem -> claim -> case detail', async ({ page }) => {
  const stamp = Date.now();
  const firstName = 'E2E';
  const lastName = `Playwright ${stamp}`;
  const fullName = `${firstName} ${lastName}`;
  const problemText = 'Lumbar strain';
  const claimedCondition = 'Lumbar strain';

  // 1. Authenticate (Cognito password + TOTP MFA).
  await login(page);

  // 2. Go to Veterans.
  await page.getByRole('link', { name: 'Veterans', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Veterans', exact: true })).toBeVisible();

  // 3. Open the New veteran modal and fill ONLY the required fields.
  await page.getByRole('button', { name: '+ New veteran' }).click();
  await expect(page.getByRole('heading', { name: 'New veteran', exact: true })).toBeVisible();

  await page.getByLabel('First name *').fill(firstName);
  await page.getByLabel('Last name *').fill(lastName);
  await page.getByLabel('DOB *').fill('1980-01-15');
  await page.getByLabel('Email *').fill(`e2e+${stamp}@flatratenexus.com`);

  // Submit. The app auto-assigns an MRN client-side and navigates to the chart.
  await page.getByRole('button', { name: 'Create veteran' }).click();

  // 4. Chart loads: header shows the veteran name (h1) and an "MRN-" line.
  await expect(page).toHaveURL(/\/veterans\/MRN-/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: fullName, level: 1 })).toBeVisible({ timeout: 30_000 });
  // The chart sub-line renders "MRN MRN-XXXXXXXXXX · DOB ...". Assert the MRN- token.
  await expect(page.getByText(/MRN-[A-Z0-9]{6,}/)).toBeVisible();

  // 5. Add one Active Problem.
  await page.getByRole('button', { name: 'Active problems', exact: true }).click();
  const problemInput = page.getByPlaceholder('Problem');
  await expect(problemInput).toBeVisible();
  await problemInput.fill(problemText);
  // The Add button next to the Problem input (scoped to avoid other tabs' Add buttons).
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  // The new problem row appears in the Active problems list.
  await expect(page.getByText(problemText, { exact: true })).toBeVisible({ timeout: 15_000 });

  // 6. Create a claim. Default claim type (Initial) — fill only Claimed condition.
  await page.getByRole('button', { name: '+ New claim' }).click();
  await expect(page.getByRole('heading', { name: 'New claim', exact: true })).toBeVisible();
  await page.getByLabel('Claimed condition').fill(claimedCondition);
  await page.getByRole('button', { name: 'Create claim' }).click();

  // 7. After creating the claim the modal closes and we STAY on the chart
  //    (URL still /veterans/MRN-...). The claim appears in the Cases panel.
  await expect(page.getByRole('heading', { name: 'New claim', exact: true })).toBeHidden({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/veterans\/MRN-/);

  // The Cases panel renders a link per case: the claimed condition is the link text.
  const caseLink = page.getByRole('link', { name: claimedCondition }).first();
  await expect(caseLink).toBeVisible({ timeout: 15_000 });

  // 8. Open the case -> case-detail page loads (no "Case not found").
  await caseLink.click();
  await expect(page).toHaveURL(/\/cases\/CLM-/, { timeout: 30_000 });
  await expect(page.getByText('Case not found')).toHaveCount(0);
  // Case-detail header: h1 is the claimed condition; sub-line shows "Case CLM-...".
  await expect(page.getByRole('heading', { name: claimedCondition, level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Case CLM-/)).toBeVisible();

  // 9. The "Send to Drafter" panel + button are present (admin, fresh case,
  //    no draft in flight). Do NOT click it.
  await expect(page.getByRole('heading', { name: 'Send to Drafter', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Send to Drafter', exact: true })).toBeVisible();
});
