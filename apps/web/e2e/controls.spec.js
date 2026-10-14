import {
  test, expect, openApp, go, ui, list, listRows, listRow, chips, chip, chipCount, expectShown, moreButton, search,
  tab, tabs, tabCount, activeTab, drawerAction, drawerFact, drawerLinks, drawerPlain, openRow, expectToast, switchRole, switchMs, closeDrawer,
} from './helpers.js';

const heads = (page) => list(page).locator('thead th');
const statusCells = (page) => listRows(page).locator('td:nth-child(4)');
const isActiveChip = (locator) => expect(locator).toHaveAttribute('style', /background: var\(--tx\)/);
const footer = (page) => list(page).locator('xpath=./div[last()]/span').first();
const freshTabs = async (page) => {
  await go(page, 'Evidence status');
  const out = {};
  for (const label of ['Fresh', 'Aging', 'Expired', 'Critical']) out[label] = await tabCount(page, label);
  out.of = await tab(page, 'Fresh').locator('span').nth(1).innerText();
  return out;
};

async function openControls(page, query = '') {
  await openApp(page, query);
  await go(page, 'Annex A controls');
}

test.describe('Annex A controls', () => {
  test('five summary tabs show counts and switch the table', async ({ page }) => {
    await openControls(page);
    await expect(tabs(page)).toHaveCount(5);
    expect(await tabCount(page, 'Controls implemented')).toBe(61);
    await expect(tab(page, 'Controls implemented')).toContainText('of 93');
    expect(await tabCount(page, 'Partially implemented')).toBe(18);
    expect(await tabCount(page, 'Blocking items, Risk & SoA')).toBe(4);
    expect(await tabCount(page, 'Documents approved')).toBe(14);
    await expect(tab(page, 'Documents approved')).toContainText('of 22');
    expect(await tabCount(page, 'Documents expired')).toBe(5);

    await expect(activeTab(page)).toContainText('Controls implemented');
    await expect(heads(page)).toHaveText(['', 'ID', 'Title & status note', 'Status', 'Owner', 'Implementing document', 'Last evidence', 'File location']);
    await expect(listRows(page)).toHaveCount(30);
    await expect(statusCells(page)).toHaveText(Array(30).fill('Implemented'));

    await tab(page, 'Partially implemented').click();
    await expect(activeTab(page)).toContainText('Partially implemented');
    await expect(listRows(page)).toHaveCount(18);
    await expectShown(page, 18);
    await expect(moreButton(page)).toHaveCount(0);

    await tab(page, 'Blocking items, Risk & SoA').click();
    await expect(heads(page)).toHaveText(['', 'Blocking item', 'Type', 'Why it blocks', 'Assigned to', 'Due date']);
    await expect(chips(page)).toHaveCount(0);
    await expect(listRows(page).locator('td:nth-child(2)')).toHaveText(['A.5.23', 'A.8.12', 'R-031', 'SOA-01']);
    await expect(listRows(page).locator('td:nth-child(3)')).toHaveText(['Control', 'Control', 'Risk', 'SoA']);

    await tab(page, 'Documents approved').click();
    await expect(heads(page)).toHaveText(['', 'ID', 'Title & status note', 'Status', 'Owner', 'Version', 'Approved on', 'Review due', 'File location']);
    await expect(listRows(page)).toHaveCount(14);
    await isActiveChip(chip(page, 'Approved'));

    await tab(page, 'Documents expired').click();
    await expect(listRows(page).locator('td:nth-child(2)')).toHaveText(['STD-04', 'PRC-07', 'PRC-11', 'PRC-15', 'REG-03']);
    await expect(statusCells(page)).toHaveText(Array(5).fill('Expired'));
    await isActiveChip(chip(page, 'Expired'));
    // clicking the active tab keeps it selected
    await tab(page, 'Documents expired').click();
    await expect(activeTab(page)).toContainText('Documents expired');
  });

  test('status chips filter the controls with matching counts', async ({ page }) => {
    await openControls(page);
    await expect(chips(page)).toHaveText([/All\s*93/, /Implemented\s*61/, /Partial\s*18/, /Planned\s*6/, /Not started\s*2/, /Blocked\s*2/, /Not applicable\s*4/]);
    await isActiveChip(chip(page, 'Implemented'));
    for (const [label, status, n] of [['Planned', 'Planned', 6], ['Not started', 'Not started', 2], ['Blocked', 'Blocked', 2], ['Not applicable', 'Not applicable', 4], ['Partial', 'Partial', 18]]) {
      await chip(page, label).click();
      await isActiveChip(chip(page, label));
      await expect(listRows(page)).toHaveCount(n);
      await expectShown(page, n);
      await expect(statusCells(page)).toHaveText(Array(n).fill(status));
    }
    await chip(page, 'All').click();
    await expectShown(page, 30);
    await expect(moreButton(page)).toHaveText('+ 63');
  });

  test('search filters the list and clearing it restores the rows', async ({ page }) => {
    await openControls(page);
    await chip(page, 'All').click();
    await search(page, 'backup');
    await expect(listRows(page)).toHaveCount(1);
    await expect(footer(page)).toHaveText('Showing 1 item');
    await expect(listRows(page).first()).toContainText('A.8.13');
    await expect(listRows(page).first()).toContainText('Information backup');
    await search(page, 'Fajar');
    await expect(listRows(page)).toHaveCount(14);
    await expect(listRows(page).locator('td:nth-child(5)')).toHaveText(Array(14).fill(/Fajar Nugroho/));
    await search(page, 'Fajar planned');
    await expect(listRows(page)).toHaveCount(1);
    await expect(listRows(page).first()).toContainText('A.7.4');
    await search(page, 'no such control zzz');
    await expect(listRows(page)).toHaveCount(0);
    await expect(footer(page)).toHaveText('Showing 0 items');
    await expect(list(page)).toContainText('Nothing matches these filters');
    await search(page, '');
    await expectShown(page, 30);
    await expect(moreButton(page)).toHaveText('+ 63');
  });

  test('"+ N" loads more rows and a new filter starts from the first page again', async ({ page }) => {
    await openControls(page);
    await expectShown(page, 30);
    await expect(moreButton(page)).toHaveText('+ 31');
    await moreButton(page).click();
    await expect(listRows(page)).toHaveCount(60);
    await expect(moreButton(page)).toHaveText('+ 1');
    await moreButton(page).click();
    await expect(listRows(page)).toHaveCount(61);
    await expect(moreButton(page)).toHaveCount(0);
    await expect(listRows(page).last()).toContainText('A.8.31');
    await chip(page, 'All').click();
    await expect(listRows(page)).toHaveCount(30);
    await expect(moreButton(page)).toHaveText('+ 63');
  });

  test('row opens a detail drawer with facts and working links', async ({ page }) => {
    await openControls(page);
    await tab(page, 'Partially implemented').click();
    await openRow(page, 'A.8.13');
    const drawer = ui.drawer(page);
    await expect(drawer).toContainText('Information backup');
    await expect(drawer).toContainText('Partial');
    await expect(drawerFact(page, 'Applicability')).toHaveText('Yes');
    await expect(drawerFact(page, 'Linked risks')).toHaveText('R-014, R-031');
    await expect(drawerFact(page, 'Implementing document')).toHaveText('PRC-11, Backup & Restore Procedure, v1.5, Expired');
    await expect(drawerFact(page, 'Operating frequency')).toHaveText('Monthly');
    await expect(drawerFact(page, 'Owner')).toHaveText('Bagus Prasetyo, IT Infrastructure Lead');
    await expect(drawerFact(page, 'Last evidence')).toHaveText('EV-0313, 31 May 2026, Critical');
    await expect(drawerFact(page, 'Integrity')).toHaveText('Missing');
    await expect(drawer.locator('span[data-tip^="Status is held at Partial"]')).toHaveCount(1);
    await expect(drawerLinks(page, 'Linked from')).toHaveText(['R-014', 'R-031']);
    await expect(drawerLinks(page, 'Leads to')).toHaveText(['PRC-11', 'EV-0313']);
    expect(await drawer.locator('button[title]').evaluateAll((b) => b.map((x) => x.title))).toEqual(['Mark complete', 'Send reminder', 'Reassign', 'Trace from here']);

    // upstream risk opens the Golden Thread on that risk
    await drawerLinks(page, 'Linked from').filter({ hasText: 'R-031' }).click();
    await expect(ui.title(page)).toHaveText('Traceability viewer');
    await expect(page.locator('main input[placeholder^="Enter any ID"]')).toHaveValue('R-031');
    await expect(page.locator('main')).not.toContainText('No record found');
    await expect(page.locator('main')).toContainText('Unpatched hypervisor in Surabaya DC');
  });

  test('downstream document and evidence links open their own detail', async ({ page }) => {
    await openControls(page);
    await tab(page, 'Partially implemented').click();
    await openRow(page, 'A.8.13');
    await drawerLinks(page, 'Leads to').filter({ hasText: 'PRC-11' }).click();
    await expect(activeTab(page)).toContainText('Documents expired');
    await expect(ui.drawer(page)).toContainText('PRC-11');
    await expect(ui.drawer(page)).toContainText('Backup & Restore Procedure');
    await expect(drawerFact(page, 'Tier')).toHaveText('Procedure');

    await closeDrawer(page);
    await tab(page, 'Partially implemented').click();
    await openRow(page, 'A.8.13');
    await drawerLinks(page, 'Leads to').filter({ hasText: 'EV-0313' }).click();
    await expect(ui.title(page)).toHaveText('Evidence status');
    await expect(ui.drawer(page)).toContainText('EV-0313');
    await expect(drawerFact(page, 'Control / requirement')).toContainText('A.8.13, Information backup');
  });

  test('a linked control beyond the first page still opens its drawer', async ({ page }) => {
    await openControls(page);
    await tab(page, 'Documents expired').click();
    await openRow(page, 'PRC-07');
    // A.8.2 is row 46 of the implemented list, past the first 30 rows
    await drawerLinks(page, 'Linked from').filter({ hasText: 'A.8.2' }).click();
    await expect(activeTab(page)).toContainText('Controls implemented');
    await expect(ui.drawer(page)).toBeVisible();
    await expect(ui.drawer(page)).toContainText('Privileged access rights');
    await expect(listRow(page, 'A.8.2')).toHaveAttribute('style', /var\(--accbg\)/);
  });

  // @sample-only: the api sends a Domain Owner only their own records, so another holder's document is not in the detail.
  test('a domain owner follows only their own records from the detail and has no Trace', { tag: '@sample-only' }, async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'Domain Owner');
    await go(page, 'Annex A controls');
    await chip(page, 'All').click();
    await openRow(page, 'A.5.9');
    // risks open only in the Traceability viewer, which a Domain Owner does not have
    await expect(drawerLinks(page, 'Linked from')).toHaveCount(0);
    await expect(drawerPlain(page, 'Linked from')).toHaveText(['R-003', 'R-014']);
    // the document is held by Rina Kusuma, the evidence by the owner
    await expect(drawerPlain(page, 'Leads to')).toHaveText(['PRC-05']);
    await expect(drawerLinks(page, 'Leads to')).toHaveText(['EV-0124']);
    await expect(drawerFact(page, 'Implementing document').locator('button')).toHaveCount(0);
    await expect(drawerFact(page, 'Last evidence').locator('button')).toHaveCount(1);
    await expect(drawerAction(page, 'Trace from here')).toHaveCount(0);
    await drawerLinks(page, 'Leads to').click();
    await expect(ui.title(page)).toHaveText('Evidence status');
    await expect(ui.drawer(page)).toContainText('EV-0124');
    await expect(drawerAction(page, 'Trace from here')).toHaveCount(0);
    await drawerFact(page, 'Control / requirement').locator('button').click();
    await expect(ui.title(page)).toHaveText('Annex A controls');
    await expect(ui.drawer(page)).toContainText('A.5.9');
  });

  test('Mark complete moves a control to "awaiting verification" and blocks self-verification', async ({ page }) => {
    await openControls(page);
    await tab(page, 'Partially implemented').click();
    await openRow(page, 'A.5.13');
    await drawerAction(page, 'Mark complete').click();
    await expectToast(page, 'Marked complete: awaiting verification by the MS Manager');
    await expect(ui.drawer(page)).toContainText('Complete, awaiting verification');
    await expect(drawerAction(page, 'Mark complete')).toHaveCount(0);
    await expect(ui.drawer(page).locator('span[data-tip^="Marked complete by Rina Kusuma"]')).toHaveCount(1);
    // the tab still counts it, the chips split partial and awaiting verification, and both stay selected
    expect(await tabCount(page, 'Partially implemented')).toBe(18);
    expect(await chipCount(page, 'Partial')).toBe(17);
    expect(await chipCount(page, 'Complete, awaiting verification')).toBe(1);
    await isActiveChip(chip(page, 'Partial'));
    await isActiveChip(chip(page, 'Complete, awaiting verification'));
    await expect(listRows(page)).toHaveCount(18);
    await expect(listRow(page, 'A.5.13').locator('td:nth-child(4)')).toHaveText('Complete, awaiting verification');

    // the person who completed it cannot verify it
    await drawerAction(page, 'Verify').click();
    await expectToast(page, 'You completed this item: verification must be done by someone else');
    await expect(ui.modal(page)).toHaveCount(0);
    expect(await tabCount(page, 'Controls implemented')).toBe(61);
  });

  // @sample-only: auditors do not verify in API mode (A.4 5.5); BR-01 may also reject the verification (E.3).
  test('Mark complete and Verify never create or refresh evidence', { tag: '@sample-only' }, async ({ page }) => {
    await openApp(page);
    const before = await freshTabs(page);
    expect(before).toEqual({ Fresh: 64, Aging: 6, Expired: 6, Critical: 3, of: 'of 79' });
    await go(page, 'Annex A controls');
    // A.5.7 is Planned and has no evidence; A.5.13 is Partial with aging evidence
    await chip(page, 'Planned').click();
    await openRow(page, 'A.5.7');
    await drawerAction(page, 'Mark complete').click();
    await expectToast(page, 'Marked complete');
    // it left the Planned filter; it still has no evidence of its own
    await expect(ui.drawer(page)).toHaveCount(0);
    await chip(page, 'Complete, awaiting verification').click();
    await openRow(page, 'A.5.7');
    await expect(drawerFact(page, 'Last evidence')).toHaveText('-');
    await closeDrawer(page);
    await tab(page, 'Partially implemented').click();
    await openRow(page, 'A.5.13');
    await expect(drawerFact(page, 'Last evidence')).toContainText('Aging');
    await drawerAction(page, 'Mark complete').click();
    await expect(drawerFact(page, 'Last evidence')).toContainText('Aging');
    expect(await freshTabs(page)).toEqual(before);
    await go(page, 'File storage');
    await chip(page, 'All').click();
    expect(await chipCount(page, 'All')).toBe(119);
    await go(page, 'Outstanding items');
    await tab(page, 'Evidence').click();
    await expect(tab(page, 'Evidence')).toContainText('69 / 79 ready');

    // verification by someone else changes the control, never the evidence
    await switchRole(page, 'Internal Auditor');
    await go(page, 'Annex A controls');
    await chip(page, 'Complete, awaiting verification').click();
    await openRow(page, 'A.5.13');
    await drawerAction(page, 'Verify').click();
    await ui.modal(page).locator('button', { hasText: 'Confirm verification' }).click();
    await expectToast(page, 'Verified');
    expect(await tabCount(page, 'Controls implemented')).toBe(62);
    expect(await freshTabs(page)).toEqual(before);
    await go(page, 'Outstanding items');
    await tab(page, 'Evidence').click();
    await expect(tab(page, 'Evidence')).toContainText('69 / 79 ready');
  });

  // @sample-only: the API picker lists the repository folder instead of the sample picker files (WP-25 deviation 3).
  test('a control held at Partial by its evidence explains the next step and keeps its status after a re-link', { tag: '@sample-only' }, async ({ page }) => {
    await openControls(page);
    await tab(page, 'Partially implemented').click();
    await openRow(page, 'A.8.13');
    const note = ui.drawer(page).locator('span[data-tip^="Status is held at Partial"]');
    await expect(note).toHaveAttribute('data-tip', 'Status is held at Partial because the last evidence is critical for a monthly control. Link current-cycle evidence, then mark the control complete so it can be verified.');
    // keyboard and screen-reader users reach the same note: it takes focus, opens the popover and carries the text as its name
    await expect(note).toHaveAttribute('role', 'img');
    await expect(note).toHaveAttribute('aria-label', 'Status is held at Partial because the last evidence is critical for a monthly control. Link current-cycle evidence, then mark the control complete so it can be verified.');
    await note.focus();
    await expect(page.locator('.mscd-pop')).toHaveText(/^Status is held at Partial/);
    await drawerLinks(page, 'Leads to').filter({ hasText: 'EV-0313' }).click();
    await expect(ui.title(page)).toHaveText('Evidence status');
    await expect(ui.drawer(page).locator('span[data-tip]').first()).toHaveAttribute('data-tip', /stays at Partial\. Re-link the file or submit new evidence, then mark the control complete for verification\./);
    await drawerAction(page, 'Re-link file').click();
    await ui.modal(page).locator('button', { hasText: 'Link selected file' }).click();
    await expectToast(page, 'Evidence linked');
    await go(page, 'Annex A controls');
    await tab(page, 'Partially implemented').click();
    await openRow(page, 'A.8.13');
    // the evidence is current now; the status moves only when someone marks the control complete
    await expect(drawerFact(page, 'Last evidence')).toHaveText('EV-0313, 29 Sep 2026, Fresh');
    await expect(ui.drawer(page)).toContainText('Partial');
    await expect(ui.drawer(page).locator('span[data-tip^="Status is held"]')).toHaveCount(0);
    await drawerAction(page, 'Mark complete').click();
    await expect(ui.drawer(page)).toContainText('Complete, awaiting verification');
  });

  // @sample-only: auditors do not verify in API mode (A.4 5.5); e2e/api-only/commands.spec.js covers the hidden Verify.
  test('a different verifier can verify and the control becomes Implemented', { tag: '@sample-only' }, async ({ page }) => {
    await openControls(page);
    await tab(page, 'Partially implemented').click();
    await openRow(page, 'A.5.13');
    await drawerAction(page, 'Mark complete').click();
    await expectToast(page, 'Marked complete');

    await switchRole(page, 'Internal Auditor');
    await expect(page.locator('header')).toContainText('Maya Putri');
    await expect(ui.title(page)).toHaveText('Annex A controls');
    await chip(page, 'Complete, awaiting verification').click();
    await expect(listRows(page)).toHaveCount(1);
    await openRow(page, 'A.5.13');
    await drawerAction(page, 'Verify').click();
    const modal = ui.modal(page);
    await expect(modal).toContainText('Verify activity output');
    await expect(modal).toContainText('A.5.13, completed by Rina Kusuma, verify as Maya Putri, 29 Sep 2026');
    await modal.locator('button', { hasText: 'Confirm verification' }).click();
    await expect(ui.modal(page)).toHaveCount(0);
    await expectToast(page, 'Verified. Status recalculated on every screen.');
    expect(await tabCount(page, 'Controls implemented')).toBe(62);
    expect(await tabCount(page, 'Partially implemented')).toBe(17);
    await tab(page, 'Controls implemented').click();
    await search(page, 'A.5.13');
    await expect(listRows(page)).toHaveCount(1);
    await expect(statusCells(page)).toHaveText(['Implemented']);
  });

  test('verification can be cancelled without changing the control', async ({ page }) => {
    await openControls(page);
    await switchMs(page, 'QMS');
    await tab(page, 'Partially implemented').click();
    // Cl. 8.7 was completed by its owner; the MS Manager may verify it
    await openRow(page, 'Cl. 8.7');
    await drawerAction(page, 'Verify').click();
    await expect(ui.modal(page)).toContainText('Cl. 8.7, completed by Sari Wulandari, verify as Rina Kusuma, 29 Sep 2026');
    await ui.modal(page).locator('button', { hasText: 'Cancel' }).click();
    await expect(ui.modal(page)).toHaveCount(0);
    await expect(ui.drawer(page)).toContainText('Complete, awaiting verification');
    await drawerAction(page, 'Verify').click();
    await ui.modalBackdrop(page).click({ position: { x: 10, y: 10 } });
    await expect(ui.modal(page)).toHaveCount(0);
    expect(await tabCount(page, 'Requirements implemented')).toBe(22);
  });

  test('Reassign changes the owner and due date and warns when the date is after the audit', async ({ page }) => {
    await openControls(page);
    await tab(page, 'Partially implemented').click();
    await openRow(page, 'A.5.13');
    await drawerAction(page, 'Reassign').click();
    const modal = ui.modal(page);
    await expect(modal).toContainText('Reassign / change due date');
    await expect(modal).toContainText('A.5.13');
    await expect(modal.locator('select')).toHaveValue('bagus');
    // the form starts from the due date the chain shows
    await expect(modal.locator('input[type="date"]')).toHaveValue('2026-10-14');
    await expect(modal).not.toContainText('This date falls after the audit event');
    await modal.locator('select').selectOption('dewi');
    await modal.locator('input[type="date"]').fill('2026-12-01');
    await expect(modal).toContainText('This date falls after the audit event. The item will be flagged Due after audit.');
    await modal.locator('input[type="date"]').fill('2026-11-01');
    await expect(modal).not.toContainText('This date falls after the audit event');
    await modal.locator('input[type="date"]').fill('2026-12-01');
    await modal.locator('button', { hasText: 'Save' }).click();
    await expect(ui.modal(page)).toHaveCount(0);
    await expectToast(page, 'Item updated. Due after audit flag recalculated.');
    await expect(listRow(page, 'A.5.13').locator('td:nth-child(5)')).toContainText('Dewi Anggraini');
    await expect(drawerFact(page, 'Owner')).toHaveText('Dewi Anggraini, HR Manager');

    await go(page, 'Outstanding items');
    await tab(page, 'Control').click();
    const row = listRow(page, 'A.5.13');
    await expect(row).toContainText('Dewi Anggraini');
    await expect(row).toContainText('1 Dec 2026');
    await expect(row).toContainText('Due after audit');
    expect(await chipCount(page, 'Due after audit')).toBe(14);
  });

  test('changing only the holder keeps the chain due date', async ({ page }) => {
    await openControls(page);
    await tab(page, 'Partially implemented').click();
    await openRow(page, 'A.5.13');
    await drawerAction(page, 'Reassign').click();
    await ui.modal(page).locator('select').selectOption('yusuf');
    await ui.modal(page).locator('button', { hasText: 'Save' }).click();
    await go(page, 'Outstanding items');
    await tab(page, 'Control').click();
    const row = listRow(page, 'A.5.13');
    await expect(row).toContainText('Yusuf Rahman');
    await expect(row).toContainText('14 Oct 2026');
    await expect(row).not.toContainText('Missing');
  });

  test('Send reminder confirms who was reminded', async ({ page }) => {
    await openControls(page);
    await openRow(page, 'A.5.1');
    await drawerAction(page, 'Send reminder').click();
    await expectToast(page, 'Reminder sent to Rina Kusuma, email + in-app');
    await closeDrawer(page);
  });

  test('Trace from here opens the Golden Thread with the control filled in', async ({ page }) => {
    await openControls(page);
    await openRow(page, 'A.5.1');
    await drawerAction(page, 'Trace from here').click();
    await expect(ui.title(page)).toHaveText('Traceability viewer');
    await expect(page.locator('main input[placeholder^="Enter any ID"]')).toHaveValue('A.5.1');
    await expect(page.locator('main')).toContainText('Policies for information security');
  });

  test('gate items explain why the gate is held and trace to the SoA stage', async ({ page }) => {
    await openControls(page);
    await tab(page, 'Blocking items, Risk & SoA').click();
    await expect(listRow(page, 'A.5.23')).toContainText('Applicable: no risk-based justification linked');
    await expect(listRow(page, 'A.5.23')).toContainText('Missing');
    await openRow(page, 'A.5.23');
    await expect(ui.drawer(page)).toContainText('Blocking');
    await expect(ui.drawer(page).locator('span[data-tip*="Risk & SoA checkpoint cannot close"]')).toHaveCount(1);
    await expect(drawerAction(page, 'Mark complete')).toHaveCount(0);
    await expect(ui.drawer(page)).toContainText('No evidence this cycle');
    await drawerAction(page, 'Trace from here').click();
    await expect(ui.title(page)).toHaveText('Outstanding items');
    await expect(activeTab(page).locator('div').nth(1)).toHaveText('SoA');

    await go(page, 'Annex A controls');
    await tab(page, 'Blocking items, Risk & SoA').click();
    await openRow(page, 'R-031');
    await expect(ui.drawer(page)).toContainText('Unpatched hypervisor in Surabaya DC');
    await expect(drawerFact(page, 'Step')).toHaveText('Risk');
    await expect(drawerFact(page, 'Next action')).toHaveText('Select a treatment: no treatment linked');
  });

  test('Start review on an expired document changes its status and counts', async ({ page }) => {
    await openControls(page);
    await tab(page, 'Documents expired').click();
    await openRow(page, 'PRC-07');
    await expect(drawerFact(page, 'Review due')).toHaveText('24 Sep 2026, Overdue 5d');
    await expect(drawerLinks(page, 'Linked from')).toHaveText(['A.5.15', 'A.5.16', 'A.5.17', 'A.5.18', 'A.8.2', 'A.8.3']);
    await drawerAction(page, 'Start review').click();
    await expectToast(page, 'PRC-07, review started: assigned to Bagus Prasetyo');
    // the document left the expired list
    await expect(ui.drawer(page)).toHaveCount(0);
    expect(await tabCount(page, 'Documents expired')).toBe(4);
    await expect(listRows(page)).toHaveCount(4);
    expect(await chipCount(page, 'In review')).toBe(2);
    await chip(page, 'In review').click();
    await openRow(page, 'PRC-07');
    await expect(ui.drawer(page)).toContainText('In review');
    await expect(drawerAction(page, 'Open review')).toHaveCount(1);
    await drawerAction(page, 'Open review').click();
    await expectToast(page, 'Opening PRC-07 v3.2: review workflow');
  });

  // @sample-only: the API picker lists the Documents folder (WP-25 deviation 3) and a new version goes to in_review instead of approved (A.4 5.7).
  test('Upload new version links a file and bumps the document version', { tag: '@sample-only' }, async ({ page }) => {
    await openControls(page);
    await tab(page, 'Documents approved').click();
    await openRow(page, 'POL-01');
    await expect(drawerFact(page, 'Version')).toHaveText('v4.0');
    await drawerAction(page, 'Upload new version').click();
    const modal = ui.modal(page);
    await expect(modal).toContainText('Select document file from repository');
    await expect(modal).toContainText('Compliance / ISMS / Evidence / 2026 / Q3');
    const files = modal.locator('button[style*="grid-template-columns: 1fr auto"]');
    await expect(files).toHaveCount(5);
    await expect(files.first()).toHaveAttribute('style', /var\(--accbg\)/);
    // cancelling changes nothing
    await modal.locator('button', { hasText: 'Cancel' }).click();
    await expect(drawerFact(page, 'Version')).toHaveText('v4.0');
    await drawerAction(page, 'Upload new version').click();
    await files.nth(1).click();
    await expect(files.nth(1)).toHaveAttribute('style', /var\(--accbg\)/);
    await modal.locator('button', { hasText: 'Link selected file' }).click();
    await expect(ui.modal(page)).toHaveCount(0);
    await expectToast(page, 'POL-01 v5.0 approved, Restore-Test-2026-09-26.pdf pinned');
    await expect(drawerFact(page, 'Version')).toHaveText('v5.0');
    await expect(drawerFact(page, 'Approved on')).toHaveText('29 Sep 2026');
    await expect(drawerFact(page, 'Review due')).toHaveText('29 Sep 2027');
    await expect(listRow(page, 'POL-01')).toContainText('v5.0');
  });

  // @sample-only: in API mode the upload sends a real file chosen in the file dialog (A.4 5.10) and the version goes to in_review (A.4 5.7); e2e/api-only/commands.spec.js covers it.
  test('Managed Vault systems upload a new document version instead of picking a file', { tag: '@sample-only' }, async ({ page }) => {
    await openControls(page);
    await switchMs(page, 'QMS');
    await tab(page, 'Documents approved').click();
    await openRow(page, 'QM-01');
    const before = await drawerFact(page, 'Version').innerText();
    await drawerAction(page, 'Upload new version').click();
    const modal = ui.modal(page);
    await expect(modal).toContainText('Upload new version');
    await expect(modal).toContainText('Drop a file here or browse');
    await modal.locator('button', { hasText: 'Upload to Managed Vault' }).click();
    const next = (Math.floor(parseFloat(before.slice(1))) + 1).toFixed(1);
    await expectToast(page, `QM-01 v${next} uploaded to Managed Vault: SHA-256 recorded`);
    await expect(drawerFact(page, 'Version')).toHaveText('v' + next);
  });
});

