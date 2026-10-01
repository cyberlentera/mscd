import {
  test, expect, openApp, go, ui, switchRole, expectToast, activeTab, listRow, listRows, drawerFact, tab, tabCount,
} from './helpers.js';

const tasks = (page) => page.locator('main div[style*="grid-template-columns: 4px 44px"]');
const task = (page, id) => tasks(page).filter({ has: page.locator('span', { hasText: new RegExp('^' + id.replace('.', '\\.') + '$') }) });
const filters = (page) => page.locator('main button[style*="height: 28px"][style*="border-radius: 999px"]');
const filter = (page, label) => filters(page).filter({ hasText: new RegExp('^' + label + '\\s*\\d+$') });
const systems = (page) => page.locator('main > div button[style*="height: 30px"]');
const days = (page) => page.locator('main div[style*="repeat(7,minmax(0,1fr))"] > div, main div[style*="repeat(7, minmax(0px, 1fr))"] > div');
const hero = (page) => page.locator('main div[style*="background: rgb(28, 26, 23)"]').first();
const navBadge = (page) => page.locator('aside nav button[title="My Tasks"] > span:last-child');
const isActive = (l) => expect(l).toHaveAttribute('style', /background: var\(--tx\)/);

test.describe('My Tasks', () => {
  test('lists the MS Manager’s tasks with counts, ring and week strip', async ({ page }) => {
    await openApp(page);
    await go(page, 'My Tasks');
    await expect(page.locator('main h1 + div')).toHaveText('3 items');
    await expect(tasks(page)).toHaveCount(3);
    await expect(filters(page)).toHaveText([/All\s*3/, /Overdue\s*0/, /Due this week\s*1/, /Later\s*2/]);
    await isActive(filter(page, 'All'));
    await expect(systems(page)).toHaveText([/ISMS\s*3/]);
    await expect(hero(page)).toContainText('29 Sep 2026');
    await expect(hero(page)).toContainText('100%');
    await expect(hero(page)).toContainText('Nothing is overdue. 1 due this week, 2 later.');
    await expect(page.locator('main')).toContainText('28 Sep 2026 to 4 Oct 2026');
    await expect(days(page)).toHaveCount(7);
    await expect(days(page).locator('span:nth-child(1)')).toHaveText(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    await expect(days(page).locator('span:nth-child(2)')).toHaveText(['28', '29', '30', '1', '2', '3', '4']);
    await expect(days(page).nth(1)).toHaveAttribute('style', /var\(--accbg\)/);
    await expect(task(page, 'A.5.12')).toContainText('Finish setting up classification of information');
    await expect(task(page, 'A.5.12')).toContainText('5 Oct 2026');
    await expect(task(page, 'R-031')).toContainText('Missing');
    await expect(navBadge(page)).toHaveText('3');
  });

  test('Mark done on a control removes the task and updates every count', async ({ page }) => {
    await openApp(page);
    await go(page, 'My Tasks');
    await task(page, 'A.5.12').locator('button', { hasText: 'Mark done' }).click();
    await expectToast(page, 'Marked complete: awaiting verification by the MS Manager');
    // completed controls wait for someone else to verify them, so they leave the list
    await expect(task(page, 'A.5.12')).toHaveCount(0);
    await expect(filters(page)).toHaveText([/All\s*2/, /Overdue\s*0/, /Due this week\s*0/, /Later\s*2/]);
    await expect(hero(page)).toContainText('Nothing is overdue. 0 due this week, 2 later.');
    await expect(navBadge(page)).toHaveText('2');
    await task(page, 'A.5.35').locator('button', { hasText: 'Mark done' }).click();
    await expect(tasks(page)).toHaveCount(1);
    await expect(page.locator('main h1 + div')).toHaveText('1 item');
    await expect(navBadge(page)).toHaveText('1');
    await go(page, 'Controls & requirements');
    await page.locator('main button[style*="flex: 1 1 0"]').filter({ hasText: 'Partially implemented' }).click();
    await expect(listRow(page, 'A.5.12').locator('td:nth-child(4)')).toHaveText('Complete, awaiting verification');
  });

  test('a record that holds the gate opens its gate item and every gate count stays the same', async ({ page }) => {
    await openApp(page);
    await go(page, 'My Tasks');
    const t = task(page, 'R-031');
    await expect(t).toContainText('Select a treatment: no treatment linked');
    // closing it here would drop it from the chain while the gate views still count it
    await expect(t.locator('button')).toHaveText('Open gate item');
    await expect(t.locator('button', { hasText: 'Mark done' })).toHaveCount(0);
    await t.locator('button').click();
    await expect(ui.title(page)).toHaveText('Controls & requirements');
    await expect(activeTab(page)).toContainText('Open gate items, Risk & SoA');
    await expect(activeTab(page).locator('span').first()).toHaveText('4');
    await expect(ui.drawer(page)).toContainText('R-031');
    await expect(drawerFact(page, 'Pending action')).toHaveText('Select a treatment: no treatment linked');
    await expect(listRows(page).locator('td:nth-child(2)')).toHaveText(['A.5.23', 'A.8.12', 'R-031', 'SOA-01']);
    await expect(page.locator('aside nav button[title="Controls & requirements"] > span:last-child')).toHaveText('4');

    // the chain, the overview, the phase board and the portfolio all still count it
    await go(page, 'Chain stages');
    await tab(page, 'Risk').click();
    expect(await tabCount(page, 'Risk')).toBe(5);
    await expect(tab(page, 'Risk')).toContainText('33 / 38 ready');
    await expect(listRow(page, 'R-031')).toBeVisible();
    await go(page, 'Overview');
    await expect(page.locator('main button[style*="grid-template-columns: 110px 1fr 220px 150px"]').filter({ hasText: 'R-031' })).toHaveCount(1);
    await go(page, 'Phase board');
    await expect(page.locator('main')).toContainText('4 blocked, 4 open gate items.');
    await go(page, 'Portfolio Overview');
    await expect(page.locator('main button[style*="grid-template-columns: 46px"]').filter({ hasText: '4 open gate items, Risk & SoA' })).toContainText('A.5.23, A.8.12, R-031, SOA-01');
    await go(page, 'My Tasks');
    await expect(tasks(page)).toHaveCount(3);
  });

  test('Mark done on a record that does not hold a gate closes it in the chain', async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'Top Management');
    await go(page, 'My Tasks');
    await expect(tasks(page)).toHaveCount(3);
    // the SoA approval holds the gate; the risk acceptance does not
    await expect(tasks(page).filter({ hasText: 'Approve revised SoA' }).locator('button')).toHaveText('Open gate item');
    await expect(task(page, 'R-022').locator('button')).toHaveText('Mark done');
    await task(page, 'R-022').locator('button').click();
    await expectToast(page, 'Item updated. After-audit flag recalculated.');
    await expect(task(page, 'R-022')).toHaveCount(0);
    await expect(tasks(page)).toHaveCount(2);
    await go(page, 'Chain stages');
    expect(await tabCount(page, 'Risk')).toBe(4);
    await expect(tab(page, 'Risk')).toContainText('34 / 38 ready');
  });

  test('a domain owner filters by urgency and by system', async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'Domain Owner');
    await expect(ui.title(page)).toHaveText('My Tasks');
    await expect(tasks(page)).toHaveCount(31);
    await expect(filters(page)).toHaveText([/All\s*31/, /Overdue\s*15/, /Due this week\s*1/, /Later\s*15/]);
    await expect(systems(page)).toHaveText([/ISMS\s*26/, /BCMS\s*5/]);
    await expect(hero(page)).toContainText('52%');
    await expect(hero(page)).toContainText('15 overdue tasks need attention first. 1 due this week, 15 later.');
    // sorted by due date, most overdue first
    await expect(tasks(page).first()).toContainText('EV-0319');
    await expect(tasks(page).first()).toContainText('Overdue 113d');

    await filter(page, 'Overdue').click();
    await isActive(filter(page, 'Overdue'));
    await expect(tasks(page)).toHaveCount(15);
    await filter(page, 'Due this week').click();
    await expect(tasks(page)).toHaveCount(1);
    await expect(tasks(page).first()).toContainText('A.8.16');
    await filter(page, 'Later').click();
    await expect(tasks(page)).toHaveCount(15);
    await systems(page).filter({ hasText: 'BCMS' }).click();
    await expect(tasks(page)).toHaveCount(5);
    await expect(systems(page).filter({ hasText: 'BCMS' })).toHaveAttribute('style', /rgba\(255, 255, 255, 0\.14\)/);
    await systems(page).filter({ hasText: 'BCMS' }).click();
    await expect(tasks(page)).toHaveCount(31);
    await isActive(filter(page, 'All'));
  });

  test('the week strip marks overdue work and due dates', async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'Domain Owner');
    const dots = (i) => days(page).nth(i).locator('span:nth-child(3) > span');
    await expect(dots(0)).toHaveCount(1);
    await expect(dots(0)).toHaveCSS('background-color', 'rgb(191, 47, 37)');
    await expect(dots(4)).toHaveCount(1);
    await expect(dots(4)).toHaveCSS('background-color', 'rgb(138, 101, 8)');
    await expect(dots(2)).toHaveCount(0);
  });

  test('evidence tasks submit through the repository picker and leave the list', async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'Domain Owner');
    await expect(task(page, 'EV-0313')).toContainText('Re-link the file for backup job log & restore test');
    await task(page, 'EV-0313').locator('button', { hasText: 'Submit' }).click();
    await expect(ui.modal(page)).toContainText('Select evidence file from repository');
    await ui.modal(page).locator('button', { hasText: 'Backup-Job-Log-Sep-2026.xlsx' }).click();
    await ui.modal(page).locator('button', { hasText: 'Link selected file' }).click();
    await expectToast(page, 'Evidence linked');
    await expect(task(page, 'EV-0313')).toHaveCount(0);
    await expect(filters(page)).toHaveText([/All\s*30/, /Overdue\s*14/, /Due this week\s*1/, /Later\s*15/]);
  });

  test('document tasks start the review and then offer to open the document', async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'Domain Owner');
    const t = task(page, 'STD-04');
    await expect(t.locator('button')).toHaveText('Start review');
    await t.locator('button').click();
    await expectToast(page, 'Opening STD-04');
    await expect(t.locator('button')).toHaveText('Open document');
  });

  test('a control that holds a gate opens its gate item instead of being marked done', async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'Domain Owner');
    const t = tasks(page).filter({ hasText: 'Resolve the gate item for data leakage prevention' });
    await expect(t).toHaveCount(1);
    await expect(t.locator('button')).toHaveText('Open gate item');
    await t.locator('button').click();
    await expect(ui.title(page)).toHaveText('Controls & requirements');
    await expect(activeTab(page)).toContainText('Open gate items');
    await expect(ui.drawer(page)).toContainText('A.8.12');
    await expect(drawerFact(page, 'Justification')).toHaveText('-');
  });

  test('top management and the auditor see their own tasks', async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'Top Management');
    await go(page, 'My Tasks');
    await expect(tasks(page)).toHaveCount(3);
    await expect(tasks(page).first()).toContainText('SOA-01');
    await switchRole(page, 'Internal Auditor');
    await expect(tasks(page)).toHaveCount(1);
    await expect(tasks(page).first()).toContainText('BCMS');
    await expect(tasks(page).first()).toContainText('Finish setting up internal audit');
  });

  test('a filter for a system the new role does not have is reset', async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'Domain Owner');
    await systems(page).filter({ hasText: 'BCMS' }).click();
    await expect(tasks(page)).toHaveCount(5);
    await switchRole(page, 'Top Management');
    await go(page, 'My Tasks');
    await expect(tasks(page)).toHaveCount(3);
    await isActive(filter(page, 'All'));
  });
});
