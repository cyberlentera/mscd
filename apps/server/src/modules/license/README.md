# license module

Licence verification, derived licence state and the `LicenceGate` (D-15, D-16, D-32, BR-37).

- `trust-anchors.ts`: the licence and pack keys compiled into the build (`TRUST_ANCHORS`); a release build refuses development key ids.
- `licence-state.ts`: the state of a licence on a date (`valid`, `grace`, `read_only`) and the clock high-water rule.
- `licence.service.ts`: verification (cached by document hash), binding to the installation or organisation, installation (`PUT /admin/license`), the view (`GET /license`) and the daily `license.check`.
- `licence-gate.ts`: the `LICENCE_GATE` used by the guard (read-only mode) and by services (`LIC-USERS`, `LIC-MS`, `LIC-FEATURE`, adapters).

Owner: WP-12.
