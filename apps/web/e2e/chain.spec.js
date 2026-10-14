import {
  test, expect, openApp, go, ui, list, listRows, listRow, chips, chip, chipCount, expectShown, moreButton, search,
  tabs, tab, tabCount, activeTab, drawerAction, drawerFact, drawerLinks, openRow, expectToast, switchMs, switchRole, closeDrawer,
} from './helpers.js';

const hero = (page) => page.locator('main div[style*="background: var(--tx)"]').first();
const heroNum = (page, label) => hero(page).locator('div[style*="text-align: center"]').filter({ hasText: label }).locator('div').first();
const people = (page) => page.locator('main tr[data-hov]');
const person = (page, name) => people(page).filter({ hasText: name });
const statusCol = (page) => listRows(page).locator('td:nth-child(4)');
const ids = (page) => listRows(page).locator('td:nth-child(2) > div > :first-child');

async function openChain(page) {
  await openApp(page);
  await go(page, 'Outstanding items');
}

test.describe('Outstanding items', () => {
  test('hero totals are visible and match the stage tabs', async ({ page }) => {
    await openChain(page);
    await expect(heroNum(page, 'Outstanding items')).toHaveText('63');
    // the open count must be readable on the dark hero, not drawn in the hero background colour
    const [fg, bg] = await Promise.all([
      heroNum(page, 'Outstanding items').evaluate((e) => getComputedStyle(e).color),
      hero(page).evaluate((e) => getComputedStyle(e).backgroundColor),
    ]);
    expect(fg).not.toBe(bg);
    await expect(heroNum(page, 'Overdue / missing')).toHaveText('24');
    await expect(heroNum(page, 'Due after audit date')).toHaveText('16');
    await expect(heroNum(page, 'Records ready')).toHaveText('339');
    await expect(tabs(page)).toHaveCount(8);
    const expected = [['Context issue', 1, '11 / 12 ready'], ['Risk', 5, '33 / 38 ready'], ['Risk treatment', 4, '37 / 41 ready'], ['Control', 28, '65 / 93 ready'], ['SoA', 3, '90 / 93 ready'], ['Document', 8, '14 / 22 ready'], ['Evidence', 10, '69 / 79 ready'], ['Metric', 4, '20 / 24 ready']];
    let sum = 0;
    for (const [label, n, sub] of expected) {
      expect(await tabCount(page, label)).toBe(n);
      await expect(tab(page, label)).toContainText(sub);
      sum += n;
    }
    expect(sum).toBe(63);
    await expect(activeTab(page).locator('div').nth(1)).toHaveText('Context issue');
    await expect(page.locator('main')).toContainText('Auditor is likely to ask');
    await expect(page.locator('main')).toContainText('"How do you know which internal and external issues affect the ISMS?"');
  });

  test('stage tabs switch the list and the auditor question', async ({ page }) => {
    await openChain(page);
    await tab(page, 'Risk treatment').click();
    await expect(activeTab(page).locator('div').nth(1)).toHaveText('Risk treatment');
    await expect(ids(page)).toHaveText(['T-014', 'T-019', 'T-026', 'T-031']);
    await expect(statusCol(page)).toHaveText(['Overdue', 'Pending', 'Pending', 'Missing']);
    await expect(page.locator('main')).toContainText('What was done about it, and is it complete?');
    await tab(page, 'Control').click();
    await expect(listRows(page)).toHaveCount(28);
    await expect(page.locator('main')).toContainText('Which Annex A control implements the treatment?');
    // clicking the active stage keeps it selected
    await tab(page, 'Control').click();
    await expect(activeTab(page).locator('div').nth(1)).toHaveText('Control');
  });

  test('status chips filter a stage: open, pending, overdue, missing, after audit, ready and all', async ({ page }) => {
    await openChain(page);
    await tab(page, 'Control').click();
    await expect(chips(page)).toHaveText([/Open\s*28/, /Pending\s*26/, /Missing\s*2/, /Due after audit\s*13/, /Ready\s*65/, /All\s*93/]);
    await chip(page, 'Pending').click();
    await expectShown(page, 26);
    await expect(statusCol(page)).toHaveText(Array(26).fill('Pending'));
    await chip(page, 'Missing').click();
    await expect(ids(page)).toHaveText(['A.5.23', 'A.8.12']);
    await expect(statusCol(page)).toHaveText(['Missing', 'Missing']);
    await chip(page, 'Due after audit').click();
    await expect(ids(page)).toHaveText(['A.5.7', 'A.5.9', 'A.5.19', 'A.5.21', 'A.5.22', 'A.6.3', 'A.7.4', 'A.7.7', 'A.8.13', 'A.8.15', 'A.8.24', 'A.8.32', 'A.8.33']);
    await expect(listRows(page).locator('td:nth-child(7)')).toHaveText(Array(13).fill(/Due after audit/));
    await chip(page, 'Ready').click();
    await expectShown(page, 30);
    await expect(moreButton(page)).toHaveText('+ 35');
    await expect(statusCol(page)).toHaveText(Array(30).fill('Ready'));
    await chip(page, 'All').click();
    await expect(moreButton(page)).toHaveText('+ 63');
    await chip(page, 'Open').click();
    await expectShown(page, 28);

    await tab(page, 'Document').click();
    await expect(chips(page)).toHaveText([/Open\s*8/, /Pending\s*3/, /Overdue\s*5/, /Ready\s*14/, /All\s*22/]);
    await chip(page, 'Overdue').click();
    await expect(statusCol(page)).toHaveText(Array(5).fill('Overdue'));
    await tab(page, 'Evidence').click();
    await expect(chips(page)).toHaveText([/Open\s*10/, /Overdue\s*8/, /Missing\s*2/, /Ready\s*69/, /All\s*79/]);
    // SoA has no "ready" list of its own
    await tab(page, 'SoA').click();
    await expect(chips(page)).toHaveText([/Open\s*3/, /Pending\s*1/, /Missing\s*2/]);
  });

  test('search filters within the stage', async ({ page }) => {
    await openChain(page);
    await tab(page, 'Control').click();
    await search(page, 'Fajar');
    await expect(listRows(page)).toHaveCount(3);
    await search(page, 'Fajar after');
    await expect(listRows(page)).toHaveCount(0);
    await search(page, 'justification missing');
    await expect(ids(page)).toHaveText(['A.5.23', 'A.8.12']);
    await search(page, '');
    await expectShown(page, 28);
  });

  test('pending per person filters by holder and toggles off', async ({ page }) => {
    await openChain(page);
    await expect(people(page)).toHaveCount(9);
    await expect(person(page, 'Bagus Prasetyo').locator('td')).toHaveText([/Bagus Prasetyo/, '26', '15', '4', '8 Jun 2026', 'Risk, Risk treatment, Control, SoA, Document, Evidence, Metric']);
    await expect(person(page, 'Unassigned').locator('td').nth(1)).toHaveText('2');
    await person(page, 'Bagus Prasetyo').click();
    await expect(page.locator('main')).toContainText('Showing items assigned to Bagus Prasetyo, IT Infrastructure Lead');
    await expect(activeTab(page)).toHaveCount(0);
    await expect(chips(page)).toHaveText([/Open\s*26/, /Pending\s*11/, /Overdue\s*12/, /Missing\s*3/, /Due after audit\s*4/]);
    await expect(listRows(page)).toHaveCount(26);
    // sorted by due date, with the stage shown under each record
    await expect(ids(page).first()).toHaveText('EV-0319');
    await expect(listRows(page).first().locator('[data-tip="Evidence"]')).toHaveCount(1);
    await expect(listRows(page).first()).toContainText('8 Jun 2026');
    await chip(page, 'Overdue').click();
    await expect(listRows(page)).toHaveCount(12);
    await person(page, 'Bagus Prasetyo').click();
    await expect(page.locator('main')).not.toContainText('Showing items assigned to');
    await expect(activeTab(page)).toHaveCount(1);

    await person(page, 'Yusuf Rahman').click();
    await expect(listRows(page)).toHaveCount(10);
    await page.locator('main button[title="Clear"]').click();
    await expect(page.locator('main')).not.toContainText('Showing items assigned to');
    await expect(activeTab(page).locator('div').nth(1)).toHaveText('Context issue');
  });

  test('Remind everyone assigned counts the people who receive a reminder', async ({ page }) => {
    await openChain(page);
    await ui.pageAction(page, 'Remind everyone assigned').click();
    await expect(ui.toast(page)).toHaveText('Reminders sent to 8 people');
    await switchMs(page, 'QMS');
    await ui.pageAction(page, 'Remind everyone assigned').click();
    await expect(ui.toast(page)).toHaveText('Reminders sent to 4 people');
  });

  test('changing a due date past the audit flags the item and updates the counts', async ({ page }) => {
    await openChain(page);
    await tab(page, 'Risk').click();
    expect(await chipCount(page, 'Due after audit')).toBe(1);
    await openRow(page, 'R-022');
    await drawerAction(page, 'Change due date').click();
    const modal = ui.modal(page);
    await expect(modal).toContainText('R-022');
    await expect(modal.locator('select')).toHaveValue('hendra');
    await expect(modal.locator('input[type="date"]')).toHaveValue('2026-10-30');
    await modal.locator('input[type="date"]').fill('2026-12-01');
    await expect(modal).toContainText('This date falls after the audit event');
    await modal.locator('button', { hasText: 'Save' }).click();
    await expectToast(page, 'Item updated. After-audit flag recalculated.');
    await expect(listRow(page, 'R-022')).toContainText('1 Dec 2026');
    await expect(listRow(page, 'R-022')).toContainText('Due after audit');
    expect(await chipCount(page, 'Due after audit')).toBe(2);
    await expect(heroNum(page, 'Due after audit date')).toHaveText('17');
    await expect(person(page, 'Hendra Wijaya').locator('td').nth(3)).toHaveText('1');
    await expect(ui.drawer(page)).toContainText('Due after audit');
    await expect(drawerFact(page, 'Due date')).toHaveText('1 Dec 2026, Due after audit');

    // moving it back before the audit clears the flag
    await drawerAction(page, 'Change due date').click();
    await modal.locator('input[type="date"]').fill('2026-10-30');
    await expect(modal).not.toContainText('This date falls after the audit event');
    await modal.locator('button', { hasText: 'Save' }).click();
    await expect(listRow(page, 'R-022')).not.toContainText('Due after audit');
    expect(await chipCount(page, 'Due after audit')).toBe(1);
    await expect(heroNum(page, 'Due after audit date')).toHaveText('16');
  });

  test('a due date cannot be cleared: Save waits for a date', async ({ page }) => {
    await openChain(page);
    await tab(page, 'Risk').click();
    await openRow(page, 'R-022');
    await drawerAction(page, 'Change due date').click();
    const modal = ui.modal(page);
    const save = modal.locator('button', { hasText: 'Save' });
    await expect(save).toBeEnabled();
    await modal.locator('input[type="date"]').fill('');
    await expect(save).toBeDisabled();
    await save.click({ force: true });
    await expect(modal).toBeVisible();
    await modal.locator('input[type="date"]').fill('2026-10-29');
    await expect(save).toBeEnabled();
    await save.click();
    await expect(ui.modal(page)).toHaveCount(0);
    await expect(listRow(page, 'R-022').locator('td:nth-child(4)')).toHaveText('Pending');
    await expect(listRow(page, 'R-022')).toContainText('29 Oct 2026');
    await expect(chips(page)).toHaveText([/Open\s*5/, /Pending\s*4/, /Overdue\s*1/, /Due after audit\s*1/]);
    await expect(heroNum(page, 'Overdue / missing')).toHaveText('24');
  });

  test('an item without a due date needs one before it can be reassigned', async ({ page }) => {
    await openChain(page);
    await tab(page, 'Risk treatment').click();
    await openRow(page, 'T-031');
    await drawerAction(page, 'Reassign').click();
    await ui.modal(page).locator('select').selectOption('rina');
    await expect(ui.modal(page).locator('button', { hasText: 'Save' })).toBeDisabled();
    await ui.modal(page).locator('input[type="date"]').fill('2026-10-20');
    await expect(ui.modal(page).locator('button', { hasText: 'Save' })).toBeEnabled();
  });

  test('assigning a holder to a missing item turns it into a pending one', async ({ page }) => {
    await openChain(page);
    await tab(page, 'Risk treatment').click();
    await openRow(page, 'T-031');
    await expect(ui.drawer(page)).toContainText('Missing');
    await expect(drawerFact(page, 'Assigned to')).toHaveText('Unassigned, -');
    // without a holder the primary action is Reassign
    await expect(drawerAction(page, 'Reassign')).toHaveCSS('background-color', 'rgb(173, 79, 11)');
    await drawerAction(page, 'Reassign').click();
    await ui.modal(page).locator('select').selectOption('rina');
    await ui.modal(page).locator('input[type="date"]').fill('2026-10-20');
    await ui.modal(page).locator('button', { hasText: 'Save' }).click();
    await expect(listRow(page, 'T-031').locator('td:nth-child(4)')).toHaveText('Pending');
    await expect(listRow(page, 'T-031')).toContainText('Rina Kusuma');
    await expect(chips(page)).toHaveText([/Open\s*4/, /Pending\s*3/, /Overdue\s*1/, /Due after audit\s*1/]);
    await expect(heroNum(page, 'Overdue / missing')).toHaveText('23');
  });

  test('record detail links upstream and downstream', async ({ page }) => {
    await openChain(page);
    await tab(page, 'Risk').click();
    await openRow(page, 'R-014');
    await expect(drawerFact(page, 'Stage')).toHaveText('Risk');
    await expect(drawerFact(page, 'Next action')).toHaveText('Annual reassessment');
    await expect(drawerFact(page, 'Assigned to')).toHaveText('Bagus Prasetyo, IT Infrastructure Lead');
    await expect(drawerFact(page, 'Due date')).toHaveText('10 Sep 2026');
    await expect(ui.drawer(page)).toContainText('Show me how this risk was identified and assessed.');
    await expect(drawerLinks(page, 'Linked from')).toHaveText(['CI-02']);
    await expect(drawerLinks(page, 'Leads to')).toHaveText(['T-014', 'A.8.2']);
    await drawerAction(page, 'Send reminder').click();
    await expectToast(page, 'Reminder sent to Bagus Prasetyo, email + in-app');
    await drawerLinks(page, 'Linked from').click();
    await expect(ui.title(page)).toHaveText('Traceability viewer');
    await expect(page.locator('main input[placeholder^="Enter any ID"]')).toHaveValue('CI-02');
    await expect(page.locator('main')).not.toContainText('No record found');
    await expect(page.locator('main')).toContainText('Dependence on privileged administrators');
  });

  test('ready rows open the control detail', async ({ page }) => {
    await openChain(page);
    await tab(page, 'Control').click();
    await chip(page, 'Ready').click();
    await openRow(page, 'A.5.1');
    await expect(ui.drawer(page)).toContainText('Implemented');
    await expect(drawerFact(page, 'Implementing document')).toContainText('POL-01');
  });

  test('top management sees the chain without the per-person table', async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'Top Management');
    await go(page, 'Outstanding items');
    await expect(listRows(page)).toHaveCount(1);
    await expect(page.locator('main')).not.toContainText('Outstanding by person');
  });

  test('a system without an audit shows the no-audit state with its stages', async ({ page }) => {
    await openChain(page);
    await switchMs(page, 'ABMS');
    await expect(page.locator('main')).toContainText('No audit event scheduled');
    await expect(tabs(page)).toHaveCount(6);
    await expect(activeTab(page).locator('div').nth(1)).toHaveText('Control / requirement');
    await expect(listRows(page)).toHaveCount(30);
    await expect(moreButton(page)).toHaveText('+ 2');
    await expect(people(page)).toHaveCount(2);
  });
});
