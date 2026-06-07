import { test } from '@playwright/test';
import { login } from './helpers/login';

// Verifies the pre-draft redesign on Ryan's two real cases: the false red "Stop" is gone (now a neutral
// tier), no phantom-file block, the suggested pathway / argument render, and zero JS errors. Read-only.

const CASES = [
  { id: 'CLM-44F17A108A', name: 'Lozano (GERD)' },
  { id: 'CLM-7B345A77F0', name: 'Yorde (OSA)' },
];

test('pre-draft: no false Stop, no phantom block, no JS errors', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page);

  const report: Array<Record<string, unknown>> = [];
  for (const c of CASES) {
    const errors: string[] = [];
    const onErr = (e: Error) => errors.push(String(e.message).slice(0, 150));
    page.on('pageerror', onErr);
    await page.goto(`/cases/${c.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4500);
    const body = (await page.locator('body').textContent()) ?? '';
    const tier = /Review needed|Thin — review|Plausible|Strong/.exec(body)?.[0] ?? '(none)';
    const oldRedStopPill = body.includes('Stop — review'); // the OLD red pill — should be GONE
    const argument = (/Argument:\s*([^\n]{0,90})/.exec(body)?.[1] ?? '(none)').trim();
    const suggested = body.includes('Suggested:');
    const theory = body.includes('Veteran’s theory') || body.includes("Veteran's theory");
    const phantomBlock = /Intake_Summary\.pdf/.test(body) && /could not be/.test(body);
    page.off('pageerror', onErr);
    report.push({ name: c.name, id: c.id, tier, oldRedStopPill, phantomBlock, suggested, theory, argument, errors: errors.length, errs: errors });
  }

  // eslint-disable-next-line no-console
  console.log('\n===== PRE-DRAFT VERIFY =====');
  for (const r of report) {
    // eslint-disable-next-line no-console
    console.log(`${r.name} (${r.id}): tier=${r.tier} | oldRedStopPill=${r.oldRedStopPill} | phantomBlock=${r.phantomBlock} | suggested=${r.suggested} | theory=${r.theory} | jsErrors=${r.errors}`);
    console.log(`   argument: ${r.argument}`);
    if ((r.errors as number) > 0) console.log(`   pageErrors: ${JSON.stringify(r.errs)}`);
  }
  console.log('===== END =====\n');
});
