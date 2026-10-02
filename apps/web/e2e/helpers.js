import { test as base, expect } from '@playwright/test';

// Every test fails if the browser logs an error, a React warning, or a request fails.
// Google Fonts only serves the optional alternative font pairings, so its failures are ignored.
// The API project (playwright.api.config.js, build plan J.6) sets `dataSource: 'api'`: before every test the api is
// reset to the seed state and a session of `apiSession` (default rina, null for none) is minted (e2e-api/fixtures.js).
export const test = base.extend({
  dataSource: ['sample', { option: true }],
  apiSession: ['rina', { option: true }],
  page: async ({ page, dataSource, apiSession, baseURL }, use) => {
    if (dataSource === 'api') {
      const { prepareApiTest } = await import('../e2e-api/fixtures.js');
      await prepareApiTest(page, { baseURL, handle: apiSession });
    }
    const problems = [];
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    page.on('console', (m) => {
      const text = m.text();
      if (m.type() === 'error' && !text.startsWith('Failed to load resource')) problems.push('console.error: ' + text);
      if (m.type() === 'warning' && /react|warning/i.test(text)) problems.push('console.warn: ' + text);
    });
    page.on('requestfailed', (r) => {
      if (!/fonts\.(googleapis|gstatic)\.com/.test(r.url())) problems.push('requestfailed: ' + r.url());
    });
    await use(page);
    expect(problems, 'browser errors during test').toEqual([]);
  },
});
export { expect };

export const SCREENS = [
  'Portfolio Overview', 'Overview', 'Controls & requirements', 'Phase board', 'Document register',
  'Audit readiness', 'Chain stages', 'Golden Thread Viewer', 'Certification timeline',
  'Evidence freshness', 'Review calendar', 'My Tasks', 'Framework library', 'Storage repositories',
];
export const SCREENS_ID = [
  'Ikhtisar Portofolio', 'Ikhtisar', 'Kontrol & persyaratan', 'Papan fase', 'Register dokumen',
  'Kesiapan audit', 'Tahap rantai', 'Golden Thread Viewer', 'Linimasa sertifikasi',
  'Kesegaran bukti', 'Kalender review', 'Tugas Saya', 'Pustaka framework', 'Repositori penyimpanan',
];
// Screens with a filterable list and row details (the drill-down screens).
export const DRILL_SCREENS = ['Controls & requirements', 'Document register', 'Chain stages', 'Evidence freshness', 'Review calendar', 'Storage repositories'];

export async function openApp(page, query = '') {
  await page.goto('/' + query);
  await expect(page.locator('main h1')).toBeVisible();
}
// The drawer backdrop covers the page, so a user closes an open drawer before navigating.
export async function closeDrawerIfOpen(page) {
  if (await page.locator('div[style*="z-index: 41"]').count()) {
    await page.locator('div[style*="z-index: 40"]').click({ position: { x: 20, y: 450 } });
    await expect(page.locator('div[style*="z-index: 41"]')).toHaveCount(0);
  }
}
export async function go(page, label) {
  await closeDrawerIfOpen(page);
  await page.locator(`aside nav button[title="${label}"]`).click();
  await expect(page.locator('main h1')).toHaveText(label);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const ui = {
  title: (page) => page.locator('main h1'),
  toast: (page) => page.locator('div[style*="z-index: 60"]'),
  drawer: (page) => page.locator('div[style*="z-index: 41"]'),
  drawerBackdrop: (page) => page.locator('div[style*="z-index: 40"]'),
  modal: (page) => page.locator('div[style*="z-index: 51"]'),
  modalBackdrop: (page) => page.locator('div[style*="z-index: 50"]'),
  rows: (page) => page.locator('main table tbody tr'),
  search: (page) => page.locator('main input[placeholder^="Search"]'),
  tera: (page) => page.locator('button[title="Ask Tera"]'),
  teraCard: (page) => page.locator('div[style*="z-index: 45"] > div[style*="width: 340px"]'),
  msSwitch: (page) => page.locator('header button[title="Switch management system"], header button[title="Ganti sistem manajemen"]'),
  pageAction: (page, label) => page.locator(`main button[title="${label}"]`).first(),
  nav: (page, label) => page.locator(`aside nav button[title="${label}"]`),
  navItems: (page) => page.locator('aside nav button'),
  roleButton: (page) => page.locator('header > div:last-child > div:last-child > button'),
  orgButton: (page) => page.locator('aside > div:nth-child(2) > button'),
};

// ---- the list card on drill-down screens (chips, search, table, footer) ----
export const list = (page) => page.locator('main input[placeholder^="Search"], main input[placeholder^="Cari"]').locator('xpath=../..');
export const listRows = (page) => list(page).locator('tbody > tr[style*="cursor: pointer"]');
export const listRow = (page, text) => listRows(page).filter({ hasText: text }).first();
export const groupRows = (page) => list(page).locator('tbody > tr:not([style*="cursor"])').filter({ has: page.locator('td[colspan] > span') });
export const inlineDetails = (page) => list(page).locator('tbody > tr:not([style*="cursor"])').filter({ has: page.locator('td[colspan] > div') });
export const chips = (page) => list(page).locator('xpath=./div[1]/div[1]/button');
export const chip = (page, label) => chips(page).filter({ hasText: new RegExp('^\\s*' + esc(label) + '\\s*\\d+\\s*$') });
export async function chipCount(page, label) {
  return Number(await chip(page, label).locator('span').innerText());
}
export async function shown(page) {
  const t = await list(page).locator('xpath=./div[last()]/span').first().innerText();
  return Number(t.match(/\d+/)[0]);
}
export async function expectShown(page, n) {
  await expect(list(page).locator('xpath=./div[last()]/span').first()).toHaveText(new RegExp('^(Showing|Menampilkan) ' + n + ' '));
}
export const moreButton = (page) => list(page).locator('xpath=./div[last()]/button');
export async function search(page, q) {
  await ui.search(page).fill(q);
}

// ---- summary cards used as tabs (controls, chain stages, freshness) ----
export const tabs = (page) => page.locator('main button[style*="flex: 1 1 0"]');
export const tab = (page, label) => tabs(page).filter({ has: page.locator('div', { hasText: new RegExp('^' + esc(label) + '$') }) });
export async function tabCount(page, label) {
  return Number(await tab(page, label).locator('span').first().innerText());
}
export async function expectTabActive(page, label) {
  await expect(tab(page, label)).toHaveAttribute('style', /background: var\(--accbg\)/);
}
export const activeTab = (page) => page.locator('main button[style*="flex: 1 1 0"][style*="background: var(--accbg)"]');

// ---- detail drawer (panel pattern) ----
export const drawerAction = (page, label) => ui.drawer(page).locator(`button[title="${label}"]`);
export const drawerFact = (page, key) => ui.drawer(page).locator('xpath=.//div[normalize-space(text())="' + key + '"]/following-sibling::div[1]');
export const drawerLinks = (page, which) => ui.drawer(page).locator('xpath=.//div[normalize-space(text())="' + which + '"]/following-sibling::div[1]/button');
export async function openRow(page, text) {
  await listRow(page, text).click();
  await expect(ui.drawer(page)).toBeVisible();
  await expect(ui.drawer(page)).toContainText(text);
}

export async function expectToast(page, text) {
  await expect(ui.toast(page)).toContainText(text);
}
export async function closeDrawer(page) {
  await ui.drawerBackdrop(page).click({ position: { x: 20, y: 450 } });
  await expect(ui.drawer(page)).toHaveCount(0);
}
export async function switchMs(page, short) {
  await closeDrawerIfOpen(page);
  await ui.msSwitch(page).click();
  await page.locator('header div[style*="width: 420px"] button').filter({ has: page.locator('span', { hasText: new RegExp('^' + short + '$') }) }).click();
  await expect(ui.msSwitch(page)).toContainText(short);
}
export async function switchOrg(page, name) {
  await closeDrawerIfOpen(page);
  await ui.orgButton(page).click();
  await page.locator('aside div[style*="min-width: 260px"] button', { hasText: name }).click();
  await expect(ui.orgButton(page)).toContainText(name);
}
export async function switchRole(page, label) {
  await closeDrawerIfOpen(page);
  await ui.roleButton(page).click();
  await page.locator('header div[style*="width: 300px"] button', { hasText: label }).click();
  await expect(page.locator('header div[style*="width: 300px"]')).toHaveCount(0);
}
// Horizontal page overflow means something in the layout is broken.
export async function expectNoHorizontalOverflow(page) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw, 'page scrollWidth').toBeLessThanOrEqual(cw);
}
// The page, the detail drawer and the modal: everything a layout or colour check should cover.
const SCOPE = 'main *, aside *, header *, div[style*="z-index: 41"] *, div[style*="z-index: 51"] *';
// Entry animations (fade and slide in) are jumped to their end state so checks see the resting layout and colours.
export async function finishAnimations(page) {
  await page.evaluate(() => document.getAnimations().forEach((a) => {
    if (a.effect && a.effect.getComputedTiming().iterations !== Infinity) a.finish();
  }));
}
// Text that spills out of its box: an element wider than its own box while overflow stays visible.
export async function expectNoTextOverflow(page) {
  await finishAnimations(page);
  const spills = await page.evaluate((scope) => {
    const out = [];
    for (const el of document.querySelectorAll(scope)) {
      if (['svg', 'path', 'g', 'circle', 'line', 'polygon', 'text', 'rect'].includes(el.tagName.toLowerCase())) continue;
      if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === 'visible' && el.children.length < 6) {
        out.push(el.tagName + ' "' + (el.innerText || '').replace(/\s+/g, ' ').slice(0, 60) + '" ' + el.scrollWidth + '>' + el.clientWidth);
      }
    }
    return out;
  }, SCOPE);
  expect(spills, 'elements whose text spills out of their box').toEqual([]);
}
// Contrast between each visible text and the colour actually behind it (WCAG ratio). Backgrounds and
// opacities of every ancestor are composited, so text on a filled badge or inside a faded card is measured as drawn.
export async function contrastProblems(page, min = 3, scope = SCOPE) {
  await finishAnimations(page);
  return page.evaluate(({ scope, min }) => {
    const parse = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return { r: 0, g: 0, b: 0, a: 0 }; const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    // premultiplied "source over destination"
    const over = (s, d) => ({ r: s.r * s.a + d.r * d.a * (1 - s.a), g: s.g * s.a + d.g * d.a * (1 - s.a), b: s.b * s.a + d.b * d.a * (1 - s.a), a: s.a + d.a * (1 - s.a) });
    const solid = (c) => (c.a ? { r: c.r / c.a, g: c.g / c.a, b: c.b / c.a, a: 1 } : c);
    const fade = (c, o) => ({ ...c, a: c.a * o });
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const out = [];
    for (const el of document.querySelectorAll(scope)) {
      if (el.closest('svg')) continue;
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
      if (!own || !el.getClientRects().length) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility !== 'visible') continue;
      // the text pixel and the background pixel next to it, built up from the element to the page root
      const bg = parse(cs.backgroundColor);
      let text = over(parse(cs.color), bg), back = bg;
      for (let e = el; e; e = e.parentElement) {
        if (e !== el) { const b = parse(getComputedStyle(e).backgroundColor); if (b.a) { text = over(text, b); back = over(back, b); } }
        const o = Number(getComputedStyle(e).opacity); if (o < 1) { text = fade(text, o); back = fade(back, o); }
      }
      const page = parse(getComputedStyle(document.body).backgroundColor);
      const t = solid(over(text, page)), k = solid(over(back, page));
      const [hi, lo] = [lum(t), lum(k)].sort((a, b) => b - a);
      const ratio = (hi + 0.05) / (lo + 0.05);
      if (ratio < min) out.push(`${ratio.toFixed(2)}:1 "${own.slice(0, 40)}" ${cs.color} on rgb(${[k.r, k.g, k.b].map(Math.round).join(', ')})`);
    }
    return out;
  }, { scope, min });
}
export async function expectReadableText(page, min = 3) {
  expect(await contrastProblems(page, min), `text below ${min}:1 contrast`).toEqual([]);
}
