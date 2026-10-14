import { test, expect, openApp, go, ui, switchMs, activeTab, listRows, drawerFact } from './helpers.js';

const clauses = (page) => page.locator('main button[style*="height: 46px"]');
const clause = (page, n) => clauses(page).filter({ has: page.locator('span', { hasText: new RegExp('^' + n + '$') }) });
const phases = (page) => page.locator('main button[style*="grid-template-columns: 22px 1fr 90px 70px"]');
const blockers = (page) => page.locator('main button[style*="grid-template-columns: 110px 1fr 220px 150px"]');

test.describe('Readiness by clause', () => {
  test('maturity heatmap shows four dimensions per clause with a level', async ({ page }) => {
    await openApp(page);
    await go(page, 'Readiness by clause');
    await expect(clauses(page)).toHaveCount(7);
    await expect(clauses(page).first()).toContainText('Context of the organization');
    await expect(clauses(page).first()).toContainText('4.0');
    const cells = clause(page, 4).locator('span[title]');
    await expect(cells).toHaveCount(5);
    await expect(cells.nth(0)).toHaveAttribute('title', 'Documented: 4 / 4');
    await expect(cells.nth(1)).toHaveAttribute('title', 'Implemented: 4 / 4');
    await expect(cells.nth(4)).toHaveAttribute('title', 'Optimised');
    await expect(clause(page, 10)).toContainText('3 open');
    await expect(clause(page, 10)).toContainText('2.0');
    await expect(page.locator('main')).toContainText('Next checkpoint: Risk assessment & SoA, 4 items');
    await switchMs(page, 'ABMS');
    await expect(page.locator('main')).toContainText('Next checkpoint: Bribery risk assessment, 1 item');
    await expect(page.locator('main')).not.toContainText('1 items');
    await switchMs(page, 'ISMS');
    await expect(page.locator('main')).toContainText('Scale 0 to 4, average of four dimensions');
  });

  const CLAUSE_TARGETS = [
    [4, 'Outstanding items', 'Context issue'],
    [5, 'Annex A controls', 'Controls implemented'],
    [6, 'Outstanding items', 'Risk'],
    [7, 'Annex A controls', 'Documents expired'],
    [8, 'Annex A controls', 'Partially implemented'],
    [9, 'Outstanding items', 'Metric'],
    [10, 'Audit readiness', null],
  ];
  for (const [n, title, tabLabel] of CLAUSE_TARGETS) {
    test(`clause ${n} opens ${title}${tabLabel ? ' on ' + tabLabel : ''}`, async ({ page }) => {
      await openApp(page);
      await go(page, 'Readiness by clause');
      await clause(page, n).click();
      await expect(ui.title(page)).toHaveText(title);
      if (tabLabel) {
        await expect(activeTab(page)).toHaveCount(1);
        await expect(activeTab(page).locator('div').nth(1)).toHaveText(tabLabel);
      } else {
        await expect(page.locator('main')).toContainText('Traceability test');
      }
    });
  }

  // Clause rows must land on a chain stage the selected system actually has.
  for (const [ms, risk, measure] of [['QMS', 'Risk & opportunity', 'Metric'], ['BCMS', 'Disruption risk', 'Exercise'], ['ABMS', 'Bribery risk', 'Evidence']]) {
    test(`${ms}: planning and performance clauses open existing chain stages`, async ({ page }) => {
      await openApp(page);
      await go(page, 'Readiness by clause');
      await switchMs(page, ms);
      await clause(page, 6).click();
      await expect(ui.title(page)).toHaveText('Outstanding items');
      await expect(activeTab(page).locator('div').nth(1)).toHaveText(risk);
      await page.locator('aside nav button[title="Readiness by clause"]').click();
      await clause(page, 9).click();
      await expect(activeTab(page).locator('div').nth(1)).toHaveText(measure);
    });
  }

  test('phase progress lists every phase and opens it on the phase board', async ({ page }) => {
    await openApp(page);
    await go(page, 'Readiness by clause');
    await expect(phases(page)).toHaveCount(9);
    await expect(phases(page).nth(3)).toContainText('Risk assessment & SoA');
    await expect(phases(page).nth(3).locator('[data-tip="CHECKPOINT"]')).toHaveCount(1);
    // the checkpoint flag is announced as an image, and keyboard focus on its phase shows the flag's popover
    await expect(phases(page).nth(3).locator('[role="img"][aria-label="CHECKPOINT"]')).toHaveCount(1);
    await phases(page).nth(2).focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('.mscd-pop')).toHaveText('CHECKPOINT');
    await expect(phases(page).nth(3)).toContainText('4 blocked');
    await expect(phases(page).nth(0)).toContainText('Verified');
    await expect(phases(page).nth(8)).toContainText('4 / 7');
    await phases(page).nth(1).click();
    await expect(ui.title(page)).toHaveText('Roadmap');
    await expect(page.locator('main')).toContainText('2. Context & scope');
    await expect(listRows(page)).toHaveCount(6);
    await go(page, 'Readiness by clause');
    await phases(page).nth(8).click();
    await expect(page.locator('main')).toContainText('9. Improvement & audit readiness');
  });

  test('top blockers open the gate list or the overdue chain item', async ({ page }) => {
    await openApp(page);
    await go(page, 'Readiness by clause');
    await expect(blockers(page)).toHaveCount(5);
    await expect(blockers(page).locator('span[style*="font-family"]').first()).toHaveText('A.5.23');
    await expect(blockers(page).nth(4)).toContainText('EV-0319');
    await expect(blockers(page).nth(4)).toContainText('Overdue 113d');
    await blockers(page).nth(2).click();
    await expect(ui.title(page)).toHaveText('Annex A controls');
    await expect(activeTab(page)).toContainText('Blocking items, Risk & SoA');
    await expect(listRows(page)).toHaveCount(4);
    await go(page, 'Readiness by clause');
    await blockers(page).nth(4).click();
    await expect(ui.title(page)).toHaveText('Outstanding items');
    await expect(activeTab(page).locator('div').nth(1)).toHaveText('Evidence');
    await expect(ui.drawer(page)).toBeVisible();
    await expect(ui.drawer(page)).toContainText('EV-0319');
    await expect(drawerFact(page, 'Control / requirement')).toContainText('A.8.15');
  });

  // @sample-only: in API mode the readiness report is an export task that the worker builds (WP-25 deviation 7); the E2E stack runs no worker (J.6).
  test('Readiness report confirms with a toast', { tag: '@sample-only' }, async ({ page }) => {
    await openApp(page);
    await go(page, 'Readiness by clause');
    await ui.pageAction(page, 'Readiness report').click();
    await expect(ui.toast(page)).toContainText('Readiness report queued');
  });
});
