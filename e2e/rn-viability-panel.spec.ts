import { test, expect, type Page } from '@playwright/test';
import { login } from './helpers/login';

/**
 * P4 RN viability panel — AC-1..AC-5 (build plan §4.4, the "actually wired" proof). Runs against
 * staging (E2E_BASE_URL / emr.flatratenexus.com), mirrors predraft-verify.spec.ts: login, open the
 * case page, assert on rendered body text.
 *
 * TODO(P4 activation — build plan §9 R1): ALL FIVE AC TESTS ARE SKIPPED until the 5 seeded staging
 * cases exist with these EXACT granted-SC profiles (fill the CLM-… ids below), AND
 * EMR_CASE_VIABILITY_ENABLED is ON in staging (cdk context case_viability_enabled='true'):
 *   AC-1 claims OSA, granted PTSD                       → "Strong"
 *   AC-2 claims OSA, granted ONLY Tinnitus               → "Weak" + excluded-trap reason
 *   AC-3 claims lumbar back, granted Knee, NO gait doc   → "Conditional" + missing_fact gait string
 *   AC-4 Hatfield: supplemental OSA + Anxiety 70% (+MDD/Tinnitus/HTN) → sound anchor, never "no SC condition"
 *   AC-5 Gulf-War-theater vet claiming IBS               → ADVISORY presumptive note (see below)
 * Until seeded, the backend-unit equivalent (case-viability.test.ts + case-viability-stamp.test.ts
 * golden suite) is the interim proof per R1.
 *
 * AC-5 DISPOSITION (build plan G9/R3 — FLAGGED TO RYAN): info-light has NO service_profile, so
 * info-light IBS+PTSD = `conditional` with an ADVISORY presumptive note, NOT a hard `redirect`
 * band. AC-5 here asserts the advisory note renders ("presumptive"/"3.317"); the verbatim
 * "Redirect" band is a CHART-REFINED behavior, deferred to the chart-refined follow-on (needs a
 * chart/index.json → documented_facts + service_profile normalizer the EMR does not have yet).
 */

const SEEDED = {
  ac1_osa_ptsd: 'CLM-FILL-ME-IN', // claims OSA, granted PTSD
  ac2_osa_tinnitusOnly: 'CLM-FILL-ME-IN', // claims OSA, only granted Tinnitus
  ac3_lumbar_knee_noGait: 'CLM-FILL-ME-IN', // claims lumbar back, granted Knee, gait NOT documented
  ac4_hatfield: 'CLM-FILL-ME-IN', // supplemental OSA + Anxiety 70% + MDD + Tinnitus + HTN
  ac5_gw_ibs: 'CLM-FILL-ME-IN', // Gulf-War-theater vet claiming IBS, granted PTSD
};

const SKIP_REASON = 'TODO(P4 activation): needs the 5 seeded staging cases (build plan §9 R1) + EMR_CASE_VIABILITY_ENABLED=true in staging.';

async function caseBodyText(page: Page, caseId: string): Promise<string> {
  await page.goto(`/cases/${caseId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500); // give the live card queries time to land (predraft-verify pattern)
  return (await page.locator('body').textContent()) ?? '';
}

/** Belt-and-suspenders vet-facing-leak check: no BVA %, no "BVA", no "pair-atlas" near the card. */
function expectNoBvaLeak(body: string): void {
  expect(body).not.toMatch(/\bBVA\b/);
  expect(body).not.toMatch(/pair[- ]atlas/i);
  // No "NN%" win/grant-rate style figure should render from the viability card. (Rating percents
  // like "70%" can legitimately appear in OTHER chart panels; the resolver structurally never
  // emits a % in why/excluded_traps/missing_fact, so a leak would have to be a card bug.)
  expect(body).not.toMatch(/\b\d{1,3}%\s*(win|grant|IMO|success)/i);
}

test.describe('RN viability panel — AC-1..AC-5', () => {
  test('AC-1 strong: OSA + granted PTSD renders Strong, PTSD anchor, no BVA %', async ({ page }) => {
    test.skip(true, SKIP_REASON);
    test.setTimeout(180_000);
    await login(page);
    const body = await caseBodyText(page, SEEDED.ac1_osa_ptsd);
    expect(body).toContain('Strong');
    expect(body).toContain('PTSD');
    expect(/Obstructive sleep apnea|OSA/i.test(body)).toBe(true);
    expectNoBvaLeak(body);
  });

  test('AC-2 weak/trap: OSA + only-Tinnitus renders Weak + the no-mechanism trap reason', async ({ page }) => {
    test.skip(true, SKIP_REASON);
    test.setTimeout(180_000);
    await login(page);
    const body = await caseBodyText(page, SEEDED.ac2_osa_tinnitusOnly);
    expect(body).toContain('Weak');
    // The excluded-traps disclosure is collapsed by default — open it, then assert the reason.
    await page.getByRole('button', { name: /Why not these anchors/ }).click();
    const opened = (await page.locator('body').textContent()) ?? '';
    expect(opened).toContain('Tinnitus');
    expect(/no credible mechanism|No physiologic pathway/i.test(opened)).toBe(true);
    expectNoBvaLeak(opened);
  });

  test('AC-3 conditional: lumbar + granted Knee (gait undocumented) renders Conditional + the gait missing_fact', async ({ page }) => {
    test.skip(true, SKIP_REASON);
    test.setTimeout(180_000);
    await login(page);
    const body = await caseBodyText(page, SEEDED.ac3_lumbar_knee_noGait);
    expect(body).toContain('Conditional');
    expect(/gait|altered weight-bearing|varus/i.test(body)).toBe(true);
    expect(body).toContain('To strengthen:'); // missing_fact IS the records-request justification
    expectNoBvaLeak(body);
  });

  test('AC-4 Hatfield: supplemental OSA + Anxiety-70% renders a sound anchor — NEVER "no SC condition" (the false-halt class)', async ({ page }) => {
    test.skip(true, SKIP_REASON);
    test.setTimeout(180_000);
    await login(page);
    const body = await caseBodyText(page, SEEDED.ac4_hatfield);
    expect(/Anxiety|PTSD/.test(body)).toBe(true);
    expect(body).not.toMatch(/no service-connected condition/i);
    expect(body).not.toMatch(/no SC condition/i);
    // Verified resolver: best anchor = Anxiety / GAD, band = moderate.
    expect(body).toContain('Moderate');
    expectNoBvaLeak(body);
  });

  test('AC-5 presumptive (ADVISORY in info-light): GW vet claiming IBS renders the presumptive note', async ({ page }) => {
    test.skip(true, SKIP_REASON);
    test.setTimeout(180_000);
    await login(page);
    const body = await caseBodyText(page, SEEDED.ac5_gw_ibs);
    // Info-light = conditional band + ADVISORY note (NOT the hard "Redirect" band — chart-refined
    // follow-on; see header). The card renders presumptive_redirect.note verbatim.
    expect(body).toContain('Consider presumptive:');
    expect(/presumptive|3\.317/i.test(body)).toBe(true);
    expectNoBvaLeak(body);
  });
});
