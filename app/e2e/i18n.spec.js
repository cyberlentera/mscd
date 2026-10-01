import {
  test, expect, SCREENS, SCREENS_ID, openApp, go, ui, list, listRows, groupRows, tabs, switchMs, closeDrawer,
} from './helpers.js';
import * as D from '../src/data/mscd-data.js';

const SYSTEMS = ['ISMS', 'QMS', 'BCMS', 'ABMS'];
const TAB_SCREENS = [2, 6, 9];

// Labels that are the same word in Indonesian, product and feature names, and storage mode names.
const SAME = new Set([
  'Status', 'Audit', 'No.', 'Minor', 'Beta', 'item', 'SoA',
  // the Indonesian interface uses "gate" as its term throughout (Item gate terbuka, Menahan gate)
  'GATE',
  'Golden Thread Viewer', 'Tera', 'Link', 'Upload', 'Zero-transit', 'Pass-through',
  'SaaS, region Jakarta',
]);
// Sample organisation data is content, not interface text: people, organisations, systems, repositories.
const DATA = new Set([
  ...Object.values(D.PEOPLE).flat(),
  'PT Nusantara Digital Teknologi', 'PT Bank Sentosa Digital', 'RS Medika Nusantara',
  ...D.MS.flatMap((m) => [m.short, m.code, m.pack, m.certifier, m.lead].flat()),
  ...Object.values(D.LOC).flatMap((l) => [l[0], l[2]]),
  ...D.REPOS.flatMap((r) => [r.name, r.type]),
]);
// IDs, codes, versions, dates, numbers and all-capital abbreviations (ISMS, MSCD, EN, ID, initials).
const CODE = /^(?:[A-Z][A-Za-z]{0,4}[-.]\s?[A-Z]?\d|Cl\. ?\d|ISO|v\d|rev \d|\d|[A-Z]{2,5}$)/;
const allowed = (s) => SAME.has(s) || DATA.has(s) || CODE.test(s);

// Interface labels on screen: header and sidebar text and tooltips, table headers, button labels
// (the tooltip of icon-only buttons), summary tab labels, drawer fact keys and the modal.
function collectLabels() {
  const out = new Set();
  const add = (t) => { t = (t || '').replace(/\s+/g, ' ').trim(); if (/[A-Za-z]{2,}/.test(t)) out.add(t); };
  const shown = (el) => el.getClientRects().length > 0;
  const own = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ');
  for (const root of document.querySelectorAll('header, aside')) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) if (n.parentElement && shown(n.parentElement) && !n.parentElement.closest('svg')) add(n.textContent);
    root.querySelectorAll('[title]').forEach((el) => shown(el) && add(el.title));
  }
  const drawer = 'div[style*="z-index: 41"]', modal = 'div[style*="z-index: 51"]';
  for (const zone of document.querySelectorAll(`main, ${drawer}, ${modal}`)) {
    zone.querySelectorAll('th').forEach((el) => shown(el) && add(el.textContent));
    zone.querySelectorAll('button').forEach((el) => {
      if (!shown(el)) return;
      add(own(el));
      if (!el.textContent.trim() && el.title) add(el.title);
    });
    zone.querySelectorAll('button[style*="flex: 1 1 0"] > div:nth-child(2)').forEach((el) => add(el.textContent));
  }
  document.querySelectorAll(`${drawer} div[style*="grid-template-columns: 150px 1fr"] > div:nth-child(odd)`).forEach((el) => add(el.textContent));
  document.querySelectorAll(`${modal} > div:first-child > div, ${modal} label > span`).forEach((el) => add(el.textContent));
  return [...out];
}

// Walk one system in one language and record the labels of every state: each screen, each summary tab,
// the first row's drawer and its Reassign form.
async function walk(page, query, ms, labels) {
  const states = new Map();
  const snap = async (key) => states.set(key, new Set(await page.evaluate(collectLabels)));
  await openApp(page, query);
  if (ms !== 'ISMS') await switchMs(page, ms);
  for (const [i, label] of labels.entries()) {
    await go(page, label);
    await snap(`${SCREENS[i]}`);
    if (TAB_SCREENS.includes(i)) {
      const n = await tabs(page).count();
      for (let k = 0; k < n; k++) {
        await tabs(page).nth(k).click();
        await snap(`${SCREENS[i]}, tab ${k + 1}`);
      }
    }
    if (await list(page).count() && await listRows(page).count()) {
      await listRows(page).first().click();
      await expect(ui.drawer(page)).toBeVisible();
      await snap(`${SCREENS[i]}, drawer`);
      const reassign = ui.drawer(page).locator('button[title="Reassign"], button[title="Alihkan"]');
      if (await reassign.count()) {
        await reassign.click();
        await expect(ui.modal(page)).toBeVisible();
        await snap(`${SCREENS[i]}, Reassign`);
        await page.keyboard.press('Escape');
      }
      await closeDrawer(page);
    }
  }
  return states;
}

test.describe('Indonesian interface', () => {
  for (const ms of SYSTEMS) {
    test(`no ${ms} interface label stays in English`, async ({ page }) => {
      const en = await walk(page, '', ms, SCREENS);
      const id = await walk(page, '?lang=id', ms, SCREENS_ID);
      expect([...id.keys()]).toEqual([...en.keys()]);
      const untranslated = [];
      for (const [state, labels] of id) {
        for (const s of labels) if (en.get(state).has(s) && !allowed(s)) untranslated.push(`${state}: ${s}`);
      }
      expect(untranslated, 'labels identical in English and Indonesian').toEqual([]);
    });
  }

  test('generated sentences, dates and plurals follow the language', async ({ page }) => {
    await openApp(page, '?lang=id');
    await go(page, 'Tugas Saya');
    await expect(page.locator('main')).toContainText('28 Sep 2026 sampai 4 Okt 2026');
    await expect(page.locator('main')).toContainText('Rekaman');
    await expect(page.locator('main')).toContainText('Selesaikan penerapan classification of information');
    await go(page, 'Register dokumen');
    await expect(groupRows(page)).toHaveText([/^Kebijakan\s*\d+$/, /^Standar\s*\d+$/, /^Prosedur\s*\d+$/, /^Rencana\s*\d+$/, /^Register\s*\d+$/]);
    await go(page, 'Pustaka framework');
    await expect(page.locator('main')).toContainText('Pack beta');
    await expect(page.locator('main')).toContainText('2015 dalam transisi');
    await go(page, 'Repositori penyimpanan');
    await expect(page.locator('main')).toContainText('Retensi 6 tahun, enkripsi per tenant');
    await go(page, 'Linimasa sertifikasi');
    await expect(page.locator('main')).toContainText('Event audit, ISMS');
    await expect(page.locator('main')).toContainText('Resert + transisi');
    await go(page, 'Ikhtisar Portofolio');
    await expect(page.locator('main')).toContainText('16 item tertunda jatuh tempo setelah tanggal audit');
    await expect(page.locator('aside')).toContainText('Organisasi');
    await expect(page.locator('aside')).toContainText('Surveilans');
    await expect(page.locator('aside')).toContainText('Paket framework');
    await expect(page.locator('header')).toContainText('Manajer SM, ISMS Manager');
    await expect(page.locator('aside button[title="Ciutkan"]')).toHaveCount(1);
    await expect(page.locator('header button[title="Tema"]')).toHaveCount(1);
  });
});
