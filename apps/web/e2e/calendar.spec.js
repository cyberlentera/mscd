import {
  test, expect, openApp, go, ui, list, listRows, listRow, groupRows, chips, expectShown, search,
  drawerAction, drawerFact, openRow, expectToast, switchMs,
} from './helpers.js';

const ids = (page) => listRows(page).locator('td:nth-child(2) > div > :first-child');

async function openCalendar(page) {
  await openApp(page);
  await go(page, 'Document reviews');
}

test.describe('Document reviews', () => {
  test('lists overdue reviews first, then reviews by month', async ({ page }) => {
    await openCalendar(page);
    await expect(chips(page)).toHaveCount(0);
    await expect(groupRows(page)).toHaveText([/Overdue\s*5/, /Oct 2026\s*6/]);
    await expect(ids(page)).toHaveText(['STD-04', 'PRC-11', 'REG-03', 'PRC-15', 'PRC-07', 'IMS-04', 'STD-05', 'SOA-01', 'PRC-16', 'IMS-02', 'PLN-02']);
    await expectShown(page, 11);
    // the overdue group is marked red
    await expect(groupRows(page).first().locator('td')).toHaveCSS('color', 'rgb(191, 47, 37)');
    await expect(listRow(page, 'STD-04')).toContainText('Overdue 68d');
    await expect(listRow(page, 'IMS-04')).toContainText('8 Oct 2026');
    await expect(listRow(page, 'IMS-04')).toContainText('Due soon');
  });

  test('search narrows the months and clearing restores them', async ({ page }) => {
    await openCalendar(page);
    await search(page, 'IMS');
    await expect(groupRows(page)).toHaveText([/Oct 2026\s*2/]);
    await expect(ids(page)).toHaveText(['IMS-04', 'IMS-02']);
    await search(page, 'Fajar');
    await expect(groupRows(page)).toHaveText([/Overdue\s*1/]);
    await expect(ids(page)).toHaveText(['PRC-15']);
    await search(page, '');
    await expect(listRows(page)).toHaveCount(11);
  });

  test('row detail starts a review straight from the calendar', async ({ page }) => {
    await openCalendar(page);
    await openRow(page, 'REG-03');
    await expect(drawerFact(page, 'Review due')).toHaveText('6 Sep 2026, Overdue 23d');
    await drawerAction(page, 'Start review').click();
    await expectToast(page, 'REG-03, review started: assigned to Bagus Prasetyo');
    await expect(ui.drawer(page)).toContainText('In review');
    await expect(listRow(page, 'REG-03').locator('td:nth-child(4)')).toHaveText('In review');
  });

  // @sample-only: the API picker lists the repository folder instead of the sample picker files (WP-25 deviation 3) and a new version goes to in_review (A.4 5.7).
  test('a new version moves the document out of the overdue group', { tag: '@sample-only' }, async ({ page }) => {
    await openCalendar(page);
    await openRow(page, 'IMS-04');
    await drawerAction(page, 'Upload new version').click();
    await ui.modal(page).locator('button', { hasText: 'Link selected file' }).click();
    await expectToast(page, 'IMS-04 v2.0 approved');
    // next review is a year out, beyond the four months the calendar shows
    await expect(ui.drawer(page)).toHaveCount(0);
    await expect(groupRows(page)).toHaveText([/Overdue\s*5/, /Oct 2026\s*5/]);
    await expect(listRow(page, 'IMS-04')).toHaveCount(0);
  });

  // @sample-only: in API mode Export .ics creates a calendar feed and shows its address (H.4 calendarFeed) instead of the sample clipboard toast.
  test('Calendar feed confirms with a toast', { tag: '@sample-only' }, async ({ page }) => {
    await openCalendar(page);
    await ui.pageAction(page, 'Calendar feed').click();
    await expectToast(page, 'Calendar feed (.ics) copied to clipboard');
  });

  test('other systems show their own months', async ({ page }) => {
    await openCalendar(page);
    await switchMs(page, 'BCMS');
    await expect(groupRows(page)).toHaveText([/Oct 2026\s*3/, /Dec 2026\s*1/]);
    await expect(ids(page)).toHaveText(['PLN-B01', 'IMS-04', 'IMS-02', 'PLN-B02']);
    await switchMs(page, 'QMS');
    await expect(groupRows(page)).toHaveText([/Overdue\s*1/, /Oct 2026\s*5/]);
    await expect(list(page)).not.toContainText('Nothing matches');
  });
});
