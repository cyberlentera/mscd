import { test, expect, ui } from '../helpers.js';
import { DEMO_PASSWORD, EMAILS, demoCode, freshTotpStep, totpOf } from '../../e2e-api/fixtures.js';

// Sign-in, enrolment, sign-out and session end against the api (build plan J.6, F.4, F.5, H.6, H.7). Every test signs
// in a different user (maya, mfa.tester, hendra, sari), so no user uses a TOTP step twice; the reset before each test
// also clears `last_used_step`. These tests start without a session.
test.use({ apiSession: null });

async function signInWithPassword(page, email) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Work email').fill(email);
  await page.locator('#au-password').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
}

async function signIn(page, handle) {
  await freshTotpStep();
  await signInWithPassword(page, EMAILS[handle]);
  await expect(page).toHaveURL(/\/login\/mfa/);
  // The sixth digit submits the code.
  await page.getByLabel('Authentication code').fill(demoCode(handle));
  await expect(ui.title(page)).toBeVisible();
}

test.describe('Sign-in @api-only', () => {
  test('a user signs in with password and TOTP and lands in the app', async ({ page }) => {
    await signIn(page, 'maya');
    await expect(page).not.toHaveURL(/\/login/);
    await ui.roleButton(page).click();
    await expect(page.locator('header div[style*="width: 300px"]')).toContainText('Sign out');
  });

  test('a wrong second factor keeps the user on the code step', async ({ page }) => {
    await freshTotpStep();
    await signInWithPassword(page, EMAILS.maya);
    await expect(page).toHaveURL(/\/login\/mfa/);
    const wrong = demoCode('maya') === '000000' ? '111111' : '000000';
    await page.getByLabel('Authentication code').fill(wrong);
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/login\/mfa/);
  });

  test('a user without a second factor enrols TOTP, sees recovery codes and continues to the app', async ({ page }) => {
    await signInWithPassword(page, EMAILS['mfa.tester']);
    await expect(page).toHaveURL(/\/login\/enrol/);
    const secret = (await page.getByTestId('enrol-secret').innerText()).replace(/\s+/g, '');
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
    await freshTotpStep();
    await page.getByLabel('Code from the app').fill(totpOf(secret));
    const codes = page.locator('ul.au-codes li');
    await expect(codes).toHaveCount(10);
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Continue to MSCD' }).click();
    await expect(ui.title(page)).toBeVisible();
  });

  test('Sign out ends the session and returns to the sign-in page', async ({ page }) => {
    await signIn(page, 'hendra');
    await ui.roleButton(page).click();
    await page.locator('header div[style*="width: 300px"] button', { hasText: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText('You have signed out.')).toBeVisible();
    // The session is gone on the server too.
    expect((await page.request.get('/api/v1/me')).status()).toBe(401);
  });

  test('a session that ends on the server sends the user back to sign in with a notice', async ({ page, baseURL }) => {
    await signIn(page, 'sari');
    // The test reset recreates the database, which ends every session (as an idle or absolute timeout does).
    const reset = await page.request.post(baseURL + '/api/v1/test/reset', { headers: { origin: baseURL } });
    expect(reset.ok()).toBe(true);
    await ui.roleButton(page).click();
    await page.locator('header div[style*="width: 300px"] button').first().click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText('Your session has ended. Sign in again.')).toBeVisible();
  });
});
