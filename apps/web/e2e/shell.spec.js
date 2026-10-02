import { test, expect, SCREENS, openApp, go, ui, expectToast, expectNoHorizontalOverflow } from './helpers.js';

test.describe('App shell', () => {
  test('every screen opens from the sidebar with no layout overflow', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('aside nav button')).toHaveCount(SCREENS.length);
    for (const label of SCREENS) {
      await go(page, label);
      await expect(page.locator('aside nav button[title="' + label + '"]')).toHaveCSS('font-weight', '600');
      await expectNoHorizontalOverflow(page);
    }
  });

  // Golden Thread Viewer and My Tasks have no page actions in the design; every other screen has at least one.
  const PAGE_ACTIONS = {
    'Portfolio Overview': { 'Export board': 'Board exported as PDF' },
    'Overview': { 'Readiness report': 'Readiness report queued' },
    'Controls & requirements': { 'Export SoA': 'Statement of Applicability exported (xlsx)', 'Add control': 'New custom control form opened' },
    'Phase board': { 'Verify phase': 'Phase verification needs all activities Verified' },
    'Document register': { 'Export': 'Document register exported (xlsx)', 'New document': 'New document form opened' },
    'Audit readiness': { 'Build evidence pack': 'manifest will appear in SharePoint Online', 'Auditor access': 'Guest access link created, valid 14 days' },
    'Chain stages': { 'Remind all holders': 'Reminders sent to 8 holders' },
    'Golden Thread Viewer': {},
    'Certification timeline': { 'Add audit event': 'Audit event form opened' },
    'Evidence freshness': { 'Run integrity check': 'Integrity check started for 79 references' },
    'Review calendar': { 'Calendar feed': 'Calendar feed (.ics) copied to clipboard' },
    'My Tasks': {},
    'Framework library': { 'Check for updates': 'Checked, 2 updates available' },
    'Storage repositories': { 'Connect repository': 'Repository connection wizard opened' },
  };
  // @sample-only: in API mode page actions are api commands whose toasts carry the api's answers (exports queued for the worker, the auditor's email asked, counts from the api; H.4, WP-25 deviations 5 and 7).
  test('every screen has working page actions', { tag: '@sample-only' }, async ({ page }) => {
    await openApp(page);
    for (const label of SCREENS) {
      await go(page, label);
      const actions = page.locator('main > div > div:first-child button[title]');
      const expected = PAGE_ACTIONS[label];
      await expect(actions, label + ' page actions').toHaveCount(Object.keys(expected).length);
      for (const [action, message] of Object.entries(expected)) {
        await actions.filter({ hasText: action }).click();
        await expectToast(page, message);
      }
    }
  });

  test('sidebar collapses to icons and expands again', async ({ page }) => {
    await openApp(page);
    const aside = page.locator('aside');
    const wide = (await aside.boundingBox()).width;
    await page.locator('aside button[title="Collapse"]').click();
    await expect.poll(async () => (await aside.boundingBox()).width).toBeLessThan(80);
    await expect(page.locator('aside nav button').first().locator('span span')).toHaveCount(0);
    await page.locator('aside nav button[title="Evidence freshness"]').click();
    await expect(ui.title(page)).toHaveText('Evidence freshness');
    await page.locator('aside button[title="Expand"]').click();
    await expect.poll(async () => (await aside.boundingBox()).width).toBe(wide);
  });

  test('theme toggles between light and dark', async ({ page }) => {
    await openApp(page);
    const root = page.locator('.mscd').first();
    await expect(root).toHaveAttribute('data-theme', 'light');
    const lightBg = await root.evaluate((el) => getComputedStyle(el).backgroundColor);
    await page.locator('header button[title="Theme"]').click();
    await expect(root).toHaveAttribute('data-theme', 'dark');
    expect(await root.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(lightBg);
    await page.locator('header button[title="Theme"]').click();
    await expect(root).toHaveAttribute('data-theme', 'light');
  });

  test('language switches between English and Indonesian', async ({ page }) => {
    await openApp(page);
    await page.locator('header button', { hasText: /^ID$/ }).click();
    await expect(ui.title(page)).toHaveText('Ikhtisar Portofolio');
    await expect(page.locator('aside nav')).toContainText('Kesegaran bukti');
    await page.locator('header button', { hasText: /^EN$/ }).click();
    await expect(ui.title(page)).toHaveText('Portfolio Overview');
  });

  test('management system switcher changes the active system', async ({ page }) => {
    await openApp(page);
    await go(page, 'Controls & requirements');
    const sw = page.locator('header button[title="Switch management system"]');
    await expect(sw).toContainText('ISMS');
    await sw.click();
    await page.locator('header button', { hasText: 'QMS' }).filter({ hasText: 'ISO 9001' }).last().click();
    await expect(sw).toContainText('QMS');
    await expect(page.locator('main')).toContainText('Requirements implemented');
    await expect(page.locator('aside')).toContainText('ISO9001');
  });

  test('integrated view entry returns to the portfolio', async ({ page }) => {
    await openApp(page);
    await go(page, 'Chain stages');
    await page.locator('header button[title="Switch management system"]').click();
    await page.locator('header button', { hasText: 'IMS' }).click();
    await expect(ui.title(page)).toHaveText('Portfolio Overview');
  });

  test('organisation switcher swaps tenant, systems and hides portfolio for single-system orgs', async ({ page }) => {
    await openApp(page);
    const orgBtn = page.locator('aside > div:nth-child(2) > button');
    await orgBtn.click();
    await page.locator('aside button', { hasText: 'PT Bank Sentosa Digital' }).click();
    await expect(orgBtn).toContainText('PT Bank Sentosa Digital');
    await page.locator('header button[title="Switch management system"]').click();
    const options = page.locator('header div[style*="width: 420px"] button');
    await expect(options).toHaveCount(3); // ISMS, QMS, integrated view
    await page.keyboard.press('Escape');
    await page.locator('header button[title="Switch management system"]').click();

    await orgBtn.click();
    await page.locator('aside button', { hasText: 'RS Medika Nusantara' }).click();
    await expect(orgBtn).toContainText('RS Medika Nusantara');
    await expect(ui.title(page)).toHaveText('Overview');
    await expect(page.locator('aside nav button[title="Portfolio Overview"]')).toHaveCount(0);
    await expect(page.locator('header button[title="Switch management system"] svg')).toHaveCount(0);
  });

  test('role switcher changes persona, landing screen and navigation', async ({ page }) => {
    await openApp(page);
    const roleBtn = page.locator('header button', { hasText: 'Rina Kusuma' });
    const pick = async (role) => {
      await page.locator('header > div:last-child > div:last-child > button').click();
      await page.locator('header div[style*="width: 300px"] button', { hasText: role }).click();
    };
    await expect(roleBtn).toBeVisible();
    await pick('Domain Owner');
    await expect(ui.title(page)).toHaveText('My Tasks');
    await expect(page.locator('aside nav button')).toHaveCount(5);
    await pick('Auditor');
    await expect(page.locator('aside nav button')).toHaveCount(9);
    await expect(page.locator('aside nav button[title="Framework library"]')).toHaveCount(0);
    await pick('Top management');
    await expect(ui.title(page)).toHaveText('Portfolio Overview');
    await expect(page.locator('aside nav button')).toHaveCount(6);
    await pick('MS Manager');
    await expect(page.locator('aside nav button')).toHaveCount(14);
  });

  test('Tera explains every screen and can be dismissed', async ({ page }) => {
    await openApp(page);
    for (const label of SCREENS) {
      await go(page, label);
      await ui.tera(page).click({ force: true });
      const card = ui.teraCard(page);
      await expect(card).toBeVisible();
      await expect(card).toContainText(label);
      await expect(card.locator('ol li').first()).toBeVisible();
      await card.locator('button', { hasText: 'Got it' }).click();
      await expect(card).toHaveCount(0);
    }
  });
});
