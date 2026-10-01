import {
  test, expect, openApp, go, ui, list, listRows, listRow, inlineDetails, chip, search, tab, activeTab, switchMs, switchOrg, switchRole,
  expectShown,
} from './helpers.js';

const isActiveChip = (l) => expect(l).toHaveAttribute('style', /background: var\(--tx\)/);

// Inline rows keep the header clickable, so expanded rows, filters and search must all reset on a system switch.
test.describe('Management system switching resets the selection', () => {
  test('Controls & requirements', async ({ page }) => {
    await openApp(page, '?drill=inline');
    await go(page, 'Controls & requirements');
    await tab(page, 'Partially implemented').click();
    await chip(page, 'Partial').click();
    await search(page, 'A.5');
    await listRows(page).first().click();
    await expect(inlineDetails(page)).toHaveCount(1);
    await switchMs(page, 'QMS');
    await expect(inlineDetails(page)).toHaveCount(0);
    await expect(ui.search(page)).toHaveValue('');
    await expect(activeTab(page)).toContainText('Requirements implemented');
    await expectShown(page, 22);
  });

  test('Chain stages', async ({ page }) => {
    await openApp(page, '?drill=inline');
    await go(page, 'Chain stages');
    await page.locator('main tr[data-hov]').filter({ hasText: 'Bagus Prasetyo' }).click();
    await listRows(page).first().click();
    await expect(inlineDetails(page)).toHaveCount(1);
    await switchMs(page, 'QMS');
    await expect(page.locator('main')).not.toContainText('Showing items held by');
    await expect(inlineDetails(page)).toHaveCount(0);
    await expect(activeTab(page).locator('div').nth(1)).toHaveText('Context issue');
    await expect(page.locator('main tr[data-hov]')).toHaveCount(4);
  });

  test('Evidence freshness', async ({ page }) => {
    await openApp(page, '?drill=inline');
    await go(page, 'Evidence freshness');
    await tab(page, 'Expired').click();
    await page.locator('main button[style*="grid-template-columns: 110px 1fr 120px"]').filter({ hasText: 'Quarterly' }).click();
    await listRows(page).first().click();
    await expect(inlineDetails(page)).toHaveCount(1);
    await switchMs(page, 'QMS');
    await expect(activeTab(page)).toHaveCount(0);
    await expect(page.locator('main button[style*="grid-template-columns: 110px 1fr 120px"][style*="var(--accbg)"]')).toHaveCount(0);
    await expect(inlineDetails(page)).toHaveCount(0);
    await expectShown(page, 27);
  });

  test('Document register and Review calendar', async ({ page }) => {
    await openApp(page, '?drill=inline');
    await go(page, 'Document register');
    await chip(page, 'Expired').click();
    await listRows(page).first().click();
    await switchMs(page, 'BCMS');
    await isActiveChip(chip(page, 'All'));
    await expect(inlineDetails(page)).toHaveCount(0);
    await go(page, 'Review calendar');
    await search(page, 'IMS');
    await switchMs(page, 'ABMS');
    await expect(ui.search(page)).toHaveValue('');
    await expect(listRows(page)).toHaveCount(3);
  });

  test('Storage repositories', async ({ page }) => {
    await openApp(page, '?drill=inline');
    await go(page, 'Storage repositories');
    await chip(page, 'All').click();
    await listRows(page).first().click();
    await expect(inlineDetails(page)).toHaveCount(1);
    await switchMs(page, 'BCMS');
    await isActiveChip(chip(page, 'Needs attention'));
    await expect(inlineDetails(page)).toHaveCount(0);
  });

  test('Phase board and Audit readiness', async ({ page }) => {
    await openApp(page, '?drill=inline');
    await go(page, 'Phase board');
    await page.locator('main button[title="Initiation & mandate"]').click();
    await switchMs(page, 'QMS');
    await expect(page.locator('main')).toContainText('9. ISO 9001:2026 transition');
    await go(page, 'Audit readiness');
    await page.locator('main button', { hasText: /^RO-07$/ }).click();
    await switchMs(page, 'ISMS');
    await expect(page.locator('main button', { hasText: /^R-014$/ })).toHaveAttribute('style', /background: var\(--tx\)/);
  });

  test('"show more" starts again from the first page', async ({ page }) => {
    await openApp(page);
    await go(page, 'Controls & requirements');
    await chip(page, 'All').click();
    await list(page).locator('xpath=./div[last()]/button').click();
    await expect(listRows(page)).toHaveCount(60);
    await switchMs(page, 'ABMS');
    await chip(page, 'All').click();
    await expect(listRows(page)).toHaveCount(30);
  });
});

test.describe('Organisation switching', () => {
  test('a two-system on-premise organisation', async ({ page }) => {
    await openApp(page);
    await switchOrg(page, 'PT Bank Sentosa Digital');
    await expect(ui.title(page)).toHaveText('Portfolio Overview');
    await expect(page.locator('main svg[viewBox="0 0 120 120"]')).toHaveCount(2);
    await expect(page.locator('main button[style*="grid-template-columns: 46px"]').filter({ hasText: /BCMS|ABMS/ })).toHaveCount(0);
    await ui.orgButton(page).click();
    await expect(page.locator('aside div[style*="min-width: 260px"] button')).toHaveText([
      /PT Nusantara Digital Teknologi\s*4 management systems, SaaS/,
      /PT Bank Sentosa Digital\s*2 management systems, On-Premise/,
      /RS Medika Nusantara\s*1 management system, SaaS/,
    ]);
    await ui.orgButton(page).click();
    await ui.msSwitch(page).click();
    await expect(page.locator('header div[style*="width: 420px"] button')).toHaveText([/ISMS/, /QMS/, /Integrated view/]);
    await ui.msSwitch(page).click();
    await go(page, 'Certification timeline');
    await expect(page.locator('main div[style*="height: 58px"]')).toHaveCount(2);
  });

  test('a single-system organisation lands on Overview without the portfolio', async ({ page }) => {
    await openApp(page);
    await switchOrg(page, 'RS Medika Nusantara');
    await expect(ui.title(page)).toHaveText('Overview');
    await expect(ui.nav(page, 'Portfolio Overview')).toHaveCount(0);
    await expect(ui.navItems(page)).toHaveCount(13);
    await expect(ui.msSwitch(page).locator('svg')).toHaveCount(0);
    await ui.msSwitch(page).click();
    await expect(page.locator('header div[style*="width: 420px"]')).toHaveCount(0);
    await go(page, 'Framework library');
    await expect(page.locator('main table tbody > tr')).toHaveCount(1);
    await go(page, 'Storage repositories');
    await expect(page.locator('main div[style*="box-shadow"][style*="gap: 10px"]').filter({ hasText: 'references' })).toHaveCount(2);
  });

  test('switching organisation clears filters and returns to the full tenant', async ({ page }) => {
    await openApp(page, '?drill=inline');
    await go(page, 'Controls & requirements');
    await chip(page, 'All').click();
    await search(page, 'backup');
    await listRows(page).first().click();
    await expect(inlineDetails(page)).toHaveCount(1);
    await switchOrg(page, 'RS Medika Nusantara');
    await go(page, 'Controls & requirements');
    await expect(ui.search(page)).toHaveValue('');
    await expect(inlineDetails(page)).toHaveCount(0);
    await switchOrg(page, 'PT Nusantara Digital Teknologi');
    await expect(ui.title(page)).toHaveText('Portfolio Overview');
    await expect(page.locator('main svg[viewBox="0 0 120 120"]')).toHaveCount(4);
    await expect(ui.navItems(page)).toHaveCount(14);
  });
});

test.describe('Roles and navigation', () => {
  test('switching to a role that cannot open the current screen moves to one it can', async ({ page }) => {
    await openApp(page);
    await go(page, 'Phase board');
    await switchRole(page, 'Internal Auditor');
    await expect(ui.title(page)).toHaveText('Portfolio Overview');
    await expect(ui.nav(page, 'Phase board')).toHaveCount(0);
    await go(page, 'Golden Thread Viewer');
    await switchRole(page, 'Top Management');
    await expect(ui.title(page)).toHaveText('Portfolio Overview');
    await go(page, 'Chain stages');
    await switchRole(page, 'MS Manager');
    await expect(ui.title(page)).toHaveText('Chain stages');
  });

  test('a domain owner sees only their own controls and documents', async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'Domain Owner');
    await expect(ui.navItems(page)).toHaveText([/Overview/, /Controls & requirements/, /Document register/, /Evidence freshness/, /My Tasks/]);
    await go(page, 'Controls & requirements');
    await chip(page, 'All').click();
    await expect(listRows(page).locator('td:nth-child(5)')).toHaveText(Array(await listRows(page).count()).fill(/Bagus Prasetyo/));
    await go(page, 'Document register');
    await expect(listRows(page).locator('td:nth-child(5)')).toHaveText(Array(await listRows(page).count()).fill(/Bagus Prasetyo/));
  });

  test('an auditor in a single-system organisation lands on a screen they can open', async ({ page }) => {
    await openApp(page);
    await switchOrg(page, 'RS Medika Nusantara');
    await switchRole(page, 'Internal Auditor');
    await go(page, 'Chain stages');
    await switchOrg(page, 'RS Medika Nusantara');
    await expect(ui.title(page)).toHaveText('Audit readiness');
    await expect(ui.navItems(page)).toHaveCount(8);
  });

  test('sidebar badges count gate items, chain problems, critical evidence and tasks', async ({ page }) => {
    await openApp(page);
    const badge = (label) => ui.nav(page, label).locator('> span:last-child');
    await expect(badge('Controls & requirements')).toHaveText('4');
    await expect(badge('Chain stages')).toHaveText('24');
    await expect(badge('Evidence freshness')).toHaveText('3');
    await expect(badge('My Tasks')).toHaveText('3');
    await switchMs(page, 'QMS');
    await expect(ui.nav(page, 'Controls & requirements').locator('> span')).toHaveCount(1);
    await expect(badge('Chain stages')).toHaveText('5');
  });

  test('opening another screen starts at the top of the page', async ({ page }) => {
    await openApp(page);
    await page.mouse.wheel(0, 900);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
    await page.locator('aside nav button[title="Chain stages"]').click();
    await expect(ui.title(page)).toHaveText('Chain stages');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  });
});
