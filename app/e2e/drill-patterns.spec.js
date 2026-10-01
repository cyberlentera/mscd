import {
  test, expect, openApp, go, ui, list, listRows, listRow, inlineDetails, expectShown, tab, activeTab, drawerFact, expectToast, closeDrawer,
} from './helpers.js';

const pageDetail = (page) => page.locator('main button', { hasText: 'Back to list' }).locator('xpath=../..');

test.describe('Drill-down patterns', () => {
  test('panel is the default: the drawer opens on a row and the backdrop closes it', async ({ page }) => {
    await openApp(page);
    await go(page, 'Controls & requirements');
    await listRow(page, 'A.5.1').click();
    await expect(ui.drawer(page)).toBeVisible();
    await expect(ui.drawerBackdrop(page)).toBeVisible();
    await expect(ui.drawer(page)).toContainText('Policies for information security');
    await expect(ui.drawer(page)).toContainText('Controls & requirements');
    // the selected row stays highlighted behind the drawer
    await expect(listRow(page, 'A.5.1')).toHaveAttribute('style', /var\(--accbg\)/);
    await closeDrawer(page);
    await expect(listRow(page, 'A.5.1')).not.toHaveAttribute('style', /var\(--accbg\)/);
    // the close button works too
    await listRow(page, 'A.5.2').click();
    await ui.drawer(page).locator('button:not([title])').first().click();
    await expect(ui.drawer(page)).toHaveCount(0);
  });

  test('Escape closes the modal first, then the drawer', async ({ page }) => {
    await openApp(page);
    await go(page, 'Controls & requirements');
    await listRow(page, 'A.5.1').click();
    await ui.drawer(page).locator('button[title="Reassign"]').click();
    await expect(ui.modal(page)).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(ui.modal(page)).toHaveCount(0);
    await expect(ui.drawer(page)).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(ui.drawer(page)).toHaveCount(0);
    await expect(listRow(page, 'A.5.1')).not.toHaveAttribute('style', /var\(--accbg\)/);
    // with the focus in a form field it works the same way
    await listRow(page, 'A.5.2').click();
    await ui.drawer(page).locator('button[title="Reassign"]').click();
    await ui.modal(page).locator('input[type="date"]').focus();
    await page.keyboard.press('Escape');
    await expect(ui.modal(page)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(ui.drawer(page)).toHaveCount(0);
    // and it closes an open menu
    await ui.msSwitch(page).click();
    await expect(page.locator('header div[style*="width: 420px"]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('header div[style*="width: 420px"]')).toHaveCount(0);
  });

  test('Escape returns from the detail page to the list', async ({ page }) => {
    await openApp(page, '?drill=page');
    await go(page, 'Controls & requirements');
    await listRow(page, 'A.5.1').click();
    await expect(list(page)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(list(page)).toBeVisible();
  });

  test('page pattern replaces the list with a detail page and returns with Back', async ({ page }) => {
    await openApp(page, '?drill=page');
    await go(page, 'Controls & requirements');
    await listRow(page, 'A.5.1').click();
    await expect(ui.drawer(page)).toHaveCount(0);
    await expect(list(page)).toHaveCount(0);
    await expect(pageDetail(page)).toContainText('A.5.1');
    await expect(pageDetail(page)).toContainText('Policies for information security');
    await expect(pageDetail(page)).toContainText('Implementing document');
    await expect(page.locator('main button[title="Send reminder"]')).toHaveCount(1);
    await page.locator('main button[title="Send reminder"]').click();
    await expectToast(page, 'Reminder sent to Rina Kusuma');
    await page.locator('main button', { hasText: 'Back to list' }).click();
    await expect(list(page)).toBeVisible();
    await expectShown(page, 30);
    await expect(page.locator('main button', { hasText: 'Back to list' })).toHaveCount(0);
  });

  test('page pattern follows links between records', async ({ page }) => {
    await openApp(page, '?drill=page');
    await go(page, 'Controls & requirements');
    await tab(page, 'Partially implemented').click();
    await listRow(page, 'A.8.13').click();
    await pageDetail(page).locator('button', { hasText: 'EV-0313' }).first().click();
    await expect(ui.title(page)).toHaveText('Evidence freshness');
    await expect(pageDetail(page)).toContainText('Backup job log & restore test');
    await go(page, 'Audit readiness');
    await page.locator('main button[style*="border: 1.5px solid"]').nth(3).click();
    await expect(ui.title(page)).toHaveText('Controls & requirements');
    await expect(pageDetail(page)).toContainText('Privileged access rights');
  });

  test('inline pattern expands rows in place and collapses them again', async ({ page }) => {
    await openApp(page, '?drill=inline');
    await go(page, 'Controls & requirements');
    await listRow(page, 'A.5.1').click();
    await expect(ui.drawer(page)).toHaveCount(0);
    await expect(inlineDetails(page)).toHaveCount(1);
    await expect(inlineDetails(page).first()).toContainText('Policies for information security');
    await expect(inlineDetails(page).first()).toContainText('Implementing document');
    // the expanded row sits right under its row
    const next = listRow(page, 'A.5.1').locator('xpath=following-sibling::tr[1]');
    await expect(next).toContainText('Upstream');
    await listRow(page, 'A.5.2').click();
    await expect(inlineDetails(page)).toHaveCount(2);
    await expectShown(page, 30);
    await listRow(page, 'A.5.1').click();
    await expect(inlineDetails(page)).toHaveCount(1);
    await expect(inlineDetails(page).first()).toContainText('Information security roles and responsibilities');
    await listRow(page, 'A.5.2').click();
    await expect(inlineDetails(page)).toHaveCount(0);
  });

  test('inline detail actions and links work', async ({ page }) => {
    await openApp(page, '?drill=inline');
    await go(page, 'Controls & requirements');
    await tab(page, 'Partially implemented').click();
    await listRow(page, 'A.5.13').click();
    const detail = inlineDetails(page).first();
    await detail.locator('button[title="Mark complete"]').click();
    await expectToast(page, 'Marked complete');
    await expect(detail).toContainText('Complete, awaiting verification');
    await detail.locator('button', { hasText: /^STD-06$/ }).click();
    await expect(activeTab(page)).toContainText('Documents approved');
    await expect(inlineDetails(page)).toHaveCount(1);
    await expect(inlineDetails(page).first()).toContainText('Cryptography & Data Protection Standard');
  });

  test('switching tab or system collapses inline rows', async ({ page }) => {
    await openApp(page, '?drill=inline');
    await go(page, 'Evidence freshness');
    await listRow(page, 'EV-0313').click();
    await expect(inlineDetails(page)).toHaveCount(1);
    await tab(page, 'Critical').click();
    await expect(inlineDetails(page)).toHaveCount(0);
    await listRow(page, 'EV-0313').click();
    await expect(inlineDetails(page)).toHaveCount(1);
    await page.locator('main button[style*="grid-template-columns: 110px 1fr 120px"]').first().click();
    await expect(inlineDetails(page)).toHaveCount(0);
  });
});
