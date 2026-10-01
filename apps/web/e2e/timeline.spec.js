import {
  test, expect, openApp, go, ui, list, listRows, listRow, openRow, drawerAction, drawerFact, expectToast, switchMs, closeDrawer,
  contrastProblems,
} from './helpers.js';

const lanes = (page) => page.locator('main div[style*="height: 58px"]');
const lane = (page, short) => lanes(page).filter({ has: page.locator('span', { hasText: new RegExp('^' + short + '$') }) });
const marker = (page, title) => page.locator(`main button[title="${title}"]`);
const eventCard = (page) => page.locator('main div[style*="flex-direction: column"][style*="gap: 14px"]').filter({ hasText: 'Audit event,' });
const cycleRows = (page) => page.locator('main div[style*="grid-template-columns: 20px 1fr auto"]');
const drift = (page) => page.locator('main button[style*="grid-template-columns: 1fr auto"]');
const PREP = 'main div[style*="grid-template-columns: 20px 1fr 170px 110px"]';
const prepRows = (page) => page.locator(PREP);

async function openTimeline(page) {
  await openApp(page);
  await go(page, 'Certification timeline');
}

test.describe('Certification timeline', () => {
  test('draws one lane per system with its audit events', async ({ page }) => {
    await openTimeline(page);
    await expect(lanes(page)).toHaveCount(4);
    await expect(lane(page, 'ISMS').locator('button[title]')).toHaveCount(5);
    await expect(lane(page, 'QMS').locator('button[title]')).toHaveCount(5);
    await expect(lane(page, 'BCMS').locator('button[title]')).toHaveCount(3);
    await expect(lane(page, 'ABMS').locator('button[title]')).toHaveCount(0);
    await expect(lane(page, 'ABMS')).toContainText('+ Add audit event');
    await expect(lane(page, 'QMS')).toContainText('Recert + transition');
    await expect(page.locator('main')).toContainText('Today');
    for (const y of ['2024', '2025', '2026', '2027', '2028']) await expect(page.locator('main')).toContainText(y);
  });

  test('the next ISMS audit is selected by default with readiness and preparation', async ({ page }) => {
    await openTimeline(page);
    const card = eventCard(page);
    await expect(card).toContainText('Audit event, ISMS');
    await expect(card).toContainText('Surveillance 1');
    await expect(card).toContainText('12 Nov 2026, 2 Audit days, PT Sertifikasi Nusantara, Ir. Dwi Hartanto, IRCA LA');
    await expect(card).toContainText('44 days left');
    await expect(card).toContainText(/63\s*Open along the chain/);
    await expect(card).toContainText(/24\s*Overdue \/ missing/);
    await expect(card).toContainText(/16\s*Due after audit date/);
    await expect(card).toContainText('Preparation checklist');
    await expect(card.locator('div[style*="grid-template-columns: 20px 1fr 170px 110px"]')).toHaveCount(7);
    await expect(card).toContainText('Previous findings to prove closed');
    await expect(card.locator('div[style*="grid-template-columns: 110px 70px 1fr 120px"]')).toHaveText([/NC-2025-01.*Closed/, /NC-2025-02.*Open/, /OFI-2025-01.*Closed/]);
  });

  test('done preparation items keep a readable due date next to their tick', async ({ page }) => {
    await openTimeline(page);
    const done = prepRows(page).filter({ hasText: 'Internal audit 2026 report issued' });
    await expect(done.locator('span').nth(1)).toHaveCSS('text-decoration-line', 'line-through');
    await expect(done.locator('span').nth(3)).toHaveText('6 Oct 2026');
    await expect(done.locator('span').nth(3)).toHaveCSS('color', 'rgb(107, 101, 90)');
    const tick = done.locator('span').first();
    await expect(tick).toHaveText('✓');
    await expect(tick).toHaveCSS('background-color', 'rgb(31, 122, 72)');
    await expect(tick).toHaveCSS('color', 'rgb(255, 255, 255)');
    await expect(tick).toHaveCSS('border-top-color', 'rgb(31, 122, 72)');
    expect(await contrastProblems(page, 3, PREP + ' *')).toEqual([]);
  });

  test('event markers open past, planned and other systems’ events', async ({ page }) => {
    await openTimeline(page);
    await marker(page, 'Stage 2, certification, 10 Mar 2025').click();
    const card = eventCard(page);
    await expect(card).toContainText('Stage 2, certification');
    await expect(card).toContainText('Completed');
    await expect(card).toContainText('Certified, 2 Minor NC, 1 OFI');
    await expect(card).toContainText('Findings from this audit: status today');
    await expect(card).not.toContainText('Preparation checklist');

    await marker(page, 'Surveillance 2, 10 Nov 2027').click();
    await expect(card).toContainText('Planned');
    await expect(card).toContainText('11 Sep 2027 (60 d)');
    await expect(card).toContainText('Cycle prerequisites the auditor will check');
    await expect(card.locator('ul li')).toHaveCount(6);

    await marker(page, 'Recertification + 2026 transition, 3 Dec 2026').click();
    await expect(card).toContainText('Audit event, QMS');
    await expect(card).toContainText('65 days left');
    await expect(card).toContainText('Lembaga Sertifikasi Garuda Mutu');
    await expect(card.locator('div[style*="grid-template-columns: 20px 1fr 170px 110px"]')).toHaveCount(5);
    // the selected marker is highlighted
    await expect(marker(page, 'Recertification + 2026 transition, 3 Dec 2026')).toHaveCSS('box-shadow', /rgba?\(/);
  });

  test('Open audit readiness switches to the event’s system', async ({ page }) => {
    await openTimeline(page);
    await marker(page, 'Recertification + 2026 transition, 3 Dec 2026').click();
    await eventCard(page).locator('button', { hasText: 'Open audit readiness' }).click();
    await expect(ui.title(page)).toHaveText('Audit readiness');
    await expect(ui.msSwitch(page)).toContainText('QMS');
    await expect(page.locator('main')).toContainText('Recertification & ISO 9001:2026 transition audit');
  });

  test('cycle completeness shows four items and expands to all', async ({ page }) => {
    await openTimeline(page);
    await expect(cycleRows(page)).toHaveCount(4);
    await expect(cycleRows(page).first()).toContainText('Risk assessment reviewed this cycle');
    await expect(cycleRows(page).first()).toContainText('In progress');
    await page.locator('main button', { hasText: 'Show all (6)' }).click();
    await expect(cycleRows(page)).toHaveCount(6);
    await page.locator('main button', { hasText: 'Show less' }).click();
    await expect(cycleRows(page)).toHaveCount(4);
  });

  test('Add audit event from the empty lane and the page action', async ({ page }) => {
    await openTimeline(page);
    await lane(page, 'ABMS').locator('button', { hasText: 'Add audit event' }).click();
    await expectToast(page, 'Audit event form opened');
    await ui.pageAction(page, 'Add audit event').click();
    await expectToast(page, 'Audit event form opened');
  });

  test('regression detector lists the affected records and toggles off', async ({ page }) => {
    await openTimeline(page);
    await expect(drift(page)).toHaveText([
      /Risks not reassessed in 12 months\s*6 affected/,
      /Evidence files that cannot be verified\s*3 affected/,
      /Metrics no longer updated\s*4 affected/,
      /Management review inputs missing\s*2 affected/,
    ]);
    await expect(list(page)).toHaveCount(0);
    await drift(page).nth(0).click();
    await expect(list(page)).toContainText('Risks not reassessed in 12 months');
    await expect(listRows(page)).toHaveCount(6);
    await expect(listRows(page).first()).toContainText('R-005');
    await expect(listRows(page).first()).toContainText('Data centre power failure');
    await openRow(page, 'R-005');
    await drawerAction(page, 'Send reminder').click();
    await expectToast(page, 'Reminder sent to Bagus Prasetyo');
    // a risk with no records behind it has nothing to trace
    await expect(drawerAction(page, 'Trace from here')).toHaveCount(0);
    await closeDrawer(page);
    await openRow(page, 'R-009');
    await drawerAction(page, 'Trace from here').click();
    await expect(ui.title(page)).toHaveText('Golden Thread Viewer');
    await expect(page.locator('main')).not.toContainText('No record found');

    await go(page, 'Certification timeline');
    await drift(page).nth(1).click();
    await expect(listRows(page)).toHaveCount(3);
    await openRow(page, 'EV-0271');
    await expect(drawerFact(page, 'Integrity')).toHaveText('Access revoked');
    await closeDrawer(page);
    await drift(page).nth(2).click();
    await expect(listRows(page)).toHaveCount(4);
    await openRow(page, 'M-15');
    await expect(drawerFact(page, 'Holder')).toHaveText('Unassigned, -');
    await closeDrawer(page);
    await drift(page).nth(2).click();
    await expect(list(page)).toHaveCount(0);
  });

  test('switching the system resets the selected event and the detector', async ({ page }) => {
    await openTimeline(page);
    await marker(page, 'Stage 1, 20 Jan 2025').click();
    await drift(page).nth(0).click();
    await switchMs(page, 'BCMS');
    await expect(eventCard(page)).toContainText('Audit event, BCMS');
    await expect(eventCard(page)).toContainText('Stage 1');
    await expect(eventCard(page)).toContainText('134 days left');
    await expect(list(page)).toHaveCount(0);
    await expect(drift(page)).toHaveText([/BC plans without a scheduled exercise\s*2 affected/, /Evidence files that cannot be verified\s*0 affected/, /Google-native evidence without content hash\s*0 affected/]);
    await switchMs(page, 'ABMS');
    await expect(eventCard(page)).toContainText('No audit event scheduled');
    await expect(eventCard(page)).toContainText('Cycle prerequisites the auditor will check');
  });
});
