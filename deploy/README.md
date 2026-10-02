# MSCD deployment

Everything needed to package and deploy MSCD. The customer-facing guide is [docs/INSTALL-ONPREM.md](../docs/INSTALL-ONPREM.md); it is also copied into every bundle.

| Path | Contents |
|---|---|
| `docker/` | `web.Dockerfile` (web image), `server.Dockerfile` (server image, targets `release` and `demo`), `mock-providers.Dockerfile` (demo and tests only), `smoke.sh`; see `docker/README.md` |
| `nginx/` | NGINX configuration of the web image and its start-up script (HTTPS, `/api` proxy, optional settings) |
| `compose/` | `docker-compose.yml` (on-premise stack), `.env.example`, `config/` (database start-up script; `demo-secrets/` holds public development values, never shipped), `docker-compose.demo.yml` (demo overlay), `docker-compose.vps.yml` (test server overlay), `dev/` (developer infrastructure stack) |
| `helm/mscd/` | Helm chart of the platform; `ci/` holds its static checks and the k3s install test |
| `scripts/` | `build-bundle.sh` and `check-release-artefacts.sh` (release team), `install.sh`, `upgrade.sh`, `uninstall.sh` and `lib/common.sh` (customer, inside the bundle), `deploy-demo.sh` (test server) |
| `dist/` | Built bundles (not committed) |

## Images

| Image | Built from | Use |
|---|---|---|
| `cyberlentera/mscd-web` | `docker/web.Dockerfile` with `--build-context nginx-config=deploy/nginx` | Every installation. API mode (`VITE_DATA_SOURCE=api`) is the default. |
| `cyberlentera/mscd-server` | `docker/server.Dockerfile`, target `release` | Every installation: api, worker, storage-gateway, migrate and the operator commands. Trusted keys and pack signatures come only from release keys. |
| `cyberlentera/mscd-server-demo` | `docker/server.Dockerfile`, target `demo` | Demo overlay, smoke test, API E2E tests. Never in a bundle. |
| `cyberlentera/mscd-mock-providers` | `docker/mock-providers.Dockerfile` | Demo and tests only. Never in a bundle. |

Every build uses the repository root as the build context and passes the build CA as a BuildKit secret: `--secret id=build_ca,src="$MSCD_BUILD_CA"`. `MSCD_BUILD_CA` names the CA certificate of a TLS-inspecting proxy between the build machine and the npm registry or the Alpine mirrors. Without such a proxy, point it to an empty file; BuildKit does not accept `/dev/null`. `docker/README.md` lists every build argument.

## Release keys

A release needs three Ed25519 key pairs that never enter the repository: a licence key, a pack key and an anchor key. The public keys are compiled into the release server; the pack private key signs the framework packs. Create them once, on an offline machine, and keep the private keys in your key vault:

```bash
npm run build -w @mscd/shared -w @mscd/pack-tools
for n in licence pack anchor; do
  node packages/pack-tools/dist/cli.js keygen --out /secure/release-keys --name "$n-release"
done
```

The bundle signature uses a separate key pair (EC or RSA, PEM). Create it once and publish the fingerprint of the public key on the support portal:

```bash
openssl ecparam -name prime256v1 -genkey -noout -out /secure/mscd-release.key
openssl ec -in /secure/mscd-release.key -pubout -out /secure/mscd-release.pub
```

The server build stops when a trusted key or the pack signing key is a development key (`packages/pack-tools/dev-keys/dev-key-ids.json`).

## Build a release bundle

On a build machine with Docker 27 or later (with Buildx) and internet access, from committed sources:

```bash
deploy/scripts/build-bundle.sh --release --version 1.0.0 \
  --trusted-keys-dir /secure/release-keys \
  --pack-signing-key /secure/release-keys/pack-release.key \
  --sign-key /secure/mscd-release.key
```

`--release` pulls the newest base images, requires the Alpine security updates, makes the vulnerability scan a gate and refuses uncommitted sources. The script:

1. Checks the inputs: the release public keys (only `licence-*.pub`, `pack-*.pub` and `anchor-*.pub` of the folder are used; private keys never reach a build context), that the pack signing key matches one of the pack keys, and that the version is at least the `engine_min_version` of every pack in `packs/sources`.
2. Builds `cyberlentera/mscd-web:<version>` (API mode) and `cyberlentera/mscd-server:<version>` (target `release`, trusted keys from the folder, packs signed with the pack key).
3. Takes `postgres:16.15-alpine`, `chrislusf/seaweedfs:4.48` and `valkey/valkey:8.1-alpine` from the build machine, or pulls them.
4. Assembles the bundle: scripts, Compose file, `.env.example` with the version, `compose/config/` without `demo-secrets/`, the packs copied from the server image, the Helm chart (without its CI files) with `values-ha.yaml`, the release public keys and `INSTALL-ONPREM.md`.
5. Saves the five images and scans them with Trivy. The MSCD images must have no HIGH or CRITICAL vulnerability that has a fix; the third-party images are reported in `SECURITY-SCAN.txt`. With `syft` installed, an SBOM per image goes to `sbom/`.
6. Runs `check-release-artefacts.sh` on the whole bundle, including every image layer and every pack (R-13).
7. Writes `BUNDLE-INFO` and `SHA256SUMS`, signs the checksums, and packs the bundle.

The output in `deploy/dist/`:

- `mscd-onprem-<version>.tar.gz` and `mscd-onprem-<version>.tar.gz.sha256`: deliver both
- `mscd-release.pub`: deliver it with them
- `mscd-onprem-<version>/`: the bundle contents, for inspection
- `mscd-onprem-<version>.logs/`: build, Helm, scan and release check logs (not delivered)

`install.sh` and `upgrade.sh` read `BUNDLE-INFO`: `VERSION`, `IMAGE`, `IMAGE_FILE`, `IMAGE_ARCH`, `IMAGE_LAYERS` (web), `SERVER_IMAGE`, `SERVER_IMAGE_FILE`, `SERVER_IMAGE_LAYERS`, and `EXTRA_IMAGE_1` to `EXTRA_IMAGE_3` (`<image:tag> <file> <layers>`). The layers value is the fingerprint of `image_fingerprint` in `scripts/lib/common.sh`, checked after `docker load`.

Options:

| Option | Use |
|---|---|
| `--version VERSION` | Release version (default: the version of `apps/server/package.json`) |
| `--trusted-keys-dir DIR`, `--pack-signing-key FILE` | Release keys (required) |
| `--sign-key FILE` | Signs `SHA256SUMS` (required with `--release`) |
| `--build-ca FILE` | CA of a TLS-inspecting proxy for npm, apk and Trivy (default `$MSCD_BUILD_CA`) |
| `--release` | Same as `--pull --os-updates true --scan gate`, plus a signature and committed sources |
| `--pull` | Pull the newest base images before building |
| `--os-updates true\|auto\|false`, `--no-os-updates` | Alpine updates in the MSCD images (default `auto`: applied when the mirrors answer) |
| `--scan auto\|gate\|report\|off`, `--skip-scan` | Vulnerability scan (default `auto`: a gate when the Alpine updates were applied, otherwise a report and the bundle counts as a test build) |
| `--no-build` | Package `<server image>:VERSION` and `<web image>:VERSION` that already exist locally |
| `--server-image NAME`, `--web-image NAME` | Image repositories |
| `--output DIR` | Output directory (default `deploy/dist`) |

`BUNDLE-INFO` records `OS_UPDATES`, `SECURITY_SCAN` and `RELEASE_BUILD`, so a test build cannot pass for a release.

### Rehearsal build

To prove the release path without release keys (CI, a build sandbox), generate rehearsal keys outside the repository and build without `--release`:

```bash
K=$(mktemp -d)
for n in pack licence anchor; do node packages/pack-tools/dist/cli.js keygen --out "$K" --name "$n-rehearsal"; done
deploy/scripts/build-bundle.sh --version 1.0.1-rc.1 --trusted-keys-dir "$K" --pack-signing-key "$K/pack-rehearsal.key"
```

Licences signed by CyberLentera do not work with such a bundle; it is for tests only.

## Release artefact check

```bash
deploy/scripts/check-release-artefacts.sh <bundle dir | archive | image>...
```

It fails (exit 1) when a file contains a development key id of `packages/pack-tools/dev-keys/dev-key-ids.json`, when a file is identical to a file of the development secret folders (`packages/pack-tools/dev-keys/`, `apps/server/test/fixtures/secrets/`, `deploy/compose/config/demo-secrets/`, `deploy/compose/dev/`, hashed when the check runs) or to the demo seed data, or when a `demo.yaml` or `test.yaml` profile or the seed snapshot is present. Archives inside the artefacts are opened: image files, every image layer, the Helm chart and the packs. `build-bundle.sh` runs it on every bundle, and CI on every release image.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request:

| Job | Checks |
|---|---|
| `lint-typecheck-unit` | `npm run lint`, `npm run typecheck`, `npm test`, generated views, pack sources, shellcheck of the scripts, `docker compose config` of the Compose files |
| `text-rules` | No em dash or centre dot in `docs/`, `deploy/` and `.github/` |
| `integration` | `npm run test:int` on PostgreSQL 15, 16 and 17 (`MSCD_TEST_PG_IMAGE`) |
| `e2e-sample`, `e2e-api` | The web E2E suites (Playwright 1.56.1, Chromium cached) |
| `images` | Web image, release server image with rehearsal keys, demo server image; `check-release-artefacts.sh` on the release images and a self-test with a development key; Trivy |
| `smoke` | `npm run test:smoke` |
| `helm-static` | `deploy/helm/mscd/ci/validate.sh` |

Nightly (and by hand with the input "nightly"): `helm` runs `deploy/helm/mscd/ci/k3s-test.sh`, and `bundle` builds a signed rehearsal bundle, installs it with `install.sh`, checks `/api/v1/system/profile` and removes it with `uninstall.sh --purge`.

The optional repository secret `MSCD_BUILD_CA` holds the CA certificate of a TLS-inspecting proxy; each job writes it to a file (empty when unset).

## Demo on a test server

`scripts/deploy-demo.sh` builds the demo images from the checkout and starts the stack with `compose/docker-compose.yml`, `compose/docker-compose.demo.yml` and `compose/docker-compose.vps.yml` (only the web port is published, on every address). Settings: `MSCD_DEMO_PUBLIC_URL`, `MSCD_PUBLIC_PORT` (80), `MSCD_DEMO_RESET=1`. The workflow `.github/workflows/deploy-demo.yml` (Actions, Deploy demo, Run workflow) runs it on the server over SSH with the secrets `VPS_HOST`, `VPS_USER` and `VPS_SSH_KEY`. Demo data and public demo keys only; never for real data.

## Checks before a release

```bash
docker run --rm -v "$PWD/deploy/scripts:/s:ro" -w /s koalaman/shellcheck:stable -x \
  install.sh upgrade.sh uninstall.sh build-bundle.sh check-release-artefacts.sh deploy-demo.sh lib/common.sh
docker run --rm -v "$PWD/deploy:/d:ro" -w /d koalaman/shellcheck:stable -s sh \
  nginx/40-mscd-runtime.sh compose/config/postgres/10-mscd-bootstrap.sh
docker compose -f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.demo.yml config -q
bash deploy/helm/mscd/ci/validate.sh
npm run check:text
```

Then install the new bundle on a clean test server with `install.sh`, upgrade a copy of the previous release with `upgrade.sh`, and try `upgrade.sh --rollback`.
