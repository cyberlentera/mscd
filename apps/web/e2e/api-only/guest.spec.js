import { test, expect, ui, go, expectToast } from '../helpers.js';
import { totpOf, waitForMail, freshTotpStep } from '../../e2e-api/fixtures.js';

// Guest auditor access (build plan F.14, D-27, J.6): rina grants access from Audit readiness, the auditor opens the
// emailed single-use link, enters the emailed one-time code, enrols TOTP and reads the system without changing it.
const AUDITOR = 'lead.auditor@certifier.co.id';

test.describe('Guest auditor access @api-only', () => {
  test('a grant emails a link; the guest enters the emailed code, enrols TOTP and reads the audited system', async ({ page, browser, baseURL }) => {
    test.setTimeout(150_000);
    await page.goto('/');
    await expect(ui.title(page)).toBeVisible();
    await go(page, 'Audit readiness');
    page.once('dialog', (dialog) => dialog.accept(AUDITOR));
    await ui.pageAction(page, 'Auditor access').click();
    await expectToast(page, `the link was emailed to ${AUDITOR}`);

    const [link] = await waitForMail(AUDITOR, /https?:\/\/\S+\/guest#[A-Za-z0-9_-]+/);
    const guest = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
    try {
      const gp = await guest.newPage();
      await gp.goto(link.replace(/^https?:\/\/[^/]+/, baseURL));
      const [, code] = await waitForMail(AUDITOR, /one-time code is (\d{6})/);
      // The sixth digit submits the code.
      await gp.getByLabel('Code from the email').fill(code);
      await expect(gp).toHaveURL(/\/login\/enrol/);
      const secret = (await gp.getByTestId('enrol-secret').innerText()).replace(/\s+/g, '');
      await freshTotpStep();
      await gp.getByLabel('Code from the app').fill(totpOf(secret));
      await expect(gp.locator('ul.au-codes li')).toHaveCount(10);
      await gp.getByRole('checkbox').check();
      await gp.getByRole('button', { name: 'Continue to MSCD' }).click();
      // The guest session reads the audited system and changes nothing (F.14).
      await expect.poll(async () => (await gp.request.get('/api/v1/me')).status()).toBe(200);
      const me = await (await gp.request.get('/api/v1/me')).json();
      expect(me.user.handle).toMatch(/^guest-[0-9a-f]{8}$/);
      expect(me.rolesByMs).toEqual({ isms: ['external_auditor'] });
      const read = await gp.request.get('/api/v1/ui/ms/isms');
      expect(read.status()).toBe(200);
      expect((await read.json()).bundle.phases).toEqual([]);
      const write = await gp.request.post('/api/v1/reminders/bulk', { data: { ms: 'isms', scope: 'open_chain_items' }, headers: { origin: baseURL, 'x-csrf-token': me.csrfToken } });
      expect(write.status()).toBe(403);
      // Known defect (WP-27 handoff): the app crashes on the guest's landing screen because the controller expects at
      // least one implementation phase, and the external auditor projection (G.5) has none.
    } catch (error) {
      for (const p of guest.pages()) await test.info().attach('guest page', { body: await p.screenshot(), contentType: 'image/png' });
      throw error;
    } finally {
      await guest.close();
    }
  });
});
