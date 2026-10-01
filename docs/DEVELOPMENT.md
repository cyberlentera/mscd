# MSCD developer guide

How to set up the MSCD repository, run the web app and its tests, and build the images on a development machine. The build plan is [platform/BUILD-PLAN.md](platform/BUILD-PLAN.md); the target architecture is [ARCHITECTURE.md](ARCHITECTURE.md).

## Prerequisites

| Tool | Version | Used for |
|---|---|---|
| Node.js | 22.22 or later in the 22 line (`.nvmrc` holds `22.22.0`; every `package.json` says `"node": ">=22"`) | Everything below |
| npm | 10 (ships with Node 22) | Workspaces and the single root `package-lock.json` |
| Playwright Chromium | Build 1194, the build that `@playwright/test` 1.56.1 expects | The E2E suite |
| Docker Engine with Buildx and Compose | Docker 23 or later for image builds; Docker 25 and Compose 2.24 or later for the developer stack | Images and the developer infrastructure stack |

With `nvm`, run `nvm use` at the repository root to switch to the version in `.nvmrc`.

Playwright looks for its browsers in `PLAYWRIGHT_BROWSERS_PATH`, or in its default cache folder when that variable is not set. If Chromium build 1194 is not installed yet, install it once:

```bash
npx playwright install chromium
```

## Repository layout

The repository is one npm workspace with the members `apps/*`, `packages/*` and `tools/*`:

| Path | Contents |
|---|---|
| `apps/web` | The React single-page app (package `@mscd/web`): controller `src/MscdApp.jsx`, generated views in `src/views`, sample data in `src/data`, Playwright suite in `e2e/` |
| `deploy/docker/web.Dockerfile` | The web image, built with the repository root as the build context |
| `deploy/` | NGINX configuration, Compose files, Helm chart and the on-premise scripts ([deploy/README.md](../deploy/README.md)) |
| `deploy/compose/dev` | Developer infrastructure stack: PostgreSQL, object store, Valkey, Keycloak and Mailpit ([README](../deploy/compose/dev/README.md)) |
| `project/` | The Claude Design handoff. `project/MSCD Mockup.dc.html` is the source of the generated views; everything else is reference only |
| `docs/` | Architecture, build plan, install guide and this guide |

The server, shared contract, pack tools and test tools join the workspace as `apps/server`, `packages/*` and `tools/*`.

## Install

Run once after cloning, and again whenever `package-lock.json` changes:

```bash
npm ci
```

`npm ci` installs every workspace from the root lockfile into the root `node_modules`. There is no lockfile inside a workspace. To add a dependency to a workspace, run from the repository root:

```bash
npm install <package>@<exact version> -w @mscd/web
```

## Run the web app

```bash
npm run dev -w @mscd/web       # development server on http://localhost:5173
npm run build -w @mscd/web     # static files in apps/web/dist
npm run preview -w @mscd/web   # serves apps/web/dist on http://localhost:4173
```

The app runs fully in the browser on a fictional sample organisation, so no back end is needed. Display settings come from the query string, for example `http://localhost:5173/?lang=id&theme=dark`; [apps/web/README.md](../apps/web/README.md) lists them.

## End-to-end tests

The Playwright suite in `apps/web/e2e` builds the app and serves the build on port 4173 for every run:

```bash
CI=1 npm run test:e2e
```

`npm run test:e2e` at the root runs `npm run test:e2e -w @mscd/web`. With `CI=1` Playwright never reuses a server that is already listening on port 4173, so the suite always tests the current build; a leftover `npm run preview` makes the run stop with an error instead. The full suite takes about 8 minutes on 4 CPUs. To pass Playwright options, call the workspace script directly:

```bash
CI=1 npm run test:e2e -w @mscd/web -- e2e/portfolio.spec.js   # one spec file
CI=1 npm run test:e2e -w @mscd/web -- -g "Golden Thread"       # tests whose title matches
```

Failures leave screenshots and traces in `apps/web/test-results/` and an HTML report in `apps/web/e2e-report/` (open it with `npx playwright show-report apps/web/e2e-report`). Both folders are git-ignored.

## Generated views

The screen components in `apps/web/src/views/*.jsx` and the hover rules in `apps/web/src/hover.css` are generated from `project/MSCD Mockup.dc.html` by `apps/web/scripts/convert-template.mjs`. Never edit them by hand. The one exception is `apps/web/src/views/util.js`, which holds hand-written helpers the views import.

To change a screen's markup, change the design template or the patch list at the top of the converter, then regenerate:

```bash
npm run gen:views -w @mscd/web
```

Every change to the web app runs the check, which regenerates the views and `hover.css` into a temporary folder and fails, listing the files, when a generated file is missing, extra or different:

```bash
npm run gen:views:check -w @mscd/web
```

The converter also takes `--out <dir>` to write the views to `<dir>/views/` and the hover rules to `<dir>/hover.css` instead of `apps/web/src`.

## Developer infrastructure stack

```bash
npm run dev:stack
```

starts PostgreSQL, the S3-compatible object store and Mailpit with Docker Compose and waits until they are healthy. Valkey and Keycloak start with the Compose profiles `bullmq` and `sso`. Connection strings, keys, logins and how to reset the data are in [deploy/compose/dev/README.md](../deploy/compose/dev/README.md).

## Server, shared packages and tools

Files of this part of the repository:

| Path | Package | Contents |
|---|---|---|
| `apps/server` | `@mscd/server` | NestJS server on Fastify (CommonJS): run modes `api`, `worker`, `storage-gateway` and `migrate`, admin commands, profiles, migrations, unit and integration tests ([README](../apps/server/README.md)) |
| `packages/shared` | `@mscd/shared` | Shared contract: zod schemas, route table, authorisation matrix, OpenAPI generator (ES module) |
| `packages/pack-tools` | `@mscd/pack-tools` | CLI `mscd-pack`: builds, signs and verifies framework packs and licences (ES module) |
| `tools/mock-providers` | `@mscd/mock-providers` | Local Microsoft identity, Graph and Google Drive mocks for tests and the demo |
| `tools/smoke` | `@mscd/smoke` | Full-stack smoke test (Playwright against Compose) |
| `tools/scripts` | none | `check-text.mjs` and `demo-totp.mjs` ([README](../tools/scripts/README.md)) |
| `tsconfig.base.json`, `eslint.config.mjs` | none | Shared TypeScript options (strict, ES2023, `nodenext`) and the ESLint configuration |

### Build, typecheck, lint and unit tests

```bash
npm run build -w @mscd/server     # also builds @mscd/shared and @mscd/pack-tools (project references)
npm run typecheck                 # every workspace
npm run lint                      # TypeScript everywhere and the .mjs scripts outside apps/web
npm test                          # unit tests of every workspace, no Docker needed
```

During development no package needs a build to be used by another: Vitest configurations alias `@mscd/shared`, `@mscd/pack-tools` and `@mscd/mock-providers` to their `src`, and the TypeScript configurations resolve the export condition `@mscd/source` to the same files. Only `node apps/server/dist/main.js` needs the built `dist` folders, which `npm run build -w @mscd/server` produces.

The server lint rules enforce tenant scoping (build plan F.10): outside `src/db`, `src/modules/tenancy` and `src/seed` no use of the injected pool, which means no reference to `this.db` at all and no method call on, hand-off or alias of a binding named `db` (query inside `withTenant` or `withPlatform` on the transaction `trx`, and give a dedicated connection in `src/cli` another name, such as `migrator`); `withPlatform` only in the identity, ops, jobs, audit, packs, license and tenancy modules, `src/cli`, `src/seed` and `src/worker` (any reference to it counts there, including `.call`, `.bind`, `x['withPlatform']`, destructuring and aliases); in SQL strings no `SET` at the start of a statement except `SET LOCAL`, `SET TRANSACTION` and `SET CONSTRAINTS` (comments do not hide one), and `set_config(...)` only with a literal `true` as its third argument. A statement starts at the start of the string, after `;`, after `BEGIN`, `THEN`, `ELSE` or `LOOP`, after a dollar-quote opener and after an opening single quote (dynamic SQL in `EXECUTE '...'` or `format('...')`). `SET` in capitals always counts there; `set` in any other spelling counts only in a SQL statement shape (`set name = v`, `set name to v`, `set role ...`, `set schema ...` and the like, or a bare `'set '` joined to the rest). So English messages such as "Set either A or B" or "The password is missing; set a new one" pass, while a message such as "set it to 5" or one that starts with `SET ` does not, so reword it.

### Integration tests

```bash
npm run test:int -w @mscd/server                      # every suite
npm run test:int -w @mscd/server -- test/int/smoke    # one folder
```

The global setup starts `postgres:16.15-alpine` with Testcontainers (label `mscd.test=true`, no reaper container) and builds the template database `mscd_tpl_empty`; each test file copies it with `useTestDatabase()` from `apps/server/test/setup/test-db.ts`. Variables:

| Variable | Effect |
|---|---|
| `MSCD_TEST_DATABASE_URL` | Use this PostgreSQL server (an administrator URL) instead of a container |
| `MSCD_TEST_PG_IMAGE` | Another image, for example `postgres:15-alpine` or `postgres:17-alpine` |
| `MSCD_TEST_CONTAINER_PREFIX` | Name the container `<prefix>postgres-<random>` |
| `MSCD_TEST_SSO=1` | Also run the Keycloak global setup (OIDC and SAML suites) |

### Run the api locally

```bash
npm run build -w @mscd/server
MSCD_PROFILE_FILE=apps/server/profiles/test.yaml node apps/server/dist/main.js api
curl http://localhost:3000/healthz
curl http://localhost:3000/api/v1/system/profile
```

`/readyz` answers 503 until the database of the profile is reachable (with `test.yaml`, the developer stack on port 55432). Metrics are on port 9464 (`/metrics`).

### Deployment profiles

The server reads the YAML file named by `MSCD_PROFILE_FILE` and validates it strictly at start: an unknown key, a missing key or a forbidden value stops the process with a list of every problem. `apps/server/profiles` holds `onprem.yaml` and `saas.yaml` (release) and `demo.yaml` and `test.yaml` (development builds only; their secrets are the public values in `apps/server/test/fixtures/secrets`). Relative paths in a profile resolve against the profile's folder.

| Override | Example |
|---|---|
| `MSCD__<SECTION>__<KEY>=<YAML value>` | `MSCD__HTTP__PORT=3001`, `MSCD__DEMO__ENABLED=false`, `MSCD__OBSERVABILITY__METRICS_PORT=null` |
| Database URLs (win over `database.*_file`) | `MSCD_DATABASE_URL`, `MSCD_DATABASE_MIGRATOR_URL`, `MSCD_DATABASE_PACK_URL`, `MSCD_DATABASE_ADMIN_URL` |
| The same values from files | `MSCD_DATABASE_URL_FILE=/run/secrets/db-app.url` and so on |

`mscd-server db bootstrap [--with-report-role]` creates the database roles, schema `ext` and extension `pg_trgm` (build plan C.2). It connects with the administrator URL and takes each role's password from that role's URL, so all four URLs must be set. The developer stack already ran the same bootstrap at its first start.

### Build information and flavours

`npm run gen:build-info -w @mscd/server` (also run before every build, typecheck and test) writes `apps/server/src/generated/build-info.ts`: build flavour, version, revision, the platform migrations of the build and the trusted public keys. `MSCD_BUILD_FLAVOR` is `dev` (default; trusts the keys in `packages/pack-tools/dev-keys`) or `release` (trusts only the keys in `MSCD_TRUSTED_KEYS_DIR`, which must hold a `licence-*.pub` and a `pack-*.pub` key and no development key). Release builds also refuse the demo and test profiles at start. `MSCD_VERSION` and `MSCD_REVISION` override the version from `apps/server/package.json` and the Git revision.

### Demo users

Every demo and test user signs in with the password `Mscd-Demo-2026!` and a TOTP code derived from the user's handle:

```bash
node tools/scripts/demo-totp.mjs rina
```

## Root scripts

| Script | What it runs |
|---|---|
| `npm run build` | `build` of every workspace that has one |
| `npm run typecheck` | `typecheck` of every workspace that has one |
| `npm run lint` | ESLint over the repository |
| `npm test` | Unit tests of every workspace that has them |
| `npm run test:int` | Integration tests of `@mscd/server` |
| `npm run test:e2e` | The web E2E suite against the sample data |
| `npm run test:e2e:api` | The web E2E suite against the API |
| `npm run test:smoke` | The full-stack smoke test |
| `npm run openapi` | Writes the OpenAPI document from the shared contract |
| `npm run dev:stack` | Starts the developer infrastructure stack |
| `npm run seed:demo` | Loads the demo organisations into the development database |
| `npm run check:text` | Fails when a document in `docs/` contains an em dash or a centre dot character |

Scripts whose work package has not landed yet fail with a message that names it (for example `npm run test:smoke` until the smoke test exists). `npm run test:smoke` runs the script `smoke` of `@mscd/smoke`, not its `test` script, so `npm test` never starts the full stack.

## Image builds

Every image builds with the repository root as the build context and receives the build CA as a BuildKit secret named `build_ca`. Each `npm` or `apk` step in a Dockerfile mounts it and trusts it only when the file is not empty. Set `MSCD_BUILD_CA` to the CA certificate of the TLS-inspecting proxy between your machine and the npm registry or the Alpine mirrors. Without such a proxy, point it to an empty file, because BuildKit does not accept `/dev/null`:

```bash
export MSCD_BUILD_CA=/path/to/proxy-ca.pem              # behind a TLS-inspecting proxy
# or
: > /tmp/empty-ca.pem && export MSCD_BUILD_CA=/tmp/empty-ca.pem
```

Build and try the web image:

```bash
docker buildx build --load --secret id=build_ca,src="$MSCD_BUILD_CA" \
  -f deploy/docker/web.Dockerfile --build-context nginx-config=deploy/nginx \
  -t mscd-web:dev .
docker run -d --rm --name mscd-web-dev -p 8080:8080 mscd-web:dev
curl -fsS http://localhost:8080/healthz
docker rm -f mscd-web-dev
```

The build argument `VITE_DATA_SOURCE` selects the data source compiled into the app: `sample` (the default) or `api`. The build argument `APK_UPGRADE` controls the Alpine updates of the runtime stage: `auto` (the default) applies them when `apk update` succeeds and otherwise prints a warning and keeps the base image packages, `true` fails the build when `apk update` fails (a mirror that cannot be reached or is blocked by a proxy, or a TLS certificate that is not trusted because `MSCD_BUILD_CA` is missing or wrong), and `false` skips the step. Read the `apk` messages above the warning to tell the two causes apart. Release bundles always pass `true` (or `false` with `--no-os-updates`). The `.dockerignore` at the repository root keeps `node_modules`, build and test output, `deploy/dist` and the design uploads out of the build context. Release bundles are built with `deploy/scripts/build-bundle.sh`, which takes the CA file as `--build-ca <file>` ([deploy/README.md](../deploy/README.md)).
