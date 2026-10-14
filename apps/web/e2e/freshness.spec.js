import {
  test, expect, openApp, go, ui, list, listRows, listRow, expectShown, moreButton, search, tabs, tab, tabCount, activeTab,
  drawerAction, drawerFact, openRow, expectToast, switchMs, switchRole, closeDrawer,
} from './helpers.js';

const freqRows = (page) => page.locator('main button[style*="grid-template-columns: 110px 1fr 120px"]');
const freq = (page, label) => freqRows(page).filter({ has: page.locator('span', { hasText: new RegExp('^' + label + '$') }) });
const donut = (page) => page.locator('main svg[viewBox="0 0 44 44"]');
const ids = (page) => listRows(page).locator('td:nth-child(2) > div > :first-child');
const freshCol = (page) => listRows(page).locator('td:nth-child(7)');

async function openFresh(page) {
  await openApp(page);
  await go(page, 'Evidence status');
}

test.describe('Evidence status', () => {
  test('tabs count evidence by freshness and filter the list, toggling off on a second click', async ({ page }) => {
    await openFresh(page);
    await expect(tabs(page)).toHaveCount(6);
    for (const [label, n] of [['Fresh', 64], ['Aging', 6], ['Expired', 6], ['Critical', 3], ['File cannot be verified', 3], ['Documents due in 30 days', 10]]) {
      expect(await tabCount(page, label)).toBe(n);
    }
    await expect(tab(page, 'Fresh')).toContainText('of 79');
    await expect(activeTab(page)).toHaveCount(0);
    await expectShown(page, 30);
    await expect(moreButton(page)).toHaveText('+ 49');
    // problems first: unverifiable files, then critical, expired, aging
    await expect(ids(page).nth(0)).toHaveText('EV-0313');
    await expect(ids(page).nth(1)).toHaveText('EV-0271');
    await expect(ids(page).nth(2)).toHaveText('EV-0124');

    await tab(page, 'Critical').click();
    await expect(ids(page)).toHaveText(['EV-0313', 'EV-0319', 'EV-0292']);
    await expect(freshCol(page)).toHaveText(['Critical', 'Critical', 'Critical']);
    await tab(page, 'Critical').click();
    await expect(activeTab(page)).toHaveCount(0);
    await expect(moreButton(page)).toHaveText('+ 49');

    await tab(page, 'File cannot be verified').click();
    await expect(ids(page)).toHaveText(['EV-0313', 'EV-0271', 'EV-0124']);
    await expect(listRows(page).locator('td:nth-child(8)')).toHaveText([/Missing/, /Access revoked/, /Version changed/]);
    await tab(page, 'Expired').click();
    await expect(listRows(page)).toHaveCount(6);
    await tab(page, 'Aging').click();
    await expect(freshCol(page)).toHaveText(Array(6).fill('Aging'));
  });

  test('switching tabs starts the list again from the first page', async ({ page }) => {
    await openFresh(page);
    await expect(moreButton(page)).toHaveText('+ 49');
    await moreButton(page).click();
    await expect(listRows(page)).toHaveCount(60);
    await expect(moreButton(page)).toHaveText('+ 19');
    await tab(page, 'Fresh').click();
    await expect(listRows(page)).toHaveCount(30);
    await expect(moreButton(page)).toHaveText('+ 34');
    await moreButton(page).click();
    await expect(listRows(page)).toHaveCount(60);
    await tab(page, 'Aging').click();
    await expect(listRows(page)).toHaveCount(6);
    await tab(page, 'Aging').click();
    await expect(listRows(page)).toHaveCount(30);
    await expect(moreButton(page)).toHaveText('+ 49');
  });

  test('frequency rows filter by operating frequency and toggle off', async ({ page }) => {
    await openFresh(page);
    await expect(freqRows(page)).toHaveCount(7);
    await expect(freq(page, 'Daily')).toContainText('2, 1 expired');
    await expect(freq(page, 'Monthly')).toContainText('4, 3 expired');
    await expect(freq(page, 'Quarterly')).toContainText('21, 4 expired');
    await expect(freq(page, 'Annual')).toContainText('32, 0 expired');
    await expect(freq(page, 'Per event')).toContainText('18, 0 expired');
    await freq(page, 'Monthly').click();
    await expect(freq(page, 'Monthly')).toHaveAttribute('style', /var\(--accbg\)/);
    await expect(ids(page)).toHaveText(['EV-0313', 'EV-0292', 'EV-0298', 'EV-0238']);
    await expect(listRows(page).locator('td:nth-child(4)')).toHaveText(Array(4).fill('Monthly'));
    // combined with a freshness tab
    await tab(page, 'Expired').click();
    await expect(ids(page)).toHaveText(['EV-0298']);
    await tab(page, 'Expired').click();
    await freq(page, 'Monthly').click();
    await expect(freq(page, 'Monthly')).not.toHaveAttribute('style', /var\(--accbg\)/);
    await expectShown(page, 30);
    await freq(page, 'Weekly').click();
    await expect(listRows(page)).toHaveCount(0);
    await expect(list(page)).toContainText('Nothing matches these filters');
  });

  test('donut renders the four freshness shares around the full circle', async ({ page }) => {
    await openFresh(page);
    await expect(donut(page)).toBeVisible();
    const circles = donut(page).locator('circle');
    await expect(circles).toHaveCount(5);
    const dashes = await circles.evaluateAll((cs) => cs.slice(1).map((c) => c.getAttribute('stroke-dasharray').split(' ').map(Number)));
    const C = 2 * Math.PI * 17;
    const drawn = dashes.reduce((a, [len]) => a + len, 0);
    expect(drawn).toBeCloseTo(C, 1);
    // 64 of 79 fresh
    expect(dashes[0][0] / C).toBeCloseTo(64 / 79, 2);
    expect(await circles.nth(4).getAttribute('stroke-dashoffset')).toBe('-102.76');
  });

  // @sample-only: the API picker lists the repository folder instead of the sample picker files (WP-25 deviation 3); e2e/api-only/commands.spec.js covers picker linking.
  test('re-linking an unverifiable file through the SharePoint picker verifies it', { tag: '@sample-only' }, async ({ page }) => {
    await openFresh(page);
    await tab(page, 'File cannot be verified').click();
    await openRow(page, 'EV-0124');
    await expect(drawerFact(page, 'Integrity')).toHaveText('Version changed');
    await expect(ui.drawer(page).locator('span[data-tip^="The pinned version cannot be verified"]')).toHaveCount(1);
    await drawerAction(page, 'Re-link file').click();
    const modal = ui.modal(page);
    await expect(modal).toContainText('Select evidence file from repository');
    await expect(modal).toContainText('Compliance / ISMS / Evidence / 2026 / Q3');
    await modal.locator('button', { hasText: 'Access-Review-Q3-2026.xlsx' }).click();
    await modal.locator('button', { hasText: 'Link selected file' }).click();
    await expectToast(page, 'Evidence linked: version pinned, hash recorded, Access-Review-Q3-2026.xlsx, v2.0');
    // it left the "cannot be verified" list
    await expect(ui.drawer(page)).toHaveCount(0);
    expect(await tabCount(page, 'File cannot be verified')).toBe(2);
    expect(await tabCount(page, 'Fresh')).toBe(65);
    await tab(page, 'File cannot be verified').click();
    await search(page, 'EV-0124');
    await expect(listRows(page)).toHaveCount(1);
    await expect(freshCol(page)).toHaveText(['Fresh']);
    await expect(listRows(page).locator('td:nth-child(8)')).toHaveAttribute('data-tip', /Verified/);
    await openRow(page, 'EV-0124');
    await expect(drawerFact(page, 'Produced')).toHaveText('29 Sep 2026 (0 d)');
    await expect(drawerFact(page, 'Pinned version')).toHaveText('v2.0');
    await expect(drawerFact(page, 'Integrity')).toHaveText('Verified');
    await expect(drawerAction(page, 'Submit evidence')).toHaveCount(1);
  });

  // @sample-only: the demo BCMS Shared Drive credential has expired (G.8 fixture), so the API picker answers with the repository error.
  test('the Google Shared Drive picker links files with or without a content hash', { tag: '@sample-only' }, async ({ page }) => {
    await openFresh(page);
    await switchMs(page, 'BCMS');
    await openRow(page, 'EB-0145');
    await expect(drawerFact(page, 'Integrity')).toContainText('Check pending');
    await drawerAction(page, 'Submit evidence').click();
    const modal = ui.modal(page);
    await expect(modal).toContainText('Compliance BCMS / Evidence / 2026');
    await expect(modal.locator('button[style*="grid-template-columns: 1fr auto"]')).toHaveCount(3);
    await expect(modal.locator('button', { hasText: 'BIA-Workshop-Notes-Sep.gdoc' })).toContainText('no hash');
    await modal.locator('button', { hasText: 'Link selected file' }).click();
    await expectToast(page, 'BIA-Workshop-Notes-Sep.gdoc, rev 7');
    await expect(drawerFact(page, 'Integrity')).toHaveText('No hash (Google Doc)');
    await expect(drawerFact(page, 'Pinned version')).toHaveText('rev 7');

    await drawerAction(page, 'Submit evidence').click();
    await modal.locator('button', { hasText: 'Prioritised-Activities-v1.xlsx' }).click();
    await modal.locator('button', { hasText: 'Link selected file' }).click();
    await expect(drawerFact(page, 'Integrity')).toHaveText('Verified');
    await expect(drawerFact(page, 'Fingerprint')).toContainText('SHA-256');
  });

  // @sample-only: in API mode the upload sends a real file chosen in the file dialog (A.4 5.10); e2e/api-only/commands.spec.js covers it.
  test('Managed Vault evidence is uploaded instead of picked', { tag: '@sample-only' }, async ({ page }) => {
    await openFresh(page);
    await switchMs(page, 'QMS');
    expect(await tabCount(page, 'Expired')).toBe(3);
    await tab(page, 'Expired').click();
    await openRow(page, 'EQ-0154');
    await expect(drawerFact(page, 'Storage')).toHaveText('Managed Vault, /vault/QMS/Cl84');
    await expect(drawerFact(page, 'Pinned version')).toHaveText('v1');
    await drawerAction(page, 'Submit evidence').click();
    const modal = ui.modal(page);
    await expect(modal).toContainText('Submit evidence');
    await expect(modal).toContainText('Managed Vault: the file is uploaded, versioned and SHA-256 checksummed by the application.');
    await expect(modal).toContainText('Drop a file here or browse');
    await modal.locator('button', { hasText: 'Upload to Managed Vault' }).click();
    await expectToast(page, 'Evidence uploaded to Managed Vault: SHA-256 recorded');
    expect(await tabCount(page, 'Expired')).toBe(2);
    await tab(page, 'Expired').click();
    await search(page, 'EQ-0154');
    await openRow(page, 'EQ-0154');
    await expect(drawerFact(page, 'Pinned version')).toHaveText('v2');
    await expect(drawerFact(page, 'Produced')).toHaveText('29 Sep 2026 (0 d)');
    await expect(ui.drawer(page)).toContainText('Fresh');
  });

  test('documents due in 30 days use the register columns and open document detail', async ({ page }) => {
    await openFresh(page);
    await tab(page, 'Documents due in 30 days').click();
    await expect(list(page).locator('thead th')).toHaveText(['', 'ID', 'Title & status note', 'Status', 'Owner', 'Version', 'Approved on', 'Review due', 'File location']);
    await expect(ids(page)).toHaveText(['STD-04', 'PRC-11', 'REG-03', 'PRC-15', 'PRC-07', 'IMS-04', 'STD-05', 'SOA-01', 'PRC-16', 'IMS-02']);
    await expect(freqRows(page)).toHaveCount(7);
    await openRow(page, 'STD-05');
    await expect(drawerFact(page, 'Review due')).toHaveText('14 Oct 2026');
    await drawerAction(page, 'Send reminder').click();
    await expectToast(page, 'Reminder sent to Bagus Prasetyo');
  });

  test('evidence detail explains the freshness rule and links to its control', async ({ page }) => {
    await openFresh(page);
    // the evidence title and its control's title stay visible next to their codes, with the full text in the popover
    const row = listRow(page, 'EV-0124');
    await expect(row.locator('td:nth-child(2)').getByText('Asset register export', { exact: true })).toBeVisible();
    await expect(row.locator('td:nth-child(3)').getByText('Inventory of information and other associated assets', { exact: true })).toBeVisible();
    await expect(row.locator('td:nth-child(3)')).toHaveAttribute('data-tip', 'Inventory of information and other associated assets');
    // a cell with a popover keeps the row's pointer: the whole row opens on click
    await expect(row.locator('td:nth-child(3)')).toHaveCSS('cursor', 'pointer');
    await openRow(page, 'EV-0124');
    await expect(drawerFact(page, 'Freshness rule')).toHaveText('Quarterly, Fresh ≤ 92 d, Aging ≤ 115 d, Expired ≤ 182 d, Critical > 182 d');
    await expect(drawerFact(page, 'Produced')).toHaveText('20 Jun 2026 (101 d)');
    await expect(drawerFact(page, 'Next due')).toHaveText('19 Sep 2026');
    await drawerAction(page, 'Reassign').click();
    await expect(ui.modal(page).locator('input[type="date"]')).toHaveValue('2026-09-19');
    await ui.modal(page).locator('select').selectOption('fajar');
    await ui.modal(page).locator('input[type="date"]').fill('2026-10-10');
    await ui.modal(page).locator('button', { hasText: 'Save' }).click();
    await expect(drawerFact(page, 'Owner')).toHaveText('Fajar Nugroho, Facilities Manager');
    await expect(drawerFact(page, 'Next due')).toHaveText('10 Oct 2026');
    await expect(listRow(page, 'EV-0124')).toContainText('Fajar Nugroho');
    await drawerFact(page, 'Control / requirement').locator('button').click();
    await expect(ui.title(page)).toHaveText('Annex A controls');
    await expect(ui.drawer(page)).toContainText('A.5.9');
  });

  // @sample-only: the API picker lists the repository folder instead of the sample picker files (WP-25 deviation 3).
  test('new evidence restarts the cycle even after the due date was changed by hand', { tag: '@sample-only' }, async ({ page }) => {
    await openFresh(page);
    await openRow(page, 'EV-0124');
    await drawerAction(page, 'Reassign').click();
    await ui.modal(page).locator('input[type="date"]').fill('2026-10-10');
    await ui.modal(page).locator('button', { hasText: 'Save' }).click();
    await expect(drawerFact(page, 'Next due')).toHaveText('10 Oct 2026');
    await drawerAction(page, 'Re-link file').click();
    await ui.modal(page).locator('button', { hasText: 'Link selected file' }).click();
    await expectToast(page, 'Evidence linked');
    await expect(drawerFact(page, 'Produced')).toHaveText('29 Sep 2026 (0 d)');
    // quarterly evidence produced today is next due in 91 days
    await expect(drawerFact(page, 'Next due')).toHaveText('29 Dec 2026');
    await closeDrawer(page);
    await search(page, 'EV-0124');
    await expect(listRow(page, 'EV-0124').locator('td:nth-child(6)')).toHaveText('29 Dec 2026');
  });

  // @sample-only: in API mode the count is the number of references the api queued (H.4 runCheck, WP-25 follow-up), not the sample's evidence count.
  test('Run integrity check counts the active system’s references', { tag: '@sample-only' }, async ({ page }) => {
    await openFresh(page);
    await ui.pageAction(page, 'Run integrity check').click();
    await expect(ui.toast(page)).toHaveText('Integrity check started for 79 references');
    await switchMs(page, 'ABMS');
    await ui.pageAction(page, 'Run integrity check').click();
    await expect(ui.toast(page)).toHaveText('Integrity check started for 2 references');
    expect(await tabCount(page, 'Expired')).toBe(2);
  });

  test('a domain owner only sees their own evidence', async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'Domain Owner');
    await go(page, 'Evidence status');
    expect(await tabCount(page, 'Fresh')).toBe(19);
    expect(await tabCount(page, 'Critical')).toBe(3);
    await expectShown(page, 27);
    await expect(listRows(page).locator('td:nth-child(9)')).toHaveText(Array(27).fill(/Bagus Prasetyo/));
  });
});
