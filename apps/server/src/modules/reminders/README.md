# reminders module

Reminders and bulk reminders with BR-50 throttling (E.5, D.3).

- `POST /reminders`: the record by `ref` (resolved through `RecordResolver` in `body.ms`, 404 for a record of another
  system) or by `recordKey` (a key of the system's snapshot refs); the recipient must be a member (422 `NOT-A-MEMBER`);
  BR-50 rejects a second reminder to the same person about the same record key within 72 hours (422 with
  `retryAfter` and the time of the last reminder). Writes a `reminder` row, an in-app `notification` of kind
  `reminder` ("Reminder: <action> for <title>, due <date>") whose email `notifications.dispatch` sends, and a
  `reminder.sent` audit entry, all in one transaction.
- `POST /reminders/bulk` (`scope: open_chain_items`): one reminder row per open chain item and holder (not
  Unassigned), one notification per holder listing their items; `count` is the number of holders reminded and
  `data.skipped` the items BR-50 held back.

Owner: WP-35 (build plan B.4).
