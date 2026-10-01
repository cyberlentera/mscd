import {
  test, expect, SCREENS, SCREENS_ID, openApp, go, ui, list, listRows, tabs, switchMs, closeDrawer,
  expectNoHorizontalOverflow, expectNoTextOverflow, expectReadableText,
} from './helpers.js';

const SYSTEMS = ['ISMS', 'QMS', 'BCMS', 'ABMS'];
// Screens with summary cards used as tabs: Controls & requirements, Chain stages, Evidence freshness.
const TAB_SCREENS = [2, 6, 9];

async function check(page, { textOverflow, contrast }) {
  await expectNoHorizontalOverflow(page);
  if (textOverflow) await expectNoTextOverflow(page);
  if (contrast) await expectReadableText(page, 3);
}

// Visit every screen of one management system and check the layout holds: each summary tab,
// the first row's detail drawer and its Reassign form included, so states beyond the default view are covered.
async function visitAll(page, labels, { textOverflow = true, contrast = false } = {}) {
  const opts = { textOverflow, contrast };
  for (const [i, label] of labels.entries()) {
    await go(page, label);
    await check(page, opts);
    if (TAB_SCREENS.includes(i)) {
      const n = await tabs(page).count();
      for (let k = 0; k < n; k++) {
        await tabs(page).nth(k).click();
        await check(page, opts);
      }
    }
    if (await list(page).count() && await listRows(page).count()) {
      await listRows(page).first().click();
      await expect(ui.drawer(page)).toBeVisible();
      await check(page, opts);
      const reassign = ui.drawer(page).locator('button[title="Reassign"], button[title="Alihkan"]');
      if (await reassign.count()) {
        await reassign.click();
        await expect(ui.modal(page)).toBeVisible();
        await check(page, opts);
        await page.keyboard.press('Escape');
        await expect(ui.modal(page)).toHaveCount(0);
      }
      await closeDrawer(page);
    }
  }
}

async function openIn(page, query, ms) {
  await openApp(page, query);
  if (ms !== 'ISMS') await switchMs(page, ms);
}

test.describe('Display settings', () => {
  for (const ms of SYSTEMS) {
    test(`dark theme renders every ${ms} screen with readable text`, async ({ page }) => {
      await openIn(page, '?theme=dark', ms);
      const root = page.locator('.mscd').first();
      await expect(root).toHaveAttribute('data-theme', 'dark');
      await expect(root).toHaveCSS('background-color', 'rgb(19, 18, 16)');
      await expect(page.locator('main h1')).toHaveCSS('color', 'rgb(242, 238, 231)');
      await visitAll(page, SCREENS, { contrast: true });
    });
  }

  test('dark theme carries into the drawer and modals', async ({ page }) => {
    await openApp(page, '?theme=dark');
    await go(page, 'Controls & requirements');
    await listRows(page).first().click();
    await expect(ui.drawer(page)).toHaveAttribute('data-theme', 'dark');
    await expect(ui.drawer(page)).toHaveCSS('background-color', 'rgb(28, 26, 23)');
    await ui.drawer(page).locator('button[title="Reassign"]').click();
    await expect(ui.modal(page)).toHaveAttribute('data-theme', 'dark');
    await expect(ui.modal(page)).toHaveCSS('background-color', 'rgb(28, 26, 23)');
  });

  test('dark theme keeps the audit hero a dark card with readable figures', async ({ page }) => {
    await openApp(page, '?theme=dark');
    await go(page, 'Audit readiness');
    const hero = page.locator('main [data-hero]');
    await expect(hero).toHaveCSS('background-color', 'rgb(42, 38, 33)');
    await expect(hero).toHaveCSS('color', 'rgb(242, 238, 231)');
    await expectReadableText(page, 3);
    // filled step circles draw dark text on the bright dark-theme status colours
    await go(page, 'Phase board');
    const circle = page.locator('main button[title="Initiation & mandate"] > span').first();
    await expect(circle).toHaveCSS('background-color', 'rgb(95, 207, 144)');
    await expect(circle).toHaveCSS('color', 'rgb(19, 18, 16)');
  });

  for (const ms of SYSTEMS) {
    test(`Indonesian renders every ${ms} screen with translated titles and no leftover keys`, async ({ page }) => {
      await openIn(page, '?lang=id', ms);
      await expect(page.locator('aside nav button')).toHaveCount(SCREENS_ID.length);
      for (const label of SCREENS_ID) {
        await go(page, label);
        const text = await page.locator('main').innerText();
        expect(text, label).not.toMatch(/\bshowing\b|\bundefined\b|\bNaN\b|\[object/);
        if (await list(page).count()) await expect(list(page)).toContainText(/Menampilkan \d+ item/);
      }
      await visitAll(page, SCREENS_ID);
    });
  }

  test('Indonesian translates statuses, chips and dates', async ({ page }) => {
    await openApp(page, '?lang=id');
    await go(page, 'Kontrol & persyaratan');
    await expect(page.locator('main')).toContainText('Kontrol diterapkan');
    await expect(listRows(page).first()).toContainText('Diterapkan');
    await go(page, 'Kalender review');
    await expect(page.locator('main')).toContainText('Terlambat');
    await expect(page.locator('main')).toContainText('Okt 2026');
    await go(page, 'Kesegaran bukti');
    await expect(page.locator('main')).toContainText('Kesegaran per frekuensi operasi');
  });

  for (const [density, rowHeight, pad] of [['dense', 36, '10px'], ['airy', 60, '24px']]) {
    test(`${density} density sets row height and padding`, async ({ page }) => {
      await openApp(page, '?density=' + density);
      const root = page.locator('.mscd').first();
      await expect(root).toHaveAttribute('data-density', density);
      await go(page, 'Controls & requirements');
      const h = await listRows(page).first().evaluate((r) => r.querySelector('td').getBoundingClientRect().height);
      expect(h).toBeGreaterThanOrEqual(rowHeight);
      expect(await root.evaluate((e) => getComputedStyle(e).getPropertyValue('--pad').trim())).toBe(pad);
    });
    for (const ms of SYSTEMS) {
      test(`${density} density renders every ${ms} screen`, async ({ page }) => {
        await openIn(page, '?density=' + density, ms);
        await visitAll(page, SCREENS);
      });
    }
  }

  for (const [font, family] of [['source', 'Source Sans 3'], ['public', 'Public Sans'], ['instrument', 'Instrument Sans']]) {
    test(`${font} font pairing is applied`, async ({ page }) => {
      await openApp(page, '?font=' + font);
      await expect(page.locator('.mscd').first()).toHaveAttribute('data-font', font);
      await expect(page.locator('main h1')).toHaveCSS('font-family', new RegExp(family));
    });
    for (const ms of SYSTEMS) {
      // The pairing comes from Google Fonts and falls back to system fonts when that is unreachable
      // (the on-premise image does not load it by default), so the text must fit with either.
      test(`${font} font pairing renders every ${ms} screen`, async ({ page }) => {
        await openIn(page, '?font=' + font, ms);
        await page.evaluate(() => document.fonts.ready);
        await visitAll(page, SCREENS);
      });
    }
  }

  test('IBM Plex is self-hosted and used by default', async ({ page }) => {
    const fontRequests = [];
    page.on('requestfinished', (r) => { if (/ibm-plex/.test(r.url())) fontRequests.push(r.url()); });
    await openApp(page);
    await expect(page.locator('main h1')).toHaveCSS('font-family', /IBM Plex Sans/);
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.fonts.check('600 16px "IBM Plex Sans"'))).toBe(true);
    expect(fontRequests.length).toBeGreaterThan(0);
    const origin = new URL(page.url()).origin + '/';
    expect(fontRequests.every((u) => u.startsWith(origin))).toBe(true);
  });

  test('unknown display values fall back to the defaults', async ({ page }) => {
    await openApp(page, '?theme=neon&density=huge&font=comic&lang=fr&drill=modal&layout=grid');
    const root = page.locator('.mscd').first();
    await expect(root).toHaveAttribute('data-theme', 'light');
    await expect(root).toHaveAttribute('data-density', 'comfortable');
    await expect(root).toHaveAttribute('data-font', 'plex');
    await expect(ui.title(page)).toHaveText('Portfolio Overview');
    await expect(page.locator('main svg[viewBox="0 0 120 120"]')).toHaveCount(4);
  });
});

test.describe('Viewport widths', () => {
  for (const width of [1280, 1920]) {
    for (const ms of SYSTEMS) {
      test(`every ${ms} screen fits at ${width} px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await openIn(page, '', ms);
        await visitAll(page, SCREENS);
        await openIn(page, '?lang=id&density=airy', ms);
        await visitAll(page, SCREENS_ID);
      });
    }
  }

  test('below the minimum width the app keeps its 1180 px layout and scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await openApp(page);
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(sw).toBe(1180);
    await expect(page.locator('.mscd').first()).toHaveCSS('min-width', '1180px');
  });
});
