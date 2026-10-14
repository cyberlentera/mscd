import {
  test, expect, openApp, go, ui, list, listRows, listRow, groupRows, chips, chip, chipCount, expectShown, search,
  drawerAction, drawerFact, drawerLinks, openRow, expectToast, switchMs, closeDrawer,
} from './helpers.js';

const ids = (page) => listRows(page).locator('td:nth-child(2) > div > :first-child');

async function openRegister(page) {
  await openApp(page);
  await go(page, 'Document register');
}

test.describe('Document register', () => {
  test('groups documents by tier with status chips', async ({ page }) => {
    await openRegister(page);
    await expect(chips(page)).toHaveText([/All\s*22/, /Approved\s*14/, /Expired\s*5/, /In review\s*1/, /Draft\s*2/]);
    await expect(chip(page, 'All')).toHaveAttribute('style', /background: var\(--tx\)/);
    await expect(groupRows(page)).toHaveText([/Policies\s*2/, /Standards\s*3/, /Procedures\s*14/, /Plans\s*1/, /Registers\s*2/]);
    await expect(listRows(page)).toHaveCount(22);
    await expectShown(page, 22);
    await expect(ids(page).first()).toHaveText('POL-01');
    await expect(listRow(page, 'IMS-01')).toContainText('Shared');
    await expect(listRow(page, 'PRC-07')).toContainText('Expired');
    await expect(listRow(page, 'PRC-07')).toContainText('Overdue 5d');
  });

  test('chips filter the register and keep the tier groups', async ({ page }) => {
    await openRegister(page);
    await chip(page, 'Expired').click();
    await expect(listRows(page)).toHaveCount(5);
    await expect(groupRows(page)).toHaveText([/Standards\s*1/, /Procedures\s*3/, /Registers\s*1/]);
    await expect(ids(page)).toHaveText(['STD-04', 'PRC-07', 'PRC-11', 'PRC-15', 'REG-03']);
    await chip(page, 'Draft').click();
    await expect(ids(page)).toHaveText(['PRC-16', 'SOA-01']);
    await chip(page, 'In review').click();
    await expect(ids(page)).toHaveText(['PLN-02']);
    await chip(page, 'Approved').click();
    await expect(listRows(page)).toHaveCount(14);
    await chip(page, 'All').click();
    await expect(listRows(page)).toHaveCount(22);
  });

  test('search matches ID, title and owner and clearing restores the list', async ({ page }) => {
    await openRegister(page);
    await search(page, 'IMS-0');
    await expect(ids(page)).toHaveText(['IMS-01', 'IMS-02', 'IMS-03', 'IMS-04']);
    await expect(groupRows(page)).toHaveText([/Procedures\s*4/]);
    await search(page, 'Hendra');
    await expect(listRows(page)).toHaveCount(4);
    await search(page, 'backup restore');
    await expect(ids(page)).toHaveText(['PRC-11']);
    await search(page, 'zzz');
    await expect(list(page)).toContainText('Nothing matches these filters');
    await expect(groupRows(page)).toHaveCount(0);
    await search(page, '');
    await expect(listRows(page)).toHaveCount(22);
  });

  test('document detail shows facts, controls that use it and orphan candidates', async ({ page }) => {
    await openRegister(page);
    await openRow(page, 'IMS-01');
    await expect(ui.drawer(page)).toContainText('Document Control Procedure');
    await expect(ui.drawer(page)).toContainText('Shared, IMS');
    await expect(drawerFact(page, 'Tier')).toHaveText('Procedure');
    await expect(drawerFact(page, 'Version')).toHaveText('v3.0');
    await expect(drawerFact(page, 'Owner')).toHaveText('Rina Kusuma, ISMS Manager');
    await expect(drawerFact(page, 'Approver')).toHaveText('Hendra Wijaya');
    await expect(drawerFact(page, 'Used by')).toHaveText('ISMS, QMS, BCMS, ABMS (shared IMS document)');
    await expect(drawerLinks(page, 'Linked from')).toHaveText(['A.5.2', 'A.5.3', 'A.5.4', 'A.5.31', 'A.5.32', 'A.5.33']);
    await closeDrawer(page);

    await openRow(page, 'POL-14');
    await expect(ui.drawer(page)).toContainText('Orphan candidate');
    await expect(ui.drawer(page)).toContainText('Not linked to any control or requirement');
    await closeDrawer(page);

    await openRow(page, 'SOA-01');
    await expect(ui.drawer(page)).toContainText('Draft');
    await expect(ui.drawer(page).locator('span[data-tip^="Draft: not yet a controlled document"]')).toHaveCount(1);
    await drawerAction(page, 'Continue draft').click();
    await expectToast(page, 'Opening SOA-01 v3.0: draft editor');
  });

  test('a control linked from a document opens in Annex A controls', async ({ page }) => {
    await openRegister(page);
    await openRow(page, 'IMS-01');
    await drawerLinks(page, 'Linked from').filter({ hasText: 'A.5.33' }).click();
    await expect(ui.title(page)).toHaveText('Annex A controls');
    await expect(ui.drawer(page)).toContainText('A.5.33');
    await expect(ui.drawer(page)).toContainText('Protection of records');
  });

  test('Start review from the register keeps the document visible with its new status', async ({ page }) => {
    await openRegister(page);
    await openRow(page, 'STD-04');
    await drawerAction(page, 'Start review').click();
    await expectToast(page, 'STD-04, review started: assigned to Bagus Prasetyo');
    await expect(ui.drawer(page)).toContainText('In review');
    await expect(drawerAction(page, 'Open review')).toHaveCount(1);
    await expect(listRow(page, 'STD-04').locator('td:nth-child(4)')).toHaveText('In review');
    expect(await chipCount(page, 'Expired')).toBe(4);
    expect(await chipCount(page, 'In review')).toBe(2);
    await go(page, 'Annex A controls');
    await expect(page.locator('main button[style*="flex: 1 1 0"]').filter({ hasText: 'Documents expired' }).locator('span').first()).toHaveText('4');
  });

  test('reminder and trace actions', async ({ page }) => {
    await openRegister(page);
    await openRow(page, 'PRC-16');
    await drawerAction(page, 'Send reminder').click();
    await expectToast(page, 'Reminder sent to Yusuf Rahman');
    await drawerAction(page, 'Trace from here').click();
    await expect(ui.title(page)).toHaveText('Traceability viewer');
    await expect(page.locator('main input[placeholder^="Enter any ID"]')).toHaveValue('PRC-16');
    await expect(page.locator('main')).toContainText('Secure Development Procedure');
  });

  test('page actions confirm with toasts', async ({ page }) => {
    await openRegister(page);
    await ui.pageAction(page, 'Export').click();
    await expectToast(page, 'Document register exported (xlsx)');
    await ui.pageAction(page, 'New document').click();
    await expectToast(page, 'New document form opened');
  });

  test('each management system has its own register', async ({ page }) => {
    await openRegister(page);
    await switchMs(page, 'QMS');
    await expect(chips(page)).toHaveText([/All\s*10/, /Approved\s*7/, /Expired\s*1/, /In review\s*1/, /Draft\s*1/]);
    await switchMs(page, 'BCMS');
    await expect(chips(page)).toHaveText([/All\s*8/, /Approved\s*6/, /Draft\s*2/]);
    await switchMs(page, 'ABMS');
    await expect(listRows(page)).toHaveCount(5);
  });
});
