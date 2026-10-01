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

Scripts that need a workspace or tool that is not in the repository yet fail until it is added; `check:text` prints that it is not available instead.

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

The build argument `VITE_DATA_SOURCE` selects the data source compiled into the app: `sample` (the default) or `api`. The `.dockerignore` at the repository root keeps `node_modules`, build and test output, `deploy/dist` and the design uploads out of the build context. Release bundles are built with `deploy/scripts/build-bundle.sh`, which takes the CA file as `--build-ca <file>` ([deploy/README.md](../deploy/README.md)).
