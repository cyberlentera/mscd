# MSCD container images

Every image builds from the repository root (the build context) with BuildKit (`docker buildx build`, Docker 23 or later). The root `.dockerignore` keeps local build output, tests, documentation and the development secrets of `apps/server/test` and `deploy/compose` out of the context.

| Image | Dockerfile | Target | Use |
|---|---|---|---|
| `cyberlentera/mscd-server` | `server.Dockerfile` | `release` (the default) | Run modes `api`, `worker`, `storage-gateway`, `migrate` and the admin commands of `mscd-server`. Release flavour: trusted keys from the `trusted-keys` build context, packs signed with the `pack_signing_key` build secret |
| `cyberlentera/mscd-server-demo` | `server.Dockerfile` | `demo` | Development flavour with the demo and test profiles, the demo seed snapshot and the development licences. Demo overlay, smoke tests and API E2E only; never in the offline bundle |
| `cyberlentera/mscd-web` | `web.Dockerfile` | (single) | The single-page app on unprivileged NGINX, with the `/api/` proxy to the api |
| `cyberlentera/mscd-mock-providers` | `mock-providers.Dockerfile` | (single) | Mock Microsoft 365 and Google Drive APIs (`tools/mock-providers`) for the demo and tests; never in the offline bundle |

## Build inputs

| Input | Kind | Images | Meaning |
|---|---|---|---|
| `build_ca` | build secret, every build | all | CA certificate of a TLS-inspecting proxy between the build machine and the npm registry or the Alpine mirrors. Every `npm` and `apk` step mounts it. Without such a proxy, pass an empty file (BuildKit does not accept `/dev/null`); an empty secret is ignored. In this repository's sandbox it is `$MSCD_BUILD_CA` |
| `trusted-keys` | named build context, required | server `release` | Folder with the release public keys `licence-*.pub`, `pack-*.pub` and `anchor-*.pub` (Ed25519, PEM). They are compiled into the build (D-16); there is no runtime setting for them. The build stops when the context is missing, holds no licence or pack key, or holds a key listed in `packages/pack-tools/dev-keys/dev-key-ids.json` |
| `pack_signing_key` | build secret, required, no default | server `release` | The release pack signing key (Ed25519 private key, PEM). The packs of `packs/sources` are built and signed with it into `/app/packs`, then verified against the `pack-*.pub` keys of `trusted-keys`. A key listed in `dev-key-ids.json` stops the build |
| `nginx-config` | named build context, required | web | The NGINX configuration: always `deploy/nginx` |
| `VERSION` | build argument | all | Version label; for the server also the compiled version, default the version in `apps/server/package.json` (packs name the lowest server version they accept) |
| `REVISION`, `CREATED` | build arguments | all | Source revision and build time, written to the OCI labels (and, for the server, to the build info) |
| `VITE_DATA_SOURCE` | build argument | web | `api` (default): the production bundle with the sign-in pages that talks to `/api`. `sample`: the bundled sample organisation without a back end |
| `APK_UPGRADE` | build argument | all | Alpine security updates in the runtime stage: `true` (fail when the mirrors cannot be reached), `auto` (default: apply when reachable, else warn and keep the base packages) or `false` (skip) |
| `NODE_IMAGE`, `NGINX_IMAGE` | build arguments | | Base images (`node:22-alpine`; the web default is pinned in `web.Dockerfile`) |

## Build commands

```bash
# Release server image (rehearsal keys shown; real release keys never come from the repository)
K=$(mktemp -d)
for name in pack-rehearsal licence-rehearsal anchor-rehearsal; do
  node packages/pack-tools/dist/cli.js keygen --out "$K" --name "$name"
done
docker buildx build --load -f deploy/docker/server.Dockerfile \
  --secret id=build_ca,src="$MSCD_BUILD_CA" \
  --secret id=pack_signing_key,src="$K/pack-rehearsal.key" \
  --build-context trusted-keys="$K" \
  --build-arg VERSION=1.0.0 --build-arg REVISION="$(git rev-parse --short=12 HEAD)" \
  --build-arg APK_UPGRADE=true \
  -t cyberlentera/mscd-server:1.0.0 .

# Demo server image (development keys and packs)
docker buildx build --load -f deploy/docker/server.Dockerfile --target demo \
  --secret id=build_ca,src="$MSCD_BUILD_CA" -t cyberlentera/mscd-server-demo:1.0.0 .

# Web image (API mode)
docker buildx build --load -f deploy/docker/web.Dockerfile \
  --build-context nginx-config=deploy/nginx \
  --secret id=build_ca,src="$MSCD_BUILD_CA" -t cyberlentera/mscd-web:1.0.0 .

# Mock providers
docker buildx build --load -f deploy/docker/mock-providers.Dockerfile \
  --secret id=build_ca,src="$MSCD_BUILD_CA" -t cyberlentera/mscd-mock-providers:1.0.0 .
```

`packages/pack-tools/dist` must exist for the `keygen` lines (`npm run build -w @mscd/pack-tools`).

## Server image

- Runs as user `10001:0` from `/app` and writes nothing there, so it works with a read-only root filesystem plus a `/tmp` (Compose `tmpfs`, Kubernetes `emptyDir`). Entrypoint `node apps/server/dist/main.js`, default command `api`. No health check in the image: orchestrators probe `/healthz` and `/readyz` (port 3000 for the api, the metrics port 9464 for every run mode).
- `MSCD_PROFILE_FILE` defaults to `apps/server/profiles/onprem.yaml` (release) or `demo.yaml` (demo). Override secret paths and settings with `MSCD__<SECTION>__<KEY>` variables and the `MSCD_DATABASE_*_FILE` variables (build plan I.1).
- The release image holds `apps/server/dist`, `apps/server/migrations`, `apps/server/profiles/{onprem,saas}.yaml`, `packages/shared/dist`, `packages/pack-tools/dist`, `/app/packs/*.pack` and the production `node_modules` of those three packages. npm, npx, corepack and yarn are removed. The release build refuses to finish when a compiled file contains a development key id, and the final stage fails when a demo or test profile, the seed snapshot, source or test folders, or the development key and licence folders are present (R-13).
- The demo image adds `profiles/{demo,test}.yaml`, `apps/server/src/seed/demo/sample-snapshot.json` and `packages/pack-tools/dev-licences` (read by `seed demo`), and sets `MSCD__PACKS__DIR=/app/packs`, because `demo.yaml` points at the repository's `packs/dist`. The secret files named in `demo.yaml` point into the source tree; a container mounts its own and overrides those paths, as `smoke.sh` does.

## Web image

- NGINX serves the app read-only (GET and HEAD) and proxies `/api/` to `MSCD_API_UPSTREAM` (`host:port`, default `api:3000`; `none` makes `/api/` answer 404 for web-only use). A host name is looked up again while NGINX runs (`resolve` in a shared-memory upstream, answers kept 10 s), so an api container recreated with a new address (for example by `docker compose up -d api`) is reached without restarting the web container, and the web container can start before the api. The DNS servers are the `nameserver` lines of `/etc/resolv.conf` unless `MSCD_API_RESOLVER` lists others (plain IPv4 or IPv6 addresses separated by commas or spaces, such as `1.1.1.1, fd00::53`; a port or brackets are refused at start, port 53 is used). Because the NGINX resolver does not use search domains, a short name such as `api` is completed at start with the first search domain under which it resolves (in Kubernetes `<service>.<namespace>.svc.cluster.local`). Connections to the api are kept open for reuse. Requests to the api carry `X-Forwarded-For $remote_addr` (whatever the client sent is dropped), `X-Forwarded-Proto` and `X-Request-Id $request_id`; bodies up to 110 MiB are streamed; responses get `Cache-Control: no-store` and are not compressed. Errors NGINX produces itself under `/api/` (api not reachable, body too large, proxy off) are `application/problem+json`.
- `MSCD_TRUSTED_PROXY_CIDRS` (addresses or CIDR ranges, separated by commas or spaces) names the proxies in front of NGINX, for example an ingress controller; their `X-Forwarded-For` then gives the client address (`real_ip_recursive on`). Unset, the socket address is the client.
- The access log (`log_format mscd`) records the path and a redacted query string (values of `token`, `code`, `state`, `t`, `SAMLResponse`, `RelayState` and `invitation` replaced with `[redacted]`; the whole query string when a name repeats or is percent-encoded), the Referer without its query string, and the request id. Error log lines about a request quote the raw request line, so requests log only critical errors (on every path, not only `/api/`) and missing files are not logged as errors; such requests still appear in the access log with their status. Start-up and configuration messages keep the `warn` level.
- The other start-up settings (TLS, redirect, HSTS, external fonts) are documented in `deploy/nginx/40-mscd-runtime.sh`.

## Smoke test

```bash
bash deploy/docker/smoke.sh --build-ca "$MSCD_BUILD_CA"
```

Builds the demo server image and the web image (tags `mscd-server-demo:smoke` and `mscd-web:smoke`), then starts on its own network: PostgreSQL, `db bootstrap`, `migrate`, the storage gateway (TLS off, demo mode), `seed demo` through the gateway, the api and the web image on `127.0.0.1:18082`. Each container gets only its own secret files, generated for the run. It checks that `GET /api/v1/system/profile` through the web container answers 200 with the api's headers, that a request with `X-Forwarded-For: 203.0.113.9` and `?token=secret` leaves neither the address nor the token in the NGINX access log (and no token value in the api log), that a token in the query of a refused static request (body too large) stays out of the NGINX log, that the static site still refuses other methods, and that `/api/` answers 200 again after the api container is recreated at a new address without restarting the web container. Everything is removed at the end, also on failure. Options: `--no-build`, `--server-image`, `--web-image`, `--port`, `--subnet` (default `172.31.251.0/24`), `--prefix` (default `wp-18-smoke`), `--keep`; `--help` lists them.
