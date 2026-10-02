import { test, expect, openApp, go, ui, switchMs, activeTab, expectToast, drawerFact } from './helpers.js';

const picks = (page) => page.locator('main button[style*="height: 28px"][style*="font-family: var(--ffm)"]');
const pick = (page, label) => picks(page).filter({ hasText: new RegExp('^' + label + '$') });
const nodes = (page) => page.locator('main button[style*="border: 1.5px solid"]');
const warning = (page) => page.locator('main div[style*="border-radius: 0 0 var(--r) var(--r)"]');
const stageRows = (page) => page.locator('main tr[data-hov]');
const hero = (page) => page.locator('main div[style*="background: var(--tx)"]').first();
const OK = 'rgb(31, 122, 72)', WARN = 'rgb(138, 101, 8)', BAD = 'rgb(191, 47, 37)';
const nodeColors = (page) => nodes(page).locator('div:first-child').evaluateAll((els) => els.map((e) => getComputedStyle(e).color));
const nodeIds = (page) => nodes(page).locator('div:nth-child(2)').allInnerTexts();

async function openAudit(page) {
  await openApp(page);
  await go(page, 'Audit readiness');
}

test.describe('Audit readiness', () => {
  test('hero shows the next audit and chain totals', async ({ page }) => {
    await openAudit(page);
    await expect(hero(page)).toContainText('Surveillance audit 1');
    await expect(hero(page)).toContainText('PT Sertifikasi Nusantara, Ir. Dwi Hartanto, IRCA LA');
    await expect(hero(page)).toContainText('44');
    await expect(hero(page)).toContainText('days left, 12 Nov 2026');
    await expect(hero(page)).toContainText(/63\s*Open along the chain\s*of 402 records/);
    await expect(hero(page)).toContainText(/24\s*Overdue \/ missing/);
    await expect(hero(page)).toContainText(/16\s*Due after audit date/);
    await expect(hero(page)).toContainText(/339\s*Records ready/);
  });

  test('traceability test renders R-014 with node states and break points', async ({ page }) => {
    await openAudit(page);
    await expect(picks(page)).toHaveText(['R-014', 'R-022', 'R-031', 'R-003', 'Random']);
    await expect(pick(page, 'R-014')).toHaveAttribute('style', /background: var\(--tx\)/);
    await expect(nodes(page)).toHaveCount(8);
    expect(await nodeIds(page)).toEqual(['CI-02', 'R-014', 'T-014', 'A.8.2', 'A.8.2', 'PRC-07', 'EV-0280', 'M-07']);
    expect(await nodeColors(page)).toEqual([OK, BAD, BAD, OK, OK, BAD, OK, BAD]);
    await expect(nodes(page).nth(1)).toContainText('Bagus Prasetyo');
    await expect(nodes(page).nth(1)).toContainText('Overdue, 10 Sep 2026');
    await expect(warning(page)).toContainText('4 break points: Risk R-014: Annual reassessment (Bagus Prasetyo, 10 Sep 2026)');
    await expect(warning(page)).toContainText('Metric M-07: Enter Aug and Sep values (Bagus Prasetyo, 5 Sep 2026)');
  });

  for (const [id, ids, colors, text] of [
    ['R-022', ['CI-05', 'R-022', 'T-022', 'A.5.23', 'A.5.23', 'POL-14', '-', 'M-03'], [OK, WARN, OK, BAD, BAD, OK, BAD, OK], '3 break points: Control A.5.23: Resolve gate item: justification missing'],
    ['R-031', ['CI-03', 'R-031', 'T-031', 'A.8.8', 'A.8.8', 'PRC-10', 'EV-0298', 'M-07'], [OK, WARN, BAD, WARN, WARN, OK, BAD, BAD], '3 break points: Risk treatment T-031: Assign owner and plan treatment (Unassigned)'],
    ['R-003', ['CI-01', 'R-003', 'T-003', 'A.5.15', 'A.5.15', 'PRC-07', 'EV-0142', 'M-02'], [OK, OK, OK, OK, OK, BAD, OK, OK], '1 break point: Document PRC-07: Start review: review date passed'],
  ]) {
    test(`traceability pick ${id} renders its chain`, async ({ page }) => {
      await openAudit(page);
      await pick(page, id).click();
      await expect(pick(page, id)).toHaveAttribute('style', /background: var\(--tx\)/);
      await expect(pick(page, 'R-014')).not.toHaveAttribute('style', /background: var\(--tx\)/);
      await expect(nodes(page)).toHaveCount(8);
      expect(await nodeIds(page)).toEqual(ids);
      expect(await nodeColors(page)).toEqual(colors);
      await expect(warning(page)).toContainText(text);
    });
  }

  test('Random picks a different chain each time', async ({ page }) => {
    await openAudit(page);
    for (let i = 0; i < 4; i++) {
      const active = await picks(page).evaluateAll((els) => els.find((e) => e.style.background === 'var(--tx)')?.innerText);
      await pick(page, 'Random').click();
      await expect.poll(() => picks(page).evaluateAll((els) => els.find((e) => e.style.background === 'var(--tx)')?.innerText)).not.toBe(active);
      await expect(nodes(page)).toHaveCount(8);
    }
  });

  test('chain nodes open the record they stand for', async ({ page }) => {
    await openAudit(page);
    await nodes(page).nth(1).click();
    await expect(ui.title(page)).toHaveText('Chain stages');
    await expect(activeTab(page).locator('div').nth(1)).toHaveText('Risk');
    await expect(ui.drawer(page)).toContainText('R-014');
    await expect(drawerFact(page, 'Pending action')).toHaveText('Annual reassessment');

    await go(page, 'Audit readiness');
    await nodes(page).nth(3).click();
    await expect(ui.title(page)).toHaveText('Controls & requirements');
    await expect(ui.drawer(page)).toContainText('A.8.2');
    await expect(ui.drawer(page)).toContainText('Privileged access rights');

    await go(page, 'Audit readiness');
    await nodes(page).nth(6).click();
    await expect(ui.title(page)).toHaveText('Evidence freshness');
    await expect(ui.drawer(page)).toContainText('EV-0280');

    await go(page, 'Audit readiness');
    await nodes(page).nth(5).click();
    await expect(ui.title(page)).toHaveText('Chain stages');
    await expect(activeTab(page).locator('div').nth(1)).toHaveText('Document');
    await expect(ui.drawer(page)).toContainText('PRC-07');

    await go(page, 'Audit readiness');
    await nodes(page).nth(0).click();
    await expect(ui.title(page)).toHaveText('Chain stages');
    await expect(activeTab(page).locator('div').nth(1)).toHaveText('Context issue');
    await expect(ui.drawer(page)).toHaveCount(0);
  });

  test('readiness per stage lists every stage and opens it', async ({ page }) => {
    await openAudit(page);
    await expect(stageRows(page)).toHaveCount(8);
    await expect(stageRows(page).nth(3)).toContainText('Control');
    await expect(stageRows(page).nth(3)).toContainText('70%');
    await expect(stageRows(page).nth(3).locator('td')).toHaveText([/Control/, '70%', '93', '26', '2', '13', '2 Oct 2026']);
    await expect(stageRows(page).nth(6).locator('td')).toHaveText([/Evidence/, '87%', '79', '0', '10', '0', '-']);
    await stageRows(page).nth(6).click();
    await expect(ui.title(page)).toHaveText('Chain stages');
    await expect(activeTab(page).locator('div').nth(1)).toHaveText('Evidence');
  });

  // @sample-only: in API mode the evidence pack toast is the api's message (E.7) and Auditor access asks for the auditor's email (WP-25 deviation 5); e2e/api-only/guest.spec.js covers the grant.
  test('page actions name the right repository', { tag: '@sample-only' }, async ({ page }) => {
    await openAudit(page);
    await ui.pageAction(page, 'Build evidence pack').click();
    await expectToast(page, 'Evidence pack is being compiled, manifest will appear in SharePoint Online');
    await ui.pageAction(page, 'Auditor access').click();
    await expectToast(page, 'Guest access link created, valid 14 days');
    await switchMs(page, 'QMS');
    await ui.pageAction(page, 'Build evidence pack').click();
    await expectToast(page, 'manifest will appear in Managed Vault');
  });

  test('a system without an audit event shows the empty state', async ({ page }) => {
    await openAudit(page);
    await switchMs(page, 'ABMS');
    await expect(page.locator('main')).toContainText('No audit event scheduled');
    await expect(page.locator('main div[style*="border: 1px dashed"]')).toBeVisible();
    await expect(picks(page)).toHaveText(['Random']);
    await expect(nodes(page)).toHaveCount(0);
    await pick(page, 'Random').click();
    await expect(nodes(page)).toHaveCount(0);
    await expect(stageRows(page)).toHaveCount(6);
  });

  test('long stage names break at a hyphen inside the narrow nodes at 1280 px', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openAudit(page);
    await switchMs(page, 'QMS');
    const label = nodes(page).nth(1).locator('div').first();
    // a soft hyphen marks where OPPORTUNITY may break (OPPOR-TUNITY), so it never splits after the last letter
    expect(await label.evaluate((e) => e.textContent)).toBe('Risk & oppor\u00ADtunity');
    expect(await label.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    const process = nodes(page).nth(3).locator('div').first();
    expect(await process.evaluate((e) => e.textContent)).toBe('Process / require\u00ADment');
    expect(await process.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    // the warning names the stages without hyphenation marks
    expect(await warning(page).evaluate((e) => e.textContent.includes('\u00AD'))).toBe(false);
  });

  test('BCMS renders its prioritised activity chain', async ({ page }) => {
    await openAudit(page);
    await switchMs(page, 'BCMS');
    await expect(picks(page)).toHaveText(['PA-05', 'Random']);
    expect(await nodeIds(page)).toEqual(['CI-B02', 'PA-05', 'BIA-03', 'DR-04', 'Cl. 8.3', 'PLN-B02', 'EX-01', '-']);
    await expect(hero(page)).toContainText('Stage 1 audit');
  });
});
