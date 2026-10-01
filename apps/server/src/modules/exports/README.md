# exports module

Exports and the review calendar feed (build plan D.3 "Page actions", E.2, F.13, F.15), WP-24.

- `POST /exports` queues `export.build` (portfolio board PDF, readiness PDF, SoA and document register XLSX or CSV, audit trail CSV); `GET /exports/{taskId}` and `/download` serve the creator only, with the permission checked again.
- `GET /ms/{ms}/applicability/export` and `GET /ms/{ms}/documents/export` build the SoA and the document register at once.
- Content comes from the read model for the requester (`ScopePolicy`); every CSV and XLSX cell is formula-safe; files go out through `FileResponder`.
- `export.build` stores the file in the Managed Vault under `exports/<taskId>/` and records `export_file` (7 days).
- Calendar feed: one hashed token per user and system (`calendar_feed_token`), create and revoke routes, and the public ICS feed that checks `ms.read` on every fetch.
