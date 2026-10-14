import { test, expect, openApp, go, ui, switchOrg, expectToast } from './helpers.js';

const rows = (page) => page.locator('main table tbody > tr');
const row = (page, code) => rows(page).filter({ hasText: code });
const licence = (page) => page.locator('main div[style*="background: rgb(28, 26, 23)"]').filter({ hasText: /^Licence/ });
const meters = (page) => licence(page).locator('div[style*="min-width: 64px"]');
const channel = (page) => page.locator('main div[style*="flex-direction: column"][style*="gap: 10px"]').filter({ hasText: /update channel/i });

async function openFw(page, query = '') {
  await openApp(page, query);
  await go(page, 'Standards & licence');
}

test.describe('Standards & licence', () => {
  test('lists every framework with edition, signed pack, status and repository', async ({ page }) => {
    await openFw(page);
    await expect(page.locator('main thead th')).toHaveText(['Standard', 'Editions', 'Pack version', 'Status', 'Active management systems', 'Files', '']);
    await expect(rows(page)).toHaveCount(4);
    await expect(row(page, 'ISO/IEC 27001 : 2022')).toContainText('Current');
    await expect(row(page, 'ISO/IEC 27001 : 2022').locator('[data-tip="Ed25519, 02 Feb 2026"]')).toHaveCount(1);
    await expect(row(page, 'ISO/IEC 27001 : 2022')).toContainText('SharePoint');
    await expect(row(page, 'ISO 9001 : 2015')).toContainText('Edition transition');
    await expect(row(page, 'ISO 9001 : 2015')).toContainText('Update available 1.0.0');
    await expect(row(page, 'ISO 9001 : 2015')).toContainText('2026, 2015 in transition');
    await expect(row(page, 'ISO 22301 : 2019')).toContainText('Zero-transit');
    await expect(row(page, 'ISO 37001 : 2025')).toContainText('Beta pack');
    await expect(row(page, 'ISO 37001 : 2025')).toContainText('Update available 0.7.0');
    // only the edition in transition offers the transition assistant
    await expect(page.locator('main button', { hasText: /^Transition$/ })).toHaveCount(1);
    await expect(page.locator('main button', { hasText: /^Manage$/ })).toHaveCount(4);
  });

  test('every action column stays reachable at 1280 px', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openFw(page);
    for (const b of await page.locator('main table button').all()) {
      await expect(b).toBeInViewport();
    }
  });

  test('Manage opens the overview of that system', async ({ page }) => {
    await openFw(page);
    await row(page, 'ISO 37001 : 2025').locator('button', { hasText: 'Manage' }).click();
    await expect(ui.title(page)).toHaveText('Readiness by clause');
    await expect(ui.msSwitch(page)).toContainText('ABMS');
    await go(page, 'Standards & licence');
    await row(page, 'ISO 22301 : 2019').locator('button', { hasText: 'Manage' }).click();
    await expect(ui.msSwitch(page)).toContainText('BCMS');
  });

  test('Transition opens the transition phase of the QMS', async ({ page }) => {
    await openFw(page);
    await row(page, 'ISO 9001 : 2015').locator('button', { hasText: 'Transition' }).click();
    await expect(ui.title(page)).toHaveText('Roadmap');
    await expect(ui.msSwitch(page)).toContainText('QMS');
    await expect(page.locator('main')).toContainText('9. ISO 9001:2026 transition');
  });

  test('licence meters show usage against the entitlement', async ({ page }) => {
    await openFw(page);
    await expect(licence(page)).toContainText('PT Nusantara Digital Teknologi');
    await expect(licence(page)).toContainText('Valid to 31 Mar 2027, Signature ✓ Ed25519, verified');
    await expect(licence(page).locator('span[style*="border-radius: 999px"]')).toHaveText(['Integrated Management System', 'Edition Transition Assistant', 'Link Health Monitor', 'Auditor guest access']);
    await expect(meters(page)).toHaveText([/4\s*Frameworks/, /4\s*Management systems/, /86\s*Users/]);
    const widths = await meters(page).locator('div[style*="height: 100%"]').evaluateAll((els) => els.map((e) => e.style.width));
    expect(widths).toEqual(['100%', '40%', '57%']);
  });

  // @sample-only: in API mode the deployment comes from the api's profile (I.1; the test profile is on-premise) and Check for updates calls the api (H.4).
  test('SaaS update channel checks for updates', { tag: '@sample-only' }, async ({ page }) => {
    await openFw(page);
    await expect(channel(page)).toContainText('Update channel');
    await expect(channel(page)).toContainText('Packs are distributed automatically');
    await expect(channel(page)).toContainText('Storage connectors: Managed Vault, Microsoft 365, Google Workspace, SMB');
    await channel(page).locator('button', { hasText: 'Check for updates' }).click();
    await expectToast(page, 'Checked: ISO9001-2026 1.0.0 and ISO37001-2025 0.7.0 available');
    await ui.pageAction(page, 'Check for updates').click();
    await expectToast(page, 'Checked, 2 updates available');
  });

  // @sample-only: in API mode Import offline bundle opens the file dialog and sends the bundle to the api (A.4 5.10, H.4) instead of the sample toast.
  test('on-premise deployments use the offline update channel', { tag: '@sample-only' }, async ({ page }) => {
    await openFw(page, '?deploy=onprem');
    await expect(channel(page)).toContainText('Offline update channel');
    await expect(channel(page)).toContainText('signed offline bundles imported by your platform team');
    await expect(licence(page)).toContainText('Ed25519, verified offline');
    await channel(page).locator('button', { hasText: 'Import offline bundle' }).click();
    await expectToast(page, 'Choose a signed .bundle file to import');
    // the page action follows the deployment too
    await expect(ui.pageAction(page, 'Check for updates')).toHaveCount(0);
    await ui.pageAction(page, 'Import offline bundle').click();
    await expectToast(page, 'Choose a signed .bundle file to import');
  });

  test('the licence belongs to the selected organisation', async ({ page }) => {
    await openFw(page);
    await switchOrg(page, 'PT Bank Sentosa Digital');
    await go(page, 'Standards & licence');
    await expect(rows(page)).toHaveCount(2);
    await expect(licence(page)).toContainText('PT Bank Sentosa Digital');
    await expect(meters(page)).toHaveText([/2\s*Frameworks/, /2\s*Management systems/, /86\s*Users/]);
    // Bank Sentosa runs on-premise
    await expect(channel(page)).toContainText('Offline update channel');
  });
});
