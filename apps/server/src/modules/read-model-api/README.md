# read-model-api module

Per-screen read endpoints of TS 9.2 (build plan D.3 "Read model per screen", D-05). Owner: WP-32.

- `screen-read.service.ts` loads one system in a tenant transaction with the read model's loader, derives its
  snapshot with `buildSystemSnapshot` on the full data (D-04) and applies `ScopePolicyService.projectSnapshot`.
- `screens.ts` holds the projections, one function per endpoint. Lists and numbers come from the caller's projected
  snapshot, so they equal what `GET /ui/ms/{ms}` gives the same caller (TS 9.6).
- `query.ts` holds search (`q`) and paging; `texts.ts` the language choice (`Accept-Language`) and labels.
