import { test, expect, openApp, go, ui, switchMs, activeTab, drawerFact, contrastProblems, finishAnimations } from './helpers.js';

const input = (page) => page.locator('main input[placeholder^="Enter any ID"]');
const traceBtn = (page) => page.locator('main button', { hasText: /^Trace$/ });
const suggestions = (page) => page.locator('main button[style*="height: 26px"]');
const rows = (page) => page.locator('main div[style*="grid-template-columns: 150px 28px 1fr"]');
const nodeBtn = (page, i) => rows(page).nth(i).locator('button');
const nodeIds = (page) => rows(page).locator('button > div:first-child > span:first-child').allInnerTexts();
const nodeStates = (page) => rows(page).locator('button > div:first-child > span:nth-child(2)').allInnerTexts();
const empty = (page) => page.locator('main div[style*="border: 1px dashed"]');

async function openGt(page) {
  await openApp(page);
  await go(page, 'Traceability viewer');
}

test.describe('Traceability viewer', () => {
  test('shows the first pack chain with broken nodes and the clause at risk', async ({ page }) => {
    await openGt(page);
    await expect(suggestions(page)).toHaveText(['R-014', 'R-022', 'R-031', 'R-003', 'A.8.13', 'PRC-07', 'A.5.23']);
    await expect(rows(page)).toHaveCount(8);
    expect(await nodeIds(page)).toEqual(['CI-02', 'R-014', 'T-014', 'A.8.2', 'A.8.2', 'PRC-07', 'EV-0280', 'M-07']);
    expect(await nodeStates(page)).toEqual(['Ready', 'Broken', 'Broken', 'Ready', 'Ready', 'Broken', 'Ready', 'Broken']);
    await expect(rows(page).nth(1)).toContainText('Clause at risk 6.1.2');
    await expect(rows(page).nth(5)).toContainText('Clause at risk 7.5');
    await expect(rows(page).nth(5)).toContainText('v3.2, Expired, Review due 24 Sep 2026');
    await expect(rows(page).nth(6)).toContainText('SharePoint Online, v2.0, Verified, Fresh, 18 Aug 2026');
    await expect(page.locator('main [data-tip*="Rendered in"]')).toHaveAttribute('data-tip', /Rendered in \d+ ms/);
    await expect(empty(page)).toHaveCount(0);
  });

  test('nodes only fade while they enter and then rest fully visible and readable', async ({ page }) => {
    await openGt(page);
    await suggestions(page).filter({ hasText: 'R-031' }).click();
    await expect(rows(page)).toHaveCount(8);
    await finishAnimations(page);
    expect(await rows(page).evaluateAll((els) => els.map((e) => getComputedStyle(e).opacity))).toEqual(Array(8).fill('1'));
    await expect(rows(page).filter({ hasText: 'Clause at risk' }).first()).toBeVisible();
    expect(await contrastProblems(page, 3, 'main *')).toEqual([]);
  });

  test('quick chips trace a control, a document and a gate item', async ({ page }) => {
    await openGt(page);
    await suggestions(page).filter({ hasText: 'A.8.13' }).click();
    await expect(input(page)).toHaveValue('A.8.13');
    expect(await nodeIds(page)).toEqual(['R-014', 'A.8.13', 'A.8.13', 'PRC-11', 'EV-0313']);
    expect(await nodeStates(page)).toEqual(['Broken', 'Pending', 'Pending', 'Broken', 'Broken']);
    await expect(rows(page).nth(4)).toContainText('Clause at risk 8.1 / 9.1');
    await expect(rows(page).nth(4)).toContainText('SharePoint Online, v5.0, Missing, Critical, 31 May 2026');

    await suggestions(page).filter({ hasText: 'PRC-07' }).click();
    await expect(input(page)).toHaveValue('PRC-07');
    expect(await nodeIds(page)).toEqual(['PRC-07', 'A.5.15', 'A.5.16', 'A.5.17', 'A.5.18']);

    await suggestions(page).filter({ hasText: 'R-022' }).click();
    expect(await nodeIds(page)).toEqual(['CI-05', 'R-022', 'T-022', 'A.5.23', 'A.5.23', 'POL-14', '-', 'M-03']);
    await expect(rows(page).nth(6)).toContainText('No evidence recorded this cycle');
  });

  test('search box traces a valid ID with Enter or the button, in any case', async ({ page }) => {
    await openGt(page);
    await input(page).fill('pol-01');
    await input(page).press('Enter');
    expect(await nodeIds(page)).toEqual(['POL-01', 'A.5.1', 'A.5.7']);
    await expect(rows(page).first()).toContainText('Information Security Policy');

    await input(page).fill('r-003');
    await traceBtn(page).click();
    await expect(rows(page)).toHaveCount(8);
    expect(await nodeStates(page)).toEqual(['Ready', 'Ready', 'Ready', 'Ready', 'Ready', 'Broken', 'Ready', 'Ready']);

    await input(page).fill('EV-0100');
    await traceBtn(page).click();
    expect(await nodeIds(page)).toEqual(['R-003', 'A.5.1', 'A.5.1', 'POL-01', 'EV-0100']);
    expect(await nodeStates(page)).toEqual(Array(5).fill('Ready'));
  });

  test('an unknown ID shows the empty state', async ({ page }) => {
    await openGt(page);
    await input(page).fill('XYZ-999');
    await input(page).press('Enter');
    await expect(empty(page)).toHaveText('No record found for "XYZ-999"');
    await expect(rows(page)).toHaveCount(0);
    await suggestions(page).filter({ hasText: 'R-031' }).click();
    await expect(empty(page)).toHaveCount(0);
    await expect(rows(page)).toHaveCount(8);
  });

  test('IDs that only appear as relations still trace', async ({ page }) => {
    await openGt(page);
    // a context issue referenced by a risk, and a risk referenced only by controls
    await input(page).fill('CI-07');
    await input(page).press('Enter');
    expect(await nodeIds(page)).toEqual(['CI-07', 'R-035']);
    await input(page).fill('R-009');
    await input(page).press('Enter');
    expect(await nodeIds(page)).toEqual(['R-009', 'A.6.1', 'A.6.2', 'A.6.3', 'A.6.4']);
  });

  test('a shared IMS document shows which other systems use it', async ({ page }) => {
    await openGt(page);
    await input(page).fill('IMS-01');
    await input(page).press('Enter');
    await expect(rows(page).first()).toContainText('Shared, QMS, BCMS, ABMS');
  });

  test('nodes open the record they stand for', async ({ page }) => {
    await openGt(page);
    await nodeBtn(page, 1).click();
    await expect(ui.title(page)).toHaveText('Outstanding items');
    await expect(activeTab(page).locator('div').nth(1)).toHaveText('Risk');
    await expect(ui.drawer(page)).toContainText('Privileged credential misuse');

    await go(page, 'Traceability viewer');
    await nodeBtn(page, 3).click();
    await expect(ui.title(page)).toHaveText('Annex A controls');
    await expect(ui.drawer(page)).toContainText('A.8.2');

    await go(page, 'Traceability viewer');
    await nodeBtn(page, 6).click();
    await expect(ui.title(page)).toHaveText('Evidence status');
    await expect(drawerFact(page, 'Control / requirement')).toContainText('A.8.2');

    await go(page, 'Traceability viewer');
    await input(page).fill('POL-01');
    await input(page).press('Enter');
    await nodeBtn(page, 0).click();
    await expect(ui.title(page)).toHaveText('Document register');
    await expect(ui.drawer(page)).toContainText('Information Security Policy');
  });

  test('switching the management system starts from that system’s first chain', async ({ page }) => {
    await openGt(page);
    await input(page).fill('A.8.13');
    await input(page).press('Enter');
    await switchMs(page, 'QMS');
    await expect(input(page)).toHaveValue('');
    await expect(empty(page)).toHaveCount(0);
    await expect(suggestions(page)).toHaveText(['RO-11', 'RO-07', 'Cl. 8.4', 'PRC-Q04']);
    expect(await nodeIds(page)).toEqual(['CI-Q04', 'RO-11', 'ACT-09', 'Cl. 8.3', 'QO-03', 'PRC-Q02', 'EQ-0151', 'MQ-02']);
  });
});
