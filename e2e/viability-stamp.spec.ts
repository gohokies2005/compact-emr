import { test, expect } from '@playwright/test';
import { login } from './helpers/login';

/**
 * P4 anchor-viability STAMP proof (build plan §3.7): a real drafter-export carries
 * bundle.caseViability (version 1 + a viability band) when EMR_CASE_VIABILITY_ENABLED is on.
 *
 * Primary path: hit GET /api/v1/cases/:id/drafter-export (the same endpoint that stamps
 * caseFraming at drafter.ts:~356), fetch the returned presigned bundle URL, assert the exported
 * bundle JSON carries `caseViability` with version 1 and a band. The export GET uses
 * persist:false, so this proof never mutates the case.
 *
 * Fallback path (also asserted): GET /api/v1/cases/:id/viability-card returns a band for the same
 * case — proves the same shared derivation (deriveCaseViabilityForCase) the stamp uses.
 *
 * TODO(P4 activation — build plan §9 R1 + §3.5): SKIPPED until
 *   (1) EMR_CASE_VIABILITY_ENABLED is ON in staging (cdk context case_viability_enabled='true'),
 *   (2) a staging case id with at least one granted SC condition is seeded/identified and filled
 *       in below (reuse the predraft-verify.spec pattern of a real CLM-… id).
 * While the flag is dark the card GET returns { data: null } and the export bundle has no
 * caseViability key BY DESIGN — running this spec before activation would fail for the right
 * reason but prove nothing.
 */

// Fill with a real staging case id before activation (e.g. 'CLM-7B345A77F0' — Yorde OSA — if its
// veteran has a granted SC condition recorded).
const STAMP_CASE_ID = 'CLM-FILL-ME-IN';

test.skip(true, 'TODO(P4 activation): needs EMR_CASE_VIABILITY_ENABLED=true in staging + a seeded staging case id (build plan §9 R1).');

test('drafter-export bundle carries caseViability (version 1 + band); viability-card GET agrees', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page);

  // The SPA authenticates with an Authorization bearer from Amplify (not cookies), so in-browser
  // fetch via page.evaluate inherits the session token handling from the app's own client. We use
  // the Amplify session directly to call the API like the app does.
  const apiResult = await page.evaluate(async (caseId) => {
    // Pull the current access token out of Amplify's localStorage cache the same way the app's
    // axios interceptor does (aws-amplify fetchAuthSession is not importable here, so read the
    // CognitoIdentityServiceProvider cache keys).
    const tokenKey = Object.keys(localStorage).find((k) => /CognitoIdentityServiceProvider\..*\.idToken$/.test(k));
    const token = tokenKey ? localStorage.getItem(tokenKey) : null;
    if (!token) return { error: 'no Cognito idToken in localStorage' };

    const exportRes = await fetch(`/api/v1/cases/${encodeURIComponent(caseId)}/drafter-export`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!exportRes.ok) return { error: `drafter-export HTTP ${exportRes.status}` };
    const exportBody = (await exportRes.json()) as { data: { presignedUrl: string } };

    const bundleRes = await fetch(exportBody.data.presignedUrl);
    if (!bundleRes.ok) return { error: `presigned bundle HTTP ${bundleRes.status}` };
    const bundle = (await bundleRes.json()) as { caseViability?: { version?: number; viability?: string }; caseFraming?: unknown };

    const cardRes = await fetch(`/api/v1/cases/${encodeURIComponent(caseId)}/viability-card`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const card = cardRes.ok ? ((await cardRes.json()) as { data: { viability?: string } | null }) : null;

    return {
      hasCaseFraming: bundle.caseFraming !== undefined,
      caseViability: bundle.caseViability ?? null,
      cardBand: card?.data?.viability ?? null,
    };
  }, STAMP_CASE_ID);

  expect((apiResult as { error?: string }).error).toBeUndefined();
  const r = apiResult as { hasCaseFraming: boolean; caseViability: { version?: number; viability?: string } | null; cardBand: string | null };

  // The stamp: both SSOT blocks land on the same exported bundle (the critical invariant, G12).
  expect(r.hasCaseFraming).toBe(true);
  expect(r.caseViability).not.toBeNull();
  expect(r.caseViability?.version).toBe(1);
  expect(['strong', 'moderate', 'conditional', 'weak', 'abstain', 'redirect']).toContain(r.caseViability?.viability);

  // Fallback/corroboration: the card GET (same shared derivation) returns the same band family.
  expect(r.cardBand).not.toBeNull();
  expect(['strong', 'moderate', 'conditional', 'weak', 'abstain', 'redirect']).toContain(r.cardBand);
});
