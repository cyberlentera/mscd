import {
  test, expect, openApp, go, ui, list, listRows, listRow, search, expectShown, drawerAction, drawerFact, drawerLinks,
  openRow, expectToast, switchMs, closeDrawer, activeTab,
} from './helpers.js';

const steps = (page) => page.locator('main button[title][style*="flex-direction: column"][style*="align-items: center"]');
const step = (page, name) => page.locator(`main button[title="${name}"]`);
const current = (page) => page.locator('main div[style*="border-radius: 10px"][style*="var(--sur2)"]').first();
const banner = (page) => page.locator('main div[style*="padding: 10px 14px"]').filter({ has: page.locator('span', { hasText: '!' }) }).last();
// The banner sentence and its inline link, as read on screen.
const bannerText = (page) => banner(page).locator('> span').nth(1);
const statusCol = (page) => listRows(page).locator('td:nth-child(7)');
const counts = async (page) => current(page).locator('div[style*="text-align: center"]').evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));

async function openPhases(page) {
  await openApp(page);
  await go(page, 'Phase board');
}

test.describe('Phase board', () => {
  test('stepper shows every phase and opens the current gate phase by default', async ({ page }) => {
    await openPhases(page);
    await expect(steps(page)).toHaveCount(9);
    await expect(steps(page).locator('span[class]')).toHaveText(['✓', '✓', '✓', '4', '✓', '✓', '✓', '✓', '9']);
    await expect(current(page)).toContainText('4. Risk assessment & SoA');
    await expect(current(page)).toContainText('GATE');
    await expect(current(page)).toContainText('4 blocked');
    expect(await counts(page)).toEqual(['6 Verified', '0 Complete, awaiting verification', '0 In progress', '4 Blocked', '0 Not started']);
    await expect(bannerText(page)).toHaveText('Critical gate: every activity must be Verified before the next phase opens. 4 blocked, 4 open gate items. Open gate items');
    await expect(listRows(page)).toHaveCount(10);
    await expect(statusCol(page)).toHaveText(['Verified', 'Verified', 'Verified', 'Verified', 'Blocked', 'Blocked', 'Verified', 'Verified', 'Blocked', 'Blocked']);
    await expect(listRow(page, '4.5')).toContainText('Blocked by A.8.12');
    await expect(listRow(page, '4.5')).toContainText('Resolve gate item A.8.12');
  });

  test('stepper labels are cut at a word boundary and keep the full name in the title', async ({ page }) => {
    await openPhases(page);
    await expect(steps(page).locator('span:not([class])')).toHaveText([
      'Initiation & mandate', 'Context & scope', 'Leadership & policy', 'Risk assessment & SoA', 'Risk treatment & controls',
      'Documentation', 'Operation & awareness', 'Performance evaluation', 'Improvement & audit…',
    ]);
    await expect(steps(page).last()).toHaveAttribute('title', 'Improvement & audit readiness');
    await switchMs(page, 'QMS');
    const labels = await steps(page).locator('span:not([class])').allInnerTexts();
    expect(labels.filter((l) => /[&+,]\s*…?$/.test(l))).toEqual([]);
    expect(labels).toContain('Risk & opportunity…');
    expect(labels).toContain('Performance evaluation…');
  });

  test('stepper phases switch the selected phase card and table', async ({ page }) => {
    await openPhases(page);
    await step(page, 'Improvement & audit readiness').click();
    await expect(current(page)).toContainText('9. Improvement & audit readiness');
    await expect(current(page)).toContainText('In progress');
    await expect(current(page)).not.toContainText('GATE');
    expect(await counts(page)).toEqual(['4 Verified', '0 Complete, awaiting verification', '2 In progress', '0 Blocked', '1 Not started']);
    await expect(listRows(page)).toHaveCount(7);
    await expect(statusCol(page)).toHaveText(['Verified', 'Verified', 'Verified', 'In progress', 'Verified', 'In progress', 'Not started']);
    // clicking the selected step keeps it selected
    await step(page, 'Improvement & audit readiness').click();
    await expect(current(page)).toContainText('9. Improvement & audit readiness');

    await step(page, 'Initiation & mandate').click();
    await expect(current(page)).toContainText('1. Initiation & mandate');
    await expect(current(page)).toContainText('Verified');
    await expect(banner(page)).toContainText('Phase verified.');
    await expect(statusCol(page)).toHaveText(Array(5).fill('Verified'));
    // BR-12: a phase with activities that are not Verified cannot be verified.
    await step(page, 'Risk assessment & SoA').click();
    await ui.pageAction(page, 'Verify phase').click();
    await expectToast(page, 'Phase verification needs all activities Verified');
  });

  test('Verify phase on a phase that is already verified says so', async ({ page }) => {
    // Both sources: the api answers D.3's "Phase n is already verified" for a phase seeded as verified (WP-30 fix).
    await openPhases(page);
    await step(page, 'Initiation & mandate').click();
    await expect(current(page)).toContainText('1. Initiation & mandate');
    await ui.pageAction(page, 'Verify phase').click();
    await expectToast(page, 'Phase 1 is already verified');
  });

  test('gate banner link opens the open gate items', async ({ page }) => {
    await openPhases(page);
    await banner(page).locator('button', { hasText: 'Open gate items' }).click();
    await expect(ui.title(page)).toHaveText('Controls & requirements');
    await expect(activeTab(page)).toContainText('Open gate items, Risk & SoA');
  });

  test('locked phases show a locked state that links back to the gate phase', async ({ page }) => {
    await openPhases(page);
    await switchMs(page, 'BCMS');
    await expect(current(page)).toContainText('4. BIA & risk assessment');
    await expect(current(page)).toContainText('2 blocked');
    await expect(banner(page)).toContainText('2 blocked, 3 open gate items.');
    await step(page, 'BC strategies & plans').click();
    await expect(current(page)).toContainText('5. BC strategies & plans');
    await expect(current(page)).toContainText('Locked');
    await expect(statusCol(page)).toHaveText(Array(7).fill('Locked'));
    await expect(listRows(page).locator('td:nth-child(8)')).toHaveText(Array(7).fill('-'));
    await expect(bannerText(page)).toHaveText('This phase is locked until the gate phase is verified: 4. BIA & risk assessment. BIA & risk assessment');
    await openRow(page, '5.1');
    await expect(ui.drawer(page)).toContainText('Locked');
    expect(await ui.drawer(page).locator('button[title]').count()).toBe(0);
    await closeDrawer(page);
    await banner(page).locator('button', { hasText: 'BIA & risk assessment' }).click();
    await expect(current(page)).toContainText('4. BIA & risk assessment');
  });

  test('blocked activity detail links to its gate item', async ({ page }) => {
    await openPhases(page);
    await openRow(page, '4.5');
    await expect(ui.drawer(page)).toContainText('Select Annex A controls');
    await expect(ui.drawer(page)).toContainText('Holding gate');
    await expect(drawerFact(page, 'Phase')).toHaveText('4. Risk assessment & SoA, GATE');
    await expect(drawerFact(page, 'Blocked by')).toHaveText('A.8.12, Data leakage prevention');
    await expect(drawerAction(page, 'Mark complete')).toHaveCount(0);
    await drawerFact(page, 'Blocked by').locator('button').click();
    await expect(ui.title(page)).toHaveText('Controls & requirements');
    await expect(activeTab(page)).toContainText('Open gate items');

    await go(page, 'Phase board');
    await openRow(page, '4.10');
    await expect(drawerLinks(page, 'Downstream')).toHaveText(['SOA-01']);
    await drawerAction(page, 'Open gate item').click();
    await expect(ui.title(page)).toHaveText('Controls & requirements');
    await expect(activeTab(page)).toContainText('Open gate items');
  });

  test('required output link opens the document', async ({ page }) => {
    await openPhases(page);
    await openRow(page, '4.10');
    await expect(drawerFact(page, 'Required output')).toHaveText('SOA-01, Statement of Applicability v3.0, v3.0, Draft');
    await drawerFact(page, 'Required output').locator('button').click();
    await expect(ui.title(page)).toHaveText('Controls & requirements');
    await expect(ui.drawer(page)).toContainText('SOA-01');
    await expect(ui.drawer(page)).toContainText('Draft');
  });

  test('Mark complete updates the activity and counts, and blocks self-verification', async ({ page }) => {
    await openPhases(page);
    await step(page, 'Improvement & audit readiness').click();
    await openRow(page, '9.4');
    await expect(drawerFact(page, 'Owner')).toHaveText('Dewi Anggraini, HR Manager');
    await drawerAction(page, 'Record blocker').click();
    await expectToast(page, 'Blocker recorded and linked to the gate item');
    await drawerAction(page, 'Mark complete').click();
    await expectToast(page, 'Marked complete: awaiting verification by the MS Manager');
    await expect(listRow(page, '9.4').locator('td:nth-child(7)')).toHaveText('Complete, awaiting verification');
    await expect(listRow(page, '9.4').locator('td:nth-child(4)')).toHaveText('Awaiting verification');
    expect(await counts(page)).toEqual(['4 Verified', '1 Complete, awaiting verification', '1 In progress', '0 Blocked', '1 Not started']);
    await drawerAction(page, 'Verify output').click();
    await expectToast(page, 'You completed this item: verification must be done by someone else');
    await expect(ui.modal(page)).toHaveCount(0);
  });

  test('the MS Manager verifies an activity completed by its owner', async ({ page }) => {
    await openPhases(page);
    await switchMs(page, 'QMS');
    await expect(current(page)).toContainText('9. ISO 9001:2026 transition');
    expect(await counts(page)).toEqual(['4 Verified', '4 Complete, awaiting verification', '4 In progress', '0 Blocked', '2 Not started']);
    await openRow(page, '9.4');
    await drawerAction(page, 'Verify output').click();
    await expect(ui.modal(page)).toContainText('Verify activity output');
    await expect(ui.modal(page)).toContainText('9.4 Map evidence to new requirements, Dewi Anggraini to Rina Kusuma, 29 Sep 2026');
    await ui.modal(page).locator('button', { hasText: 'Confirm verification' }).click();
    await expectToast(page, 'Verified. Status recalculated');
    await expect(listRow(page, '9.4').locator('td:nth-child(7)')).toHaveText('Verified');
    expect(await counts(page)).toEqual(['5 Verified', '3 Complete, awaiting verification', '4 In progress', '0 Blocked', '2 Not started']);
    await go(page, 'Overview');
    await expect(page.locator('main button', { hasText: 'ISO 9001:2026 transition' })).toContainText('5 / 14');
  });

  test('reassigning an activity keeps its due date unless changed', async ({ page }) => {
    await openPhases(page);
    await step(page, 'Improvement & audit readiness').click();
    await openRow(page, '9.6');
    await drawerAction(page, 'Send reminder').click();
    await expectToast(page, 'Reminder sent to Yusuf Rahman');
    await drawerAction(page, 'Reassign').click();
    await expect(ui.modal(page).locator('input[type="date"]')).toHaveValue('2026-10-05');
    await ui.modal(page).locator('select').selectOption('lina');
    await ui.modal(page).locator('input[type="date"]').fill('2026-10-25');
    await ui.modal(page).locator('button', { hasText: 'Save' }).click();
    await expectToast(page, 'Item updated');
    await expect(listRow(page, '9.6')).toContainText('Lina Marlina');
    await expect(listRow(page, '9.6')).toContainText('25 Oct 2026');
  });

  test('search filters the activities of the selected phase', async ({ page }) => {
    await openPhases(page);
    await search(page, 'Approve');
    await expect(listRows(page)).toHaveCount(2);
    await expect(listRows(page).locator('td:nth-child(2)')).toHaveText(['4.9', '4.10']);
    await search(page, 'blocked');
    await expect(listRows(page)).toHaveCount(4);
    await search(page, 'nothing like this');
    await expect(list(page)).toContainText('Nothing matches these filters');
    await search(page, '');
    await expectShown(page, 10);
  });
});
