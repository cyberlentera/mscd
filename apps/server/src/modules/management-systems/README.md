# management-systems module

Management system administration, activation and edition transitions (TS 6.2, C.13 `management_system.status`, D-30).

- `GET /admin/management-systems`, `POST /admin/management-systems` (BR-21, `LIC-MS`; copies the activity templates of the edition into `implementation_activity_progress`), `PATCH /admin/management-systems/{id}` (scope, certification body, colour, default repository, setup to implementing, archive).
- `POST /ms/{ms}/transitions` (feature `edition_transition`): certified to transitioning with a newer edition of the same framework (one that supersedes the edition in use, directly or through a chain, or the `current` edition when the one in use is in transition or withdrawn), and back to certified once a transition audit created or scheduled after the transition started recommended certification.

Owner: WP-12.
