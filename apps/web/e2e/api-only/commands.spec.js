import { test, expect, ui, go, openApp, switchMs, openRow, drawerAction, drawerFact, expectToast, tab, tabCount, listRow, search } from '../helpers.js';

// Commands whose API behaviour differs from the sample on purpose (build plan J.6): BR-01 refuses a verification
// without current evidence (E.3), auditors see no Verify (A.4 5.5), a new document version goes to in_review
// (A.4 5.7), the Managed Vault receives a real file (A.4 5.10), and the picker lists the mock SharePoint library.
const BR01 = 'This entry cannot be set to implemented without evidence from the current period';

// The picker modal of the generated views grows with its listing and does not scroll, so with the full
// SharePoint folder of the API its lower rows and the Link button can sit below a 900 px viewport (see the WP-27
// handoff). The tests click those buttons with a DOM click, which needs no scrolling.
const domClick = (locator) => locator.dispatchEvent('click');

test.describe('Commands against the api @api-only', () => {
  test('BR-01 refuses a verification without current evidence with the api message', async ({ page, baseURL }) => {
    // rina (MS Manager of QMS) marks Cl. 6.3 complete; it has no evidence of the current period.
    await openApp(page);
    await go(page, 'Controls & requirements');
    await switchMs(page, 'QMS');
    await tab(page, 'Partially implemented').click();
    await openRow(page, 'Cl. 6.3');
    await drawerAction(page, 'Mark complete').click();
    await expect(ui.drawer(page)).toContainText('Complete, awaiting verification');
    // sari, the primary MS Manager of QMS, verifies (someone other than the person who completed it, A.4 5.4).
    const minted = await page.request.post(baseURL + '/api/v1/test/session', { data: { handle: 'sari' }, headers: { origin: baseURL } });
    expect(minted.ok()).toBe(true);
    await openApp(page);
    await go(page, 'Controls & requirements');
    await switchMs(page, 'QMS');
    await tab(page, 'Partially implemented').click();
    await openRow(page, 'Cl. 6.3');
    await drawerAction(page, 'Verify').click();
    await ui.modal(page).locator('button', { hasText: 'Confirm verification' }).click();
    await expectToast(page, BR01);
    await expect(ui.drawer(page)).toContainText('Complete, awaiting verification');
  });

  test.describe('as the internal auditor', () => {
    test.use({ apiSession: 'maya' });
    test('Verify is hidden for auditors', async ({ page }) => {
      await openApp(page);
      await go(page, 'Controls & requirements');
      await switchMs(page, 'QMS');
      await tab(page, 'Partially implemented').click();
      await openRow(page, 'Cl. 8.7');
      await expect(ui.drawer(page)).toContainText('Complete, awaiting verification');
      await expect(drawerAction(page, 'Verify')).toHaveCount(0);
    });
  });

  test('a document version linked from the SharePoint picker goes to review', async ({ page }) => {
    await openApp(page);
    await go(page, 'Controls & requirements');
    await tab(page, 'Documents approved').click();
    await openRow(page, 'POL-01');
    const before = await drawerFact(page, 'Version').innerText();
    await drawerAction(page, 'Upload new version').click();
    const modal = ui.modal(page);
    await expect(modal).toContainText('Compliance / ISMS / Documents');
    const files = modal.locator('button[style*="grid-template-columns: 1fr auto"]');
    await expect(files.first()).toBeVisible();
    const name = (await files.first().innerText()).split('\n')[0].trim();
    await domClick(modal.locator('button', { hasText: 'Link selected file' }));
    await expectToast(page, `POL-01: ${name} linked, new version in review`);
    // The document waits for its review (A.4 5.7): it left the approved list and the register shows it in review.
    await go(page, 'Document register');
    await expect(listRow(page, 'POL-01')).toContainText('In review');
    expect(before).toMatch(/^v/);
  });

  test('evidence re-linked from the SharePoint picker is pinned with its hash', async ({ page }) => {
    await openApp(page);
    await go(page, 'Evidence freshness');
    await tab(page, 'File cannot be verified').click();
    await openRow(page, 'EV-0124');
    await expect(drawerFact(page, 'Integrity')).toHaveText('Version changed');
    await drawerAction(page, 'Re-link file').click();
    const modal = ui.modal(page);
    await expect(modal).toContainText('Compliance / ISMS / Evidence / 2026 / Q3');
    await domClick(modal.locator('button', { hasText: 'Access-Review-Q3-2026.xlsx' }));
    await domClick(modal.locator('button', { hasText: 'Link selected file' }));
    await expectToast(page, 'Evidence linked: version pinned, hash recorded, Access-Review-Q3-2026.xlsx');
    await expect(ui.modal(page)).toHaveCount(0);
  });

  test('evidence is uploaded to the Managed Vault and its SHA-256 recorded', async ({ page }) => {
    await openApp(page);
    await go(page, 'Evidence freshness');
    await switchMs(page, 'QMS');
    await tab(page, 'Expired').click();
    await openRow(page, 'EQ-0154');
    const expired = await tabCount(page, 'Expired');
    await drawerAction(page, 'Submit evidence').click();
    const chooser = page.waitForEvent('filechooser');
    await ui.modal(page).locator('button', { hasText: 'Upload to Managed Vault' }).click();
    await (await chooser).setFiles({ name: 'Calibration-Log-Sep-2026.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% MSCD E2E evidence\n%%EOF\n') });
    await expectToast(page, 'Evidence uploaded to Managed Vault: SHA-256 recorded');
    // The new file restarts the evidence cycle: EQ-0154 left the expired list and shows the uploaded file's SHA-256.
    await expect.poll(() => tabCount(page, 'Expired')).toBe(expired - 1);
    await tab(page, 'Fresh').click();
    await search(page, 'EQ-0154');
    await openRow(page, 'EQ-0154');
    await expect(drawerFact(page, 'Fingerprint')).toContainText('SHA-256');
  });
});
