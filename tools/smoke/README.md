# Full-stack smoke test

`npm run test:smoke` checks one user journey through the complete MSCD stack: the web image, the api, the worker, the storage gateway, PostgreSQL, SeaweedFS, the provider mocks, Mailpit and Keycloak (build plan J.9).

## What it does

1. Builds three images with the build CA (R-12): `cyberlentera/mscd-server-demo` (target `demo` of `deploy/docker/server.Dockerfile`), `cyberlentera/mscd-web` and `cyberlentera/mscd-mock-providers`, all tagged `smoke` unless `MSCD_VERSION` is set. Build logs go to `test-results/build-*.log`.
2. Removes what an earlier interrupted run of the same project left behind, checks that the published ports are free and that the internal network range is not used by another Docker network.
3. Starts `deploy/compose/docker-compose.yml` with the demo overlay `deploy/compose/docker-compose.demo.yml` as Compose project `mscd-smoke` (`up -d --wait`), so migrations, the demo seed and every health check have finished.
4. Runs the Playwright suite in `tests/` with Chromium. The browser maps the name `keycloak` to this host (`--host-resolver-rules=MAP keycloak 127.0.0.1:<port>`), because Keycloak's issuer is `http://keycloak:18088` for the browser and the containers alike.
5. Runs `docker compose down -v`: on success, on failure and on Ctrl-C. Before that, after a failure, the service logs are saved to `test-results/compose.log`.

The journey, in order and in one browser session:

| Step | Check |
|---|---|
| Stack | `/healthz`, `/api/v1/system/profile` (demo mode), the Keycloak provider in `/api/v1/auth/providers`, the Mailpit API |
| Sign-in | `rina` with password and TOTP on `/login` and `/login/mfa`; `GET /api/v1/me` answers with her account |
| Portfolio | four management system cards (ISMS, QMS, BCMS, ABMS) |
| ISMS controls | the reference counts of UI 4.7: 61 of 93 implemented, 18 partial, 4 open gate items, 14 of 22 documents approved, 5 expired |
| Mark complete | `A.5.13` shows the toast and becomes "Complete, awaiting verification" |
| SharePoint link | `EV-0124` is re-linked to `Access-Review-Q3-2026.xlsx` from the mock SharePoint picker and leaves the "File cannot be verified" list |
| Managed Vault | a generated file is uploaded to `EQ-0154` (QMS); the drawer shows its SHA-256, compared with the hash computed by the test |
| Integrity check | the page action starts the check and confirms with a toast |
| Reminder | a reminder for `A.5.1` is sent and the email `[MSCD] Reminder ...` to Rina arrives in Mailpit |
| Keycloak | `bagus` signs in through the Keycloak login form, then the local TOTP step (F.5) |
| Sign out | Sign out returns to `/login` and `GET /api/v1/me` answers 401; no page error and no 5xx answer happened during the journey |

TOTP codes come from `lib/totp.mjs`, a copy of the logic of `tools/scripts/demo-totp.mjs` (secret rule of G.3, RFC 6238). The runner checks the copy against the RFC 6238 test vectors before it starts.

## Running it

```bash
npm run test:smoke                       # build the images, then test
SMOKE_SKIP_BUILD=1 npm run test:smoke    # use the images of an earlier build
```

Requirements: Docker with BuildKit and Compose v2, about 4 GB of free memory, the Chromium of Playwright 1.56.1, and the images `postgres:16.15-alpine`, `chrislusf/seaweedfs:4.48`, `axllent/mailpit:v1.31.3`, `keycloak/keycloak:26.7.5` and `node:22-alpine` (pulled when missing).

Options are given to the runner itself:

```bash
node tools/smoke/run-smoke.mjs --build-ca /path/to/proxy-ca.pem
node tools/smoke/run-smoke.mjs --keep            # leave the stack running after the tests
node tools/smoke/run-smoke.mjs --down            # remove a stack left by --keep
node tools/smoke/run-smoke.mjs -- --headed       # arguments after -- go to "playwright test"
```

| Variable | Default | Meaning |
|---|---|---|
| `MSCD_BUILD_CA` | empty file | CA certificate of a TLS-inspecting proxy for the image builds (`--build-ca` wins) |
| `SMOKE_SKIP_BUILD` | unset | `1` uses the existing images |
| `SMOKE_KEEP` | unset | `1` is the same as `--keep` |
| `SMOKE_STRICT_LAYOUT` | unset | `1` fails the picker step when a modal button is outside the window instead of pressing it with the keyboard (see "Known layout finding") |
| `SMOKE_PROJECT` | `mscd-smoke` | Compose project name |
| `SMOKE_OUTPUT_DIR` | `tools/smoke/test-results` | build logs, Compose logs, the Playwright report (`report/`) and traces (`artifacts/`) |
| `MSCD_VERSION` | `smoke` | tag of the three images |
| `MSCD_SERVER_DEMO_IMAGE`, `MSCD_IMAGE`, `MSCD_MOCK_IMAGE` | `cyberlentera/mscd-server-demo`, `cyberlentera/mscd-web`, `cyberlentera/mscd-mock-providers` | image repositories |
| `MSCD_HTTP_PORT`, `MSCD_HTTPS_PORT`, `MSCD_KEYCLOAK_PORT`, `MSCD_MAILPIT_PORT` | 18080, 18443, 18088, 18025 | published ports on 127.0.0.1 |
| `MSCD_SUBNET`, `MSCD_WEB_ADDRESS` | `172.31.250.0/24`, `172.31.250.10` | internal network and the fixed web address; when another Docker network uses the default range, the runner picks a free `172.31.x.0/24` |

A relative path in `MSCD_BUILD_CA`, `SMOKE_OUTPUT_DIR` or `--build-ca` is taken from the folder where `npm run test:smoke` (or `node`) was started, not from `tools/smoke`.

The runner gives Compose an empty `--env-file` and passes the published ports and `MSCD_BIND_ADDRESS=127.0.0.1` itself, so a `deploy/compose/.env` of an on-premise install (ports 80 and 443 on 0.0.0.0, `COMPOSE_PROFILES`) does not change the smoke stack.

The port and network variables are the ones of the Compose files, so a second stack can run next to another one:

```bash
MSCD_HTTP_PORT=28080 MSCD_HTTPS_PORT=28443 MSCD_KEYCLOAK_PORT=28088 MSCD_MAILPIT_PORT=28025 \
  SMOKE_PROJECT=mscd-smoke-2 npm run test:smoke
```

Exit codes: 0 when every check passed, 1 when a build, the stack or a test failed, 2 for wrong usage or a missing requirement (Docker not running, a port in use, a missing image with `SMOKE_SKIP_BUILD=1`).

## When it fails

- The runner prints the last lines of every service that did not become healthy; all logs are in `test-results/compose.log`.
- `npx playwright show-report tools/smoke/test-results/report` opens the report with the screenshot and the trace of the failed step.
- `node tools/smoke/run-smoke.mjs --keep` keeps the stack for a look in the browser at `http://localhost:18080` (sign-in users and passwords: G.3 of the build plan and `deploy/compose/dev/README.md`).

## Known layout finding

The demo SharePoint folder lists 82 files and the picker modal has no scroll area, so its file rows and "Link selected file" end up outside a 900 px window. Until WP-25 or WP-14 fixes the picker or the fixture, the test presses those buttons with the keyboard and prints `smoke: layout: ...`. Run with `SMOKE_STRICT_LAYOUT=1` to see the step fail as a mouse user would; after the fix, strict becomes the default.
