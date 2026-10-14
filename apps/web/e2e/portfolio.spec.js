import { test, expect, openApp, ui, listRows, expectShown, activeTab, tab, contrastProblems } from './helpers.js';

const cards = (page) => page.locator('main div[style*="border-radius: var(--r)"][style*="flex-direction: column"][style*="gap: 14px"]').filter({ has: page.locator('svg polygon') });
const card = (page, short) => cards(page).filter({ has: page.locator('span', { hasText: new RegExp('^' + short + '$') }) });
const attention = (page) => page.locator('main button[style*="grid-template-columns: 46px"]');

test.describe('Home', () => {
  test('groups the attention items by urgency with counts', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('main')).toContainText('Needs attention');
    await expect(page.locator('main')).toContainText('12 items');
    const groups = attention(page).first().locator('xpath=../../div');
    await expect(groups).toHaveCount(3);
    await expect(groups.nth(0)).toContainText(/Blocking\s*4/);
    await expect(groups.nth(1)).toContainText(/Audit soon\s*2/);
    await expect(groups.nth(2)).toContainText(/Housekeeping\s*6/);
    await expect(attention(page)).toHaveCount(12);
    await expect(groups.nth(0).locator('button').first()).toHaveAttribute('data-tip', 'A.5.23, A.8.12, R-031, SOA-01');
    await expect(groups.nth(0).locator('button')).toHaveText([
      /ISMS.*4 blocking items, Risk & SoA/,
      /BCMS.*3 blocking items, BIA & Risk Assessment/,
      /ABMS.*1 blocking item, Bribery Risk Assessment/,
      /BCMS.*Repository connector degraded, Google Shared Drive/,
    ]);
  });

  // Every attention item opens the screen, management system and filter that explain it.
  const TARGETS = [
    { item: '4 blocking items, Risk & SoA', title: 'Annex A controls', ms: 'ISMS', tab: 'Blocking items, Risk & SoA', rows: 4 },
    { item: '3 blocking items, BIA & Risk Assessment', title: 'Requirements', ms: 'BCMS', tab: 'Blocking items, BIA & Risk Assessment', rows: 3 },
    { item: '1 blocking item, Bribery Risk Assessment', title: 'Requirements', ms: 'ABMS', tab: 'Blocking items, Bribery Risk Assessment', rows: 1 },
    { item: 'Repository connector degraded, Google Shared Drive', title: 'File storage', ms: 'BCMS' },
    { item: 'Surveillance audit 1 in 44 days', title: 'Outstanding items', ms: 'ISMS' },
    { item: 'Recertification & ISO 9001:2026 transition audit in 65 days', title: 'Outstanding items', ms: 'QMS' },
    { item: '5 documents expired', title: 'Annex A controls', ms: 'ISMS', tab: 'Documents expired', rows: 5 },
    { item: '1 document expired', title: 'Requirements', ms: 'QMS', tab: 'Documents expired', rows: 1 },
    { item: '3 critical evidence', title: 'Evidence status', ms: 'ISMS', tab: 'Critical', rows: 3 },
    { item: '3 evidence files cannot be verified', title: 'Evidence status', ms: 'ISMS', tab: 'File cannot be verified', rows: 3 },
    { item: 'Edition transition, ISO 9001:2026, 14 tasks', title: 'Standards & licence', ms: 'QMS' },
    { item: 'Beta Framework Pack, ISO 37001:2025', title: 'Standards & licence', ms: 'ABMS' },
  ];
  for (const t of TARGETS) {
    test(`attention item "${t.item}" opens ${t.title} for ${t.ms}`, async ({ page }) => {
      await openApp(page);
      await attention(page).filter({ hasText: t.item }).click();
      await expect(ui.title(page)).toHaveText(t.title);
      await expect(ui.msSwitch(page)).toContainText(t.ms);
      if (t.tab) {
        await expect(activeTab(page)).toHaveCount(1);
        await expect(activeTab(page)).toContainText(t.tab);
        await expect(listRows(page)).toHaveCount(t.rows);
        await expectShown(page, t.rows);
      }
    });
  }

  test('clause readiness at 0% stays readable and the cards pass a contrast check', async ({ page }) => {
    await openApp(page);
    const zero = card(page, 'ABMS').locator('span', { hasText: /^0%$/ }).first();
    await expect(zero).toHaveCSS('color', 'rgb(107, 101, 90)');
    expect(await contrastProblems(page, 3, 'main *')).toEqual([]);
  });

  test('each card shows the system, next audit and clause readiness radar', async ({ page }) => {
    await openApp(page);
    await expect(cards(page)).toHaveCount(4);
    for (const short of ['ISMS', 'QMS', 'BCMS', 'ABMS']) {
      const c = card(page, short);
      const radar = c.locator('svg[viewBox="0 0 120 120"]');
      await expect(radar).toBeVisible();
      // grid 100%, grid 50% and the readiness polygon, one dot and one axis label per clause 4 to 10
      await expect(radar.locator('polygon')).toHaveCount(3);
      await expect(radar.locator('circle')).toHaveCount(7);
      await expect(radar.locator('text')).toHaveText(['4', '5', '6', '7', '8', '9', '10']);
      const points = await radar.locator('polygon').nth(2).getAttribute('points');
      expect(points.split(' ')).toHaveLength(7);
      await expect(c).toContainText('Clause readiness, 4-10');
    }
    await expect(card(page, 'ISMS')).toContainText('44 days left, 12 Nov 2026');
    await expect(card(page, 'BCMS')).toContainText('134 days left, 10 Feb 2027');
    await expect(card(page, 'ABMS')).toContainText('No audit event scheduled');
    await expect(card(page, 'QMS')).toContainText('Managed Vault');
    await expect(card(page, 'QMS')).not.toContainText('Managed Vault, Managed Vault');
    await expect(card(page, 'ISMS')).toContainText('SharePoint Online, Customer Repository');
  });

  for (const [short, name, screen] of [
    ['ISMS', 'Information security management system', 'Annex A controls'],
    ['QMS', 'Quality management system', 'Requirements'],
    ['BCMS', 'Business continuity management system', 'Requirements'],
    ['ABMS', 'Anti-bribery management system', 'Requirements'],
  ]) {
    test(`card title of ${short} opens its controls`, async ({ page }) => {
      await openApp(page);
      await card(page, short).locator('button', { hasText: name }).click();
      await expect(ui.title(page)).toHaveText(screen);
      await expect(ui.msSwitch(page)).toContainText(short);
      await expect(page.locator(`aside nav button[title="${screen}"]`)).toHaveCSS('font-weight', '600');
    });
  }

  // Each stat number equals the length of the list it opens.
  const STATS = [
    { ms: 'ISMS', stat: 'Blocking items', n: 4, title: 'Annex A controls', tab: 'Blocking items, Risk & SoA' },
    { ms: 'ISMS', stat: 'Open findings', n: 3, title: 'Audit readiness' },
    { ms: 'ISMS', stat: 'Documents expired', n: 5, title: 'Annex A controls', tab: 'Documents expired' },
    { ms: 'ISMS', stat: 'Critical evidence', n: 3, title: 'Evidence status', tab: 'Critical' },
    { ms: 'QMS', stat: 'Blocking items', n: 0, title: 'Requirements', tab: 'Blocking items, Risk & Opportunity + Process Map' },
    { ms: 'QMS', stat: 'Open findings', n: 2, title: 'Audit readiness' },
    { ms: 'QMS', stat: 'Documents expired', n: 1, title: 'Requirements', tab: 'Documents expired' },
    { ms: 'BCMS', stat: 'Blocking items', n: 3, title: 'Requirements', tab: 'Blocking items, BIA & Risk Assessment' },
    { ms: 'ABMS', stat: 'Critical evidence', n: 0, title: 'Evidence status', tab: 'Critical' },
  ];
  for (const s of STATS) {
    test(`${s.ms} card stat "${s.stat}" (${s.n}) opens the matching list`, async ({ page }) => {
      await openApp(page);
      const btn = card(page, s.ms).locator('button[style*="flex: 1"]').filter({ hasText: s.stat });
      await expect(btn.locator('div').first()).toHaveText(String(s.n));
      await btn.click();
      await expect(ui.title(page)).toHaveText(s.title);
      await expect(ui.msSwitch(page)).toContainText(s.ms);
      if (s.tab) {
        await expect(activeTab(page)).toContainText(s.tab);
        await expect(tab(page, s.tab).locator('span').first()).toHaveText(String(s.n));
        await expect(listRows(page)).toHaveCount(s.n);
      } else {
        await expect(page.locator('main')).toContainText('Traceability test');
      }
    });
  }

  test('rows layout lists every system with working links', async ({ page }) => {
    await openApp(page, '?layout=rows');
    await expect(cards(page)).toHaveCount(0);
    const table = page.locator('main table');
    await expect(table.locator('thead th')).toHaveCount(8);
    const rows = table.locator('tbody > tr');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText('ISMS, Information security management system');
    // the system colour is a swatch before the name, not a coloured left border on the row
    await expect(rows.nth(0)).toHaveCSS('border-left-width', '0px');
    await expect(rows.nth(0).locator('td').first().locator('button > span').first()).toHaveCSS('background-color', 'rgb(232, 115, 26)');
    await expect(rows.nth(0)).toContainText('Surveillance audit 1');
    await expect(rows.nth(3)).toContainText('No audit event scheduled');
    // each row draws one readiness bar per clause
    await expect(rows.nth(0).locator('div[style*="height: 6px"]')).toHaveCount(7);
    await expect(rows.nth(0).locator('button', { hasText: 'A.5.23' })).toBeVisible();
    await rows.nth(2).locator('button', { hasText: 'BIA-03' }).click();
    await expect(ui.title(page)).toHaveText('Requirements');
    await expect(ui.msSwitch(page)).toContainText('BCMS');
    await expect(activeTab(page)).toContainText('Blocking items, BIA & Risk Assessment');
    await page.locator('aside nav button[title="Home"]').click();
    await page.locator('main table tbody > tr').nth(1).locator('button', { hasText: 'QMS, Quality management system' }).click();
    await expect(ui.title(page)).toHaveText('Requirements');
    await expect(ui.msSwitch(page)).toContainText('QMS');
  });

  // @sample-only: in API mode Export board is an export task that the worker builds and the browser downloads (WP-25 deviation 7); the E2E stack runs no worker (J.6).
  test('Export board confirms with a toast', { tag: '@sample-only' }, async ({ page }) => {
    await openApp(page);
    await ui.pageAction(page, 'Export board').click();
    await expect(ui.toast(page)).toHaveText('Board exported as PDF');
  });
});
