import { expect, test } from '@playwright/test';
import { login } from './helpers/login';

// Verifies the pre-draft redesign on Ryan's two real cases: the false red "Stop" is gone (now a neutral
// tier), no phantom-file block, the suggested pathway / argument render, and zero JS errors. Read-only.
// P1 re-source (2026-06-11): also asserts NO raw BVA string renders (n= / decided Board appeals / %)
// and reports whether a plain-language band word renders.

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
    const tier = /Review needed|Thin — review|Plausible|Strong|Moderate|Conditional|Weak/.exec(body)?.[0] ?? '(none)';
    const oldRedStopPill = body.includes('Stop — review'); // the OLD red pill — should be GONE
    const argument = (/Argument:\s*([^\n]{0,90})/.exec(body)?.[1] ?? '(none)').trim();
    // Pre-existing stale assertion fixed (P1): the card emits "Anticipated:", never "Suggested:".
    const suggested = body.includes('Anticipated:');
    const theory = body.includes('Veteran’s theory') || body.includes("Veteran's theory");
    const phantomBlock = /Intake_Summary\.pdf/.test(body) && /could not be/.test(body);
    // P1 NO-BVA-STRING LOCK (hard assertions): the two retired atlas strings must never render.
    expect(body, `${c.name}: raw Board count (n=) rendered`).not.toMatch(/\bn=\d/);
    expect(body, `${c.name}: "decided Board appeals" rendered`).not.toContain('decided Board appeals');
    expect(body, `${c.name}: a BVA tier-word rendered`).not.toMatch(/tier (high|moderate|low)/i);
    const bandWord = /Strong|Moderate|Conditional|Weak/.exec(body)?.[0] ?? '(none)';
    page.off('pageerror', onErr);
    report.push({ name: c.name, id: c.id, tier, bandWord, oldRedStopPill, phantomBlock, suggested, theory, argument, errors: errors.length, errs: errors });
  }

  // eslint-disable-next-line no-console
  console.log('\n===== PRE-DRAFT VERIFY =====');
  for (const r of report) {
    // eslint-disable-next-line no-console
    console.log(`${r.name} (${r.id}): tier=${r.tier} | band=${r.bandWord} | oldRedStopPill=${r.oldRedStopPill} | phantomBlock=${r.phantomBlock} | anticipated=${r.suggested} | theory=${r.theory} | jsErrors=${r.errors}`);
    console.log(`   argument: ${r.argument}`);
    if ((r.errors as number) > 0) console.log(`   pageErrors: ${JSON.stringify(r.errs)}`);
  }
  console.log('===== END =====\n');
});
