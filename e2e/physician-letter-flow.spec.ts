import { test, expect, type Page } from '@playwright/test';
import { login } from './helpers/login';

/**
 * Physician letter-editor end-to-end flow (LIVE site, real backend).
 *
 * Covers the path the architect fix repaired (2026-06-08): open a case that is in
 * `physician_review` with a drafted letter, confirm the LetterEditorPage loads (the editor
 * surface — NOT a "service unavailable" / "could not be loaded" empty state), save a new
 * version, then Approve → the sign-off popup opens → sign off → the letter approves and we
 * land back on the physician queue.
 *
 * WHY THIS IS .skip BY DEFAULT
 *   It REQUIRES a seeded case that is already at status=physician_review with a rendered draft
 *   letter AND a chart that passes the unbypassable chart-readiness gate (every uploaded file
 *   marked reviewed). The e2e suite otherwise creates only fresh veterans/claims (see
 *   rn-workflow.spec.ts) and never drives a full drafting+chart-prep run headless, so there is
 *   no such case to target without a seed. Provide one via E2E_PHYSICIAN_REVIEW_CASE_ID
 *   (a CLM-... id whose case is in physician_review) and the e2e user must be the assigned
 *   physician (or admin). Then run:
 *
 *     E2E_PHYSICIAN_REVIEW_CASE_ID=CLM-XXXX npx playwright test physician-letter-flow --grep-invert @skip
 *
 *   (or temporarily flip `test.skip` → `test` below). Until a seed exists this stays skipped so
 *   the green suite is not gated on infra we don't provision in CI.
 *
 * Selectors derived from:
 *   - routes/cases/LetterEditorPage.tsx  (title h1 = filename, "Save new version",
 *       "Saved version N.", "Approve letter", "Download Word (.docx)")
 *   - components/SignOffPopup.tsx        ("Physician sign-off", "Yes" x5, "Submit sign-off")
 */

const SEED_CASE_ID = process.env.E2E_PHYSICIAN_REVIEW_CASE_ID ?? '';

async function openLetterEditor(page: Page, caseId: string): Promise<void> {
  await page.goto(`/cases/${encodeURIComponent(caseId)}/letter`, { waitUntil: 'domcontentloaded' });

  // The editor must actually render — NOT the loading spinner forever, NOT the empty states
  // ("Letter could not be loaded."), and NOT a 503 "not available in this environment" banner.
  await expect(page.getByText('Letter could not be loaded.')).toHaveCount(0);
  // The Editing panel's primary action is the load-bearing proof the editor mounted.
  await expect(page.getByRole('button', { name: 'Save new version' })).toBeVisible({ timeout: 30_000 });
  // The top bar relabel (architect fix): the editable Word source download is clearly a download.
  await expect(page.getByRole('button', { name: 'Download Word (.docx)' })).toBeVisible();
}

test.skip('physician letter flow: editor loads, save new version, approve via sign-off', async ({ page }) => {
  test.skip(SEED_CASE_ID === '', 'Set E2E_PHYSICIAN_REVIEW_CASE_ID to a seeded physician_review case to run this.');
  test.setTimeout(180_000);

  // 1. Authenticate (Cognito password + TOTP). The e2e user must be admin or the assigned physician.
  await login(page);

  // 2. Open the letter editor for the seeded physician_review case (it must load, not 503).
  await openLetterEditor(page, SEED_CASE_ID);

  // 3. Save a new version. The editor confirms with "Saved version N." and stays on the page.
  await page.getByRole('button', { name: 'Save new version' }).click();
  await expect(page.getByText(/Saved version \d+\./)).toBeVisible({ timeout: 45_000 });

  // 4. Approve → opens the physician sign-off popup (the bare Approve used to 409 sign_off_required;
  //    the architect fix wires the sign-off-before-approve flow here, mirroring PhysicianReviewPage).
  await page.getByRole('button', { name: 'Approve letter' }).click();
  await expect(page.getByRole('heading', { name: 'Physician sign-off' })).toBeVisible({ timeout: 15_000 });

  // 5. Answer every attestation "Yes", then submit the sign-off. Submit is disabled until all 5
  //    are affirmative, so click them all first.
  const yesButtons = page.getByRole('button', { name: 'Yes', exact: true });
  const count = await yesButtons.count();
  expect(count).toBeGreaterThanOrEqual(5);
  for (let i = 0; i < count; i += 1) await yesButtons.nth(i).click();
  const submit = page.getByRole('button', { name: 'Submit sign-off' });
  await expect(submit).toBeEnabled();
  await submit.click();

  // 6. Sign-off recorded → approve chains → finalized → navigate back to the physician queue.
  await expect(page).toHaveURL(/\/p\/queue/, { timeout: 60_000 });
});
