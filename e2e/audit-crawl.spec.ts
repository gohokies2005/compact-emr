import { test } from '@playwright/test';
import { login } from './helpers/login';

// READ-ONLY audit crawl: log in as the admin e2e user, visit every screen (and the richest detail pages),
// and capture render failures, uncaught JS errors, and failed API calls (4xx/5xx). NO mutations — only
// navigation + reading. Reports a per-screen health table; never fails the run (the report is the output).

const STATIC_ROUTES = [
  '/', '/veterans', '/cases', '/templates', '/physicians', '/staff', '/email-settings',
  '/activity', '/refunds', '/compensation', '/metrics', '/costs',
  '/p/queue', '/p/letters', '/rn', '/intake',
];

interface RouteReport {
  route: string;
  rendered: boolean;
  consoleErrors: string[];
  pageErrors: string[];
  badResponses: string[];
}

test('read-only crawl: every screen renders without JS or API errors', async ({ page }) => {
  test.setTimeout(360_000);
  const report: RouteReport[] = [];
  await login(page);

  async function visit(route: string): Promise<void> {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const badResponses: string[] = [];
    const onConsole = (msg: { type: () => string; text: () => string }) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200));
    };
    const onPageError = (e: Error) => pageErrors.push(String(e.message).slice(0, 200));
    const onResponse = (r: { status: () => number; url: () => string }) => {
      const s = r.status();
      const u = r.url();
      if (s >= 400 && !u.includes('favicon') && !u.includes('.png') && !u.includes('.ico')) {
        badResponses.push(`${s} ${u.replace(/https:\/\/[^/]+/, '')}`.slice(0, 200));
      }
    };
    page.on('console', onConsole);
    page.on('pageerror', onPageError);
    page.on('response', onResponse);
    let rendered = true;
    try {
      await page.goto(route, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2800);
      const bodyText = (await page.locator('body').textContent()) ?? '';
      rendered = bodyText.trim().length > 50 && !/something went wrong|application error|unexpected error/i.test(bodyText);
    } catch (e) {
      rendered = false;
      pageErrors.push('NAV: ' + String(e).slice(0, 150));
    }
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    page.off('response', onResponse);
    report.push({ route, rendered, consoleErrors, pageErrors, badResponses });
  }

  for (const r of STATIC_ROUTES) await visit(r);

  // Detail pages (the richest button surfaces): follow the first real row from each list — read-only nav.
  await page.goto('/cases', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const caseHref = await page.locator('a[href^="/cases/"]').first().getAttribute('href').catch(() => null);
  if (caseHref) await visit(caseHref);

  await page.goto('/veterans', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const vetHref = await page.locator('a[href^="/veterans/"]').first().getAttribute('href').catch(() => null);
  if (vetHref) await visit(vetHref);

  // eslint-disable-next-line no-console
  console.log('\n===== READ-ONLY CRAWL REPORT =====');
  for (const r of report) {
    const clean = r.rendered && r.pageErrors.length === 0 && r.badResponses.length === 0;
    // eslint-disable-next-line no-console
    console.log(`${clean ? 'OK  ' : 'FLAG'} ${r.route}  rendered=${r.rendered} consoleErr=${r.consoleErrors.length} pageErr=${r.pageErrors.length} badResp=${r.badResponses.length}`);
    if (!r.rendered) console.log('     *** DID NOT RENDER ***');
    if (r.pageErrors.length) console.log('     pageErrors: ' + JSON.stringify(r.pageErrors.slice(0, 4)));
    if (r.badResponses.length) console.log('     badResponses: ' + JSON.stringify(r.badResponses.slice(0, 6)));
    if (r.consoleErrors.length) console.log('     consoleErrors: ' + JSON.stringify(r.consoleErrors.slice(0, 4)));
  }
  console.log('===== END REPORT =====\n');
});
