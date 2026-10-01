import {
  test, expect, openApp, go, ui, list, listRows, listRow, chips, chip, chipCount, expectShown, moreButton, search,
  drawerAction, drawerFact, openRow, expectToast, switchOrg, closeDrawer,
} from './helpers.js';

const repos = (page) => page.locator('main div[style*="box-shadow"][style*="flex-direction: column"][style*="gap: 10px"]');
const repo = (page, name) => repos(page).filter({ has: page.locator('div', { hasText: new RegExp('^' + name + '$') }) });
const routing = (page) => page.locator('main table').first().locator('tbody > tr');
const ids = (page) => listRows(page).locator('td:nth-child(2) > span:first-child');

async function openStorage(page, query = '') {
  await openApp(page, query);
  await go(page, 'Storage repositories');
}

test.describe('Storage repositories', () => {
  test('repository cards show status, reference health and scope', async ({ page }) => {
    await openStorage(page);
    await expect(repos(page)).toHaveCount(4);
    await expect(repo(page, 'SharePoint Online')).toContainText('Connected');
    await expect(repo(page, 'SharePoint Online')).toContainText('76 / 78 references');
    await expect(repo(page, 'SharePoint Online')).toContainText('2broken');
    await expect(repo(page, 'Google Shared Drive')).toContainText('Degraded');
    await expect(repo(page, 'Google Shared Drive')).toContainText('Delegated token expired 27 Sep 2026: checks paused for 11 references');
    await expect(repo(page, 'Google Shared Drive')).toContainText('0 / 11 references');
    await expect(repo(page, 'Google Shared Drive')).toContainText('11pending');
    await expect(repo(page, 'Managed Vault')).toContainText('Provider cloud, region Jakarta');
    await expect(repo(page, 'Managed Vault')).toContainText('29 / 29 references');
    await expect(repo(page, 'Managed Vault')).toContainText('QMS, ABMS');
    await expect(repo(page, 'OneDrive personal')).toContainText('Flagged');
    await expect(repo(page, 'OneDrive personal')).toContainText('move evidence to the team library');
    await expect(routing(page)).toHaveText([/ISMS.*SharePoint Online.*Link/, /QMS.*Managed Vault.*Upload/, /BCMS.*Google Shared Drive.*Zero-transit/, /ABMS.*Managed Vault.*Upload/]);
  });

  test('repository actions: test connection, re-authorise, move and settings', async ({ page }) => {
    await openStorage(page);
    const titles = (name) => repo(page, name).locator('button[title]').evaluateAll((b) => b.map((x) => x.title));
    expect(await titles('SharePoint Online')).toEqual(['Test connection', 'Settings']);
    expect(await titles('Google Shared Drive')).toEqual(['Re-authorise', 'Test connection', 'Settings']);
    expect(await titles('OneDrive personal')).toEqual(['Move to team library', 'Test connection', 'Settings']);

    await repo(page, 'SharePoint Online').locator('button[title="Test connection"]').click();
    await expect(ui.toast(page)).toHaveText('Connection OK, 78 references reachable, next check 06:00');
    await repo(page, 'Managed Vault').locator('button[title="Test connection"]').click();
    await expect(ui.toast(page)).toHaveText('Connection OK, 29 references reachable, next check 06:00');
    await repo(page, 'Google Shared Drive').locator('button[title="Test connection"]').click();
    await expect(ui.toast(page)).toHaveText('Connection failed: token expired (401)');
    await repo(page, 'Google Shared Drive').locator('button[title="Re-authorise"]').click();
    await expect(ui.toast(page)).toHaveText('Redirecting to Google Workspace consent...');
    await repo(page, 'OneDrive personal').locator('button[title="Move to team library"]').click();
    await expect(ui.toast(page)).toHaveText('Move request sent to Tenant Administrator');
    await repo(page, 'Managed Vault').locator('button[title="Settings"]').click();
    await expect(ui.toast(page)).toHaveText('Connector settings opened');
    await ui.pageAction(page, 'Connect repository').click();
    await expect(ui.toast(page)).toHaveText('Repository connection wizard opened');
  });

  test('integrity chips filter the link health list', async ({ page }) => {
    await openStorage(page);
    await expect(chips(page)).toHaveText([/Needs attention\s*14/, /Version changed\s*1/, /Missing\s*1/, /Access revoked\s*1/, /Check pending\s*11/, /All\s*119/]);
    await expect(chip(page, 'Needs attention')).toHaveAttribute('style', /background: var\(--tx\)/);
    await expect(listRows(page)).toHaveCount(14);
    await expect(ids(page).first()).toHaveText('EV-0124');
    await chip(page, 'Missing').click();
    await expect(ids(page)).toHaveText(['EV-0313']);
    await chip(page, 'Access revoked').click();
    await expect(ids(page)).toHaveText(['EV-0271']);
    await expect(listRow(page, 'EV-0271')).toContainText('OneDrive (personal)');
    await chip(page, 'Check pending').click();
    await expect(listRows(page)).toHaveCount(11);
    await expect(listRows(page).locator('td:nth-child(3)')).toHaveText(Array(11).fill('BCMS'));
    await chip(page, 'All').click();
    await expectShown(page, 30);
    await expect(moreButton(page)).toHaveText('+ 89');
  });

  test('search filters by ID, system and owner', async ({ page }) => {
    await openStorage(page);
    await search(page, 'BCMS');
    await expect(listRows(page)).toHaveCount(11);
    await search(page, 'Fajar');
    await expect(ids(page)).toHaveText(['EV-0271']);
    await search(page, 'nothing');
    await expect(list(page)).toContainText('Nothing matches these filters');
    await search(page, '');
    await expect(listRows(page)).toHaveCount(14);
  });

  test('re-linking a revoked file clears it from the attention list', async ({ page }) => {
    await openStorage(page);
    await openRow(page, 'EV-0271');
    await expect(drawerFact(page, 'Integrity')).toHaveText('Access revoked');
    await expect(drawerFact(page, 'Storage')).toContainText('OneDrive (personal)');
    await drawerAction(page, 'Re-link file').click();
    await ui.modal(page).locator('button', { hasText: 'Link selected file' }).click();
    await expectToast(page, 'Evidence linked');
    await expect(ui.drawer(page)).toHaveCount(0);
    expect(await chipCount(page, 'Needs attention')).toBe(13);
    await expect(chip(page, 'Access revoked')).toHaveCount(0);
    await expect(repo(page, 'OneDrive personal')).toContainText('0 / 0 references');
    await expect(repo(page, 'SharePoint Online')).toContainText('77 / 79 references');
  });

  test('a row from another system opens and traces in that system', async ({ page }) => {
    await openStorage(page);
    await expect(ui.msSwitch(page)).toContainText('ISMS');
    await openRow(page, 'EB-0145');
    await expect(drawerFact(page, 'Control / requirement')).toHaveText('Cl. 8.1, Operational planning and control');
    await expect(drawerFact(page, 'Integrity')).toHaveText('Check pending, Last integrity check 27 Sep 2026 (ok)');
    await drawerAction(page, 'Trace from here').click();
    await expect(ui.title(page)).toHaveText('Golden Thread Viewer');
    await expect(ui.msSwitch(page)).toContainText('BCMS');
    await expect(page.locator('main')).not.toContainText('No record found');
    await expect(page.locator('main input[placeholder^="Enter any ID"]')).toHaveValue('EB-0145');

    await go(page, 'Storage repositories');
    await openRow(page, 'EB-0100');
    await drawerFact(page, 'Control / requirement').locator('button').click();
    await expect(ui.title(page)).toHaveText('Controls & requirements');
    await expect(ui.msSwitch(page)).toContainText('BCMS');
    await expect(ui.drawer(page)).toContainText('Understanding the organization and its context');
  });

  test('on-premise shows the vault as object storage in the customer data centre', async ({ page }) => {
    await openStorage(page, '?deploy=onprem');
    await expect(repo(page, 'Managed Vault')).toContainText('Object storage in your data centre');
  });

  test('an organisation only sees the repositories its systems use', async ({ page }) => {
    await openApp(page);
    await switchOrg(page, 'PT Bank Sentosa Digital');
    await go(page, 'Storage repositories');
    await expect(repos(page)).toHaveCount(3);
    await expect(repo(page, 'Google Shared Drive')).toHaveCount(0);
    await expect(repo(page, 'Managed Vault')).toContainText('Object storage in your data centre');
    await expect(repo(page, 'Managed Vault')).toContainText('27 / 27 references');
    await expect(routing(page)).toHaveCount(2);
    await expect(chips(page)).toHaveText([/Needs attention\s*3/, /Version changed\s*1/, /Missing\s*1/, /Access revoked\s*1/, /All\s*106/]);
  });
});
