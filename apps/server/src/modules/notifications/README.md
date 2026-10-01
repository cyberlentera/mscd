# notifications module

In-app notifications of the session user and their email delivery (build plan E.6, D.3, E.2), WP-24.

- `GET /notifications?unread=` and `POST /notifications/{id}/read` (`notifications.service.ts`): the recipient's own rows only.
- `notifications.dispatch`: pending non-digest rows, one email each through Nodemailer in the recipient's language; five attempts, then `failed`. Queued per row by `NOTIFICATION_WRITER` and swept every 5 minutes (installation scope, work per organisation).
- `notifications.digest`: one email per user with the digest rows created before the local day began.
- `documents.review-alerts`: `document_review_due` 60, 30 (digest), 14 and 7 days before `next_review_at`.
