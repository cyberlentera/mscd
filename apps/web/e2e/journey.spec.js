import { test, expect, openApp, go, ui, expectToast, switchMs, switchRole } from './helpers.js';

const main = (page) => page.locator('main');
const stageRow = (page, title) => main(page).locator('div[style*="grid-template-columns: 34px"]').filter({ hasText: title });

test.describe('Start here', () => {
  test('shows the seven journey stages and where the selected system stands', async ({ page }) => {
    await openApp(page);
    await go(page, 'Start here');
    await expect(main(page)).toContainText('Stage 7 of 7');
    await expect(main(page)).toContainText('Maintain the certificate');
    for (const title of ['Set up the workspace', 'Assign the team', 'Prepare documents', 'Implement the requirements', 'Internal audit and management review', 'Certification audit', 'Maintain the certificate']) {
      await expect(stageRow(page, title)).toHaveCount(1);
    }
    // a certified system has passed certification; earlier stages with open issues need attention
    await expect(stageRow(page, 'Certification audit')).toContainText('Done');
    await expect(stageRow(page, 'Implement the requirements')).toContainText('Needs attention');
    await expect(stageRow(page, 'Implement the requirements')).toContainText('Risk & SoA, 4 blocking items');
  });

  test('a system that is not certified yet sits in the first stage it has not passed', async ({ page }) => {
    await openApp(page);
    await go(page, 'Start here');
    await main(page).locator('button', { hasText: 'BCMS' }).click();
    await expect(ui.msSwitch(page)).toContainText('BCMS');
    await expect(main(page)).toContainText('Stage 4 of 7');
    await expect(stageRow(page, 'Implement the requirements')).toContainText('You are here');
    await expect(stageRow(page, 'Certification audit')).toContainText('Not started');
  });

  test('stage buttons open the screen where the work happens', async ({ page }) => {
    await openApp(page);
    await go(page, 'Start here');
    await stageRow(page, 'Implement the requirements').locator('button', { hasText: 'Roadmap' }).click();
    await expect(ui.title(page)).toHaveText('Roadmap');
    await go(page, 'Start here');
    await stageRow(page, 'Assign the team').locator('button', { hasText: 'Team & roles' }).click();
    await expect(ui.title(page)).toHaveText('Team & roles');
  });

  // @sample-only: in API mode Top Management reads aggregates only and gets no Start here (test/api/controller.test.ts).
  test('a stage node without an action the role can open is inert', { tag: '@sample-only' }, async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'Top Management');
    await go(page, 'Start here');
    const node = (title) => main(page).locator(`button[title="${title}"][style*="flex-direction: column"]`);
    // Set up opens Standards & licence and File storage, which Top Management does not open
    await expect(stageRow(page, 'Set up the workspace').locator('button')).toHaveCount(0);
    await expect(node('Set up')).toHaveAttribute('aria-disabled', 'true');
    await expect(node('Set up')).toHaveCSS('cursor', 'default');
    // Team opens Team & roles
    await expect(node('Team')).not.toHaveAttribute('aria-disabled');
    await expect(node('Team')).toHaveCSS('cursor', 'pointer');
    await node('Team').click();
    await expect(ui.title(page)).toHaveText('Team & roles');
  });

  test('follows the selected system and the Indonesian interface', async ({ page }) => {
    await openApp(page, '?lang=id');
    await go(page, 'Mulai di sini');
    await expect(main(page)).toContainText('Tahap 7 dari 7');
    await expect(main(page)).toContainText('Pertahankan sertifikat');
    await switchMs(page, 'QMS');
    await expect(main(page)).toContainText('Tahap 7 dari 7');
  });
});

test.describe('Team & roles', () => {
  test('lists every person with their roles per system, unassigned items first', async ({ page }) => {
    await openApp(page);
    await go(page, 'Team & roles');
    const rows = main(page).locator('table tbody tr');
    await expect(rows.first()).toContainText('Unassigned');
    await expect(rows).toHaveCount(12);
    const rina = rows.filter({ hasText: 'Rina Kusuma' });
    await expect(rina).toContainText('ISMS');
    await expect(rina).toContainText('MS Manager');
    const maya = rows.filter({ hasText: 'Maya Putri' });
    await expect(maya).toContainText('Internal Auditor');
  });

  test('opens the outstanding items of a person', async ({ page }) => {
    await openApp(page);
    await go(page, 'Team & roles');
    await main(page).locator('table tbody tr').filter({ hasText: 'Bagus Prasetyo' }).locator('button', { hasText: 'View items' }).click();
    await expect(ui.title(page)).toHaveText('Outstanding items');
    await expect(main(page)).toContainText('Bagus Prasetyo');
  });

  test('invites a user from the page action', { tag: '@sample-only' }, async ({ page }) => {
    await openApp(page);
    await go(page, 'Team & roles');
    await ui.pageAction(page, 'Invite user').click();
    await expectToast(page, 'Invitation form opened');
  });
});
