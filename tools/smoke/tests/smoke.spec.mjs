// Full-stack smoke test (build plan J.9): one user journey through the web image, the api, the worker, the storage
// gateway, the provider mocks, Mailpit and Keycloak of the Compose demo stack. The steps run in order in one
// browser context and share its session, so a later step starts where the one before it ended.
import { createHash, randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { smokeSettings } from '../lib/settings.mjs';
import { demoCode, secondsLeftInStep } from '../lib/totp.mjs';

const settings = smokeSettings();
const PASSWORD = 'Mscd-Demo-2026!';
const RINA = { handle: 'rina', email: 'rina.kusuma@nusantaradigital.co.id', name: 'Rina Kusuma' };
const BAGUS = { handle: 'bagus', email: 'bagus.prasetyo@nusantaradigital.co.id', name: 'Bagus Prasetyo' };

// ---- locators of the dashboard (the same structure the sample E2E suite of apps/web uses) ----
const ui = {
  title: (page) => page.locator('main h1'),
  toast: (page) => page.locator('div[style*="z-index: 60"]'),
  drawer: (page) => page.locator('div[style*="z-index: 41"]'),
  drawerBackdrop: (page) => page.locator('div[style*="z-index: 40"]'),
  modal: (page) => page.locator('div[style*="z-index: 51"]'),
  nav: (page, label) => page.locator(`aside nav button[title="${label}"]`),
  msSwitch: (page) => page.locator('header button[title="Switch management system"]'),
  roleButton: (page) => page.locator('header > div:last-child > div:last-child > button'),
  pageAction: (page, label) => page.locator(`main button[title="${label}"]`).first(),
  portfolioCards: (page) =>
    page.locator('main div[style*="box-shadow"][style*="flex-direction: column"]').filter({ has: page.locator('svg polygon') }),
};
const list = (page) => page.locator('main input[placeholder^="Search"]').locator('xpath=../..');
const listRows = (page) => list(page).locator('tbody > tr[style*="cursor: pointer"]');
const listRow = (page, text) => listRows(page).filter({ hasText: text }).first();
const tabs = (page) => page.locator('main button[style*="flex: 1 1 0"]');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tab = (page, label) => tabs(page).filter({ has: page.locator('div', { hasText: new RegExp(`^${esc(label)}$`) }) });
const drawerAction = (page, label) => ui.drawer(page).locator(`button[title="${label}"]`);
const drawerFact = (page, label) =>
  ui.drawer(page).locator(`xpath=.//div[normalize-space(text())="${label}"]/following-sibling::div[1]`);

async function tabCount(page, label) {
  const text = await tab(page, label).locator('span').first().innerText();
  return Number(text.trim());
}

async function closeDrawerIfOpen(page) {
  if (await ui.drawer(page).count()) {
    await ui.drawerBackdrop(page).click({ position: { x: 20, y: 450 } });
    await expect(ui.drawer(page)).toHaveCount(0);
  }
}

async function go(page, label) {
  await closeDrawerIfOpen(page);
  await ui.nav(page, label).click();
  await expect(ui.title(page)).toHaveText(label);
}

async function switchMs(page, short) {
  await closeDrawerIfOpen(page);
  await ui.msSwitch(page).click();
  await page
    .locator('header div[style*="width: 420px"] button')
    .filter({ has: page.locator('span', { hasText: new RegExp(`^${short}$`) }) })
    .click();
  await expect(ui.msSwitch(page)).toContainText(short);
}

async function openRow(page, id) {
  await listRow(page, id).click();
  await expect(ui.drawer(page)).toBeVisible();
  await expect(ui.drawer(page)).toContainText(id);
}

/**
 * Clicks a button of a modal. The modal is centred with a fixed position and has no scroll area, so with a long
 * repository listing (the demo SharePoint folder holds more than 80 files) its first rows and its footer are
 * outside the window and a mouse cannot reach them. A keyboard user still can: the button is focused and Enter is
 * pressed, and the test records the overflow as an annotation of the report.
 *
 * This is a temporary workaround for a finding of WP-31 against WP-25 and WP-14 (picker without a scroll area).
 * SMOKE_STRICT_LAYOUT=1 makes the overflow a test failure; once the picker or the fixture is fixed, the strict
 * behaviour becomes the default and the keyboard path is removed.
 */
const STRICT_LAYOUT = process.env.SMOKE_STRICT_LAYOUT === '1' || process.env.SMOKE_STRICT_LAYOUT === 'true';

async function pressModalButton(page, locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  if (box && viewport && box.y >= 0 && box.y + box.height <= viewport.height) {
    await locator.click();
    return;
  }
  const modalBox = await ui.modal(page).boundingBox();
  const note = `the modal is ${Math.round(modalBox?.height ?? 0)} px high in a ${viewport?.height} px window; "${(await locator.innerText()).split('\n')[0]}" was pressed with the keyboard`;
  test.info().annotations.push({ type: 'layout', description: note });
  console.warn(`smoke: layout: ${note}`);
  if (STRICT_LAYOUT) throw new Error(`layout: ${note} (SMOKE_STRICT_LAYOUT=1: a mouse user cannot reach the button)`);
  await locator.focus();
  await page.keyboard.press('Enter');
}

async function expectToast(page, text) {
  await expect(ui.toast(page)).toContainText(text);
}

/** Enters the current TOTP code of a demo user on the second-factor page (F.5). */
async function enterTotp(page, handle) {
  await expect(page).toHaveURL(/\/login\/mfa/);
  const code = page.locator('#au-code');
  await expect(code).toBeVisible();
  // A code entered in the last seconds of its step can expire on the way to the server: wait for the next step.
  if (secondsLeftInStep() < 4) await page.waitForTimeout(secondsLeftInStep() * 1000 + 500);
  await code.fill(demoCode(handle));
  // Six digits submit the form; the button is pressed only when it is still there and enabled.
  const submit = page.locator('.au-form button[type="submit"]');
  await page.waitForTimeout(300);
  if ((await submit.count()) && (await submit.isEnabled().catch(() => false)) && /\/login\/mfa/.test(page.url())) {
    await submit.click().catch(() => {});
  }
}

async function signOut(page) {
  await closeDrawerIfOpen(page);
  await ui.roleButton(page).click();
  await page.locator('header div[style*="width: 300px"] button', { hasText: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.locator('#au-email')).toBeVisible();
}

// ---- Mailpit API (http://127.0.0.1:<MSCD_MAILPIT_PORT>/api/v1) ----
async function mailpit(pathAndQuery, init) {
  const res = await fetch(`${settings.mailpitUrl}/api/v1/${pathAndQuery}`, init);
  if (!res.ok) throw new Error(`Mailpit ${init?.method ?? 'GET'} ${pathAndQuery} answered ${res.status}`);
  return res.status === 200 && res.headers.get('content-type')?.includes('json') ? res.json() : null;
}

test.describe.configure({ mode: 'serial' });

test.describe('MSCD full stack', () => {
  /** @type {import('@playwright/test').BrowserContext} */
  let context;
  /** @type {import('@playwright/test').Page} */
  let page;
  const problems = [];

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('response', (r) => {
      if (r.status() >= 500) problems.push(`${r.status()} ${r.request().method()} ${r.url()}`);
    });
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('the stack answers through the web image', async ({ request }) => {
    const health = await request.get('/healthz');
    expect(health.status()).toBe(200);
    const profile = await request.get('/api/v1/system/profile');
    expect(profile.status()).toBe(200);
    const body = await profile.json();
    expect(body.demo).toMatchObject({ enabled: true });
    const providers = await (await request.get('/api/v1/auth/providers?org=ndt')).json();
    expect(providers.providers.map((p) => p.slug)).toContain('keycloak');
    const info = await mailpit('info');
    expect(info).toHaveProperty('Version');
  });

  test('rina signs in with password and TOTP', async () => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
    await page.locator('#au-email').fill(RINA.email);
    await page.locator('#au-password').fill(PASSWORD);
    await page.locator('.au-form button[type="submit"]').click();
    await enterTotp(page, RINA.handle);
    await expect(ui.title(page)).toHaveText('Portfolio Overview', { timeout: 30_000 });
    const me = await page.request.get('/api/v1/me');
    expect(me.status()).toBe(200);
    expect(JSON.stringify(await me.json())).toContain(RINA.email);
  });

  test('the portfolio shows the four management systems', async () => {
    await expect(ui.portfolioCards(page)).toHaveCount(4);
    for (const short of ['ISMS', 'QMS', 'BCMS', 'ABMS']) {
      await expect(ui.portfolioCards(page).filter({ has: page.locator('span', { hasText: new RegExp(`^${short}$`) }) })).toHaveCount(1);
    }
  });

  test('ISMS controls show the reference counts', async () => {
    await go(page, 'Controls & requirements');
    await expect(ui.msSwitch(page)).toContainText('ISMS');
    await expect(tabs(page)).toHaveCount(5);
    expect(await tabCount(page, 'Controls implemented')).toBe(61);
    await expect(tab(page, 'Controls implemented')).toContainText('of 93');
    expect(await tabCount(page, 'Partially implemented')).toBe(18);
    expect(await tabCount(page, 'Open gate items, Risk & SoA')).toBe(4);
    expect(await tabCount(page, 'Documents approved')).toBe(14);
    await expect(tab(page, 'Documents approved')).toContainText('of 22');
    expect(await tabCount(page, 'Documents expired')).toBe(5);
  });

  test('marking a control complete confirms with a toast', async () => {
    await tab(page, 'Partially implemented').click();
    await expect(listRows(page)).toHaveCount(18);
    await openRow(page, 'A.5.13');
    await drawerAction(page, 'Mark complete').click();
    await expectToast(page, 'Marked complete: awaiting verification by the MS Manager');
    await expect(ui.drawer(page)).toContainText('Complete, awaiting verification');
    await expect(drawerAction(page, 'Mark complete')).toHaveCount(0);
    await expect(listRow(page, 'A.5.13').locator('td:nth-child(4)')).toHaveText('Complete, awaiting verification');
  });

  test('a SharePoint file is linked from the mock picker', async () => {
    await go(page, 'Evidence freshness');
    await tab(page, 'File cannot be verified').click();
    await openRow(page, 'EV-0124');
    await expect(drawerFact(page, 'Integrity')).toHaveText('Version changed');
    await drawerAction(page, 'Re-link file').click();
    const modal = ui.modal(page);
    await expect(modal).toContainText('Select evidence file from repository');
    await expect(modal).toContainText('Compliance / ISMS / Evidence / 2026 / Q3');
    await pressModalButton(page, modal.locator('button', { hasText: 'Access-Review-Q3-2026.xlsx' }));
    await pressModalButton(page, modal.locator('button', { hasText: 'Link selected file' }));
    await expectToast(page, 'Evidence linked');
    await expect(modal).toHaveCount(0);
    await closeDrawerIfOpen(page);
    await tab(page, 'File cannot be verified').click();
    await expect(listRows(page).filter({ hasText: 'EV-0124' })).toHaveCount(0);
  });

  test('a file uploaded to the Managed Vault (QMS) gets its SHA-256', async () => {
    const content = Buffer.concat([Buffer.from(`MSCD smoke test evidence ${new Date().toISOString()}\n`), randomBytes(64)]);
    const sha256 = createHash('sha256').update(content).digest('hex');
    await switchMs(page, 'QMS');
    await tab(page, 'Expired').click();
    await openRow(page, 'EQ-0154');
    await expect(drawerFact(page, 'Storage')).toContainText('Managed Vault');
    await drawerAction(page, 'Submit evidence').click();
    const modal = ui.modal(page);
    await expect(modal).toContainText('Managed Vault');
    const chooser = page.waitForEvent('filechooser');
    await pressModalButton(page, modal.locator('button', { hasText: 'Upload to Managed Vault' }));
    await (await chooser).setFiles({ name: 'smoke-evidence.txt', mimeType: 'text/plain', buffer: content });
    await expectToast(page, 'SHA-256 recorded');
    await expect(modal).toHaveCount(0);
    await closeDrawerIfOpen(page);
    // The evidence is fresh now: it left the "Expired" tab, so the tab filter is switched off to find it again.
    await expect.poll(() => tabCount(page, 'Expired')).toBe(2);
    await tab(page, 'Expired').click();
    await expect(tab(page, 'Expired')).not.toHaveAttribute('style', /background: var\(--accbg\)/);
    await page.locator('main input[placeholder^="Search"]').fill('EQ-0154');
    await openRow(page, 'EQ-0154');
    await expect(drawerFact(page, 'Fingerprint')).toContainText('SHA-256');
    await expect(drawerFact(page, 'Fingerprint')).toContainText(sha256.slice(0, 10));
    await expect(drawerFact(page, 'Fingerprint')).toContainText(sha256.slice(-4));
  });

  test('the integrity check runs', async () => {
    await closeDrawerIfOpen(page);
    await page.locator('main input[placeholder^="Search"]').fill('');
    await switchMs(page, 'ISMS');
    await ui.pageAction(page, 'Run integrity check').click();
    await expect(ui.toast(page)).toHaveText(/Integrity check started for \d+ references/);
  });

  test('a reminder reaches Mailpit', async () => {
    await mailpit('messages', { method: 'DELETE' });
    await go(page, 'Controls & requirements');
    await openRow(page, 'A.5.1');
    await drawerAction(page, 'Send reminder').click();
    await expectToast(page, `Reminder sent to ${RINA.name}`);
    let found = null;
    await expect
      .poll(
        async () => {
          const result = await mailpit(`search?query=${encodeURIComponent(`to:"${RINA.email}" subject:"Reminder"`)}`);
          found = result.messages?.[0] ?? null;
          return result.messages_count ?? result.total ?? 0;
        },
        { timeout: 90_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toBeGreaterThan(0);
    expect(found.Subject).toMatch(/^\[MSCD\] Reminder/);
    expect(found.To.map((t) => t.Address)).toContain(RINA.email);
    await closeDrawerIfOpen(page);
    await signOut(page);
  });

  test('bagus signs in through Keycloak and the local TOTP step', async () => {
    await page.goto('/login');
    const sso = page.locator('a.au-sso-btn[data-provider="keycloak"]');
    await expect(sso).toBeVisible();
    await sso.click();
    // Keycloak's own login form, on http://keycloak:<port> (mapped to this host).
    await expect(page).toHaveURL(/^http:\/\/keycloak:18088\/realms\/mscd\/protocol\/openid-connect\/auth/);
    await page.locator('#username').fill('bagus');
    await page.locator('#password').fill(PASSWORD);
    await page.locator('#kc-login').click();
    // Keycloak sends no MFA proof, so the provider falls back to the local TOTP step (F.5, G.3).
    await enterTotp(page, BAGUS.handle);
    await expect(ui.title(page)).toBeVisible({ timeout: 30_000 });
    const me = await page.request.get('/api/v1/me');
    expect(me.status()).toBe(200);
    expect(JSON.stringify(await me.json())).toContain(BAGUS.email);
  });

  test('bagus signs out', async () => {
    await signOut(page);
    const me = await page.request.get('/api/v1/me');
    expect(me.status()).toBe(401);
    expect(problems, 'page errors and server errors during the journey').toEqual([]);
  });
});
