# MSCD deployment

Everything needed to package MSCD for customer data centres. The customer-facing guide is [docs/INSTALL-ONPREM.md](../docs/INSTALL-ONPREM.md).

| Path | Contents |
|---|---|
| `nginx/` | NGINX configuration baked into the image, plus the start-up script that turns on HTTPS and optional settings |
| `compose/` | Docker Compose file and `.env.example` |
| `helm/mscd-web/` | Helm chart, with `values-ha.yaml` as the production reference |
| `scripts/` | `build-bundle.sh` (release team) and `install.sh`, `upgrade.sh`, `uninstall.sh` (customer) |
| `dist/` | Built bundles (not committed) |

The image is built from `app/Dockerfile`.

## Build a release bundle

On a build machine with Docker 23 or later and internet access, from committed sources:

```bash
deploy/scripts/build-bundle.sh --version 1.0.0 --sign-key /secure/mscd-release.key
```

This builds `cyberlentera/mscd-web:1.0.0` on the latest base image (`--pull`, plus `apk upgrade`), packages the Helm chart, scans the saved image with Trivy, writes checksums, signs them, and creates:

- `deploy/dist/mscd-onprem-1.0.0.tar.gz`
- `deploy/dist/mscd-onprem-1.0.0.tar.gz.sha256`
- `deploy/dist/mscd-release.pub`

Deliver all three files. Publish the public key fingerprint that the build prints through a second channel, such as the support portal, so customers can check the key itself. Create the key pair once and keep the private key offline:

```bash
openssl ecparam -name prime256v1 -genkey -noout -out mscd-release.key
openssl ec -in mscd-release.key -pubout -out mscd-release.pub
```

The security scan is a release gate. The build stops when the image has a HIGH or CRITICAL vulnerability that has a fix. The result is written to `SECURITY-SCAN.txt` in the bundle and summarised in `BUNDLE-INFO`. The build warns, and labels the image `<revision>-dirty`, when `app/`, `deploy/` or `docs/` have uncommitted or untracked files.

Other options:

| Option | Use |
|---|---|
| `--build-ca FILE` | Extra CA certificate for `npm ci`, `apk` and Trivy on build machines behind a TLS-inspecting proxy |
| `--no-os-updates` | Skip `apk upgrade` when the build machine cannot reach the Alpine mirrors. The scan still decides. |
| `--no-build` | Package an image that already exists locally |
| `--skip-scan` | Test builds only. `BUNDLE-INFO` then says `SECURITY_SCAN=skipped`. |

Trivy runs from `aquasec/trivy:0.74.0` when it is not installed (`TRIVY_IMAGE` overrides it), with its database cached in `~/.cache/mscd-trivy`. See `--help`.

## Image

- Build stage: `node:22-alpine`, `npm ci`, `vite build`, text assets pre-compressed.
- Runtime: `nginxinc/nginx-unprivileged:1.30-alpine3.24` (current stable NGINX on Alpine 3.24) with `apk upgrade`, user 101, read-only root filesystem, health check on `/healthz`. Move `NGINX_IMAGE` in `app/Dockerfile` to the next stable tag when it is released.
- `index.html` ships without the Google Fonts links. The start-up script adds them back only with `MSCD_EXTERNAL_FONTS=true`.
- Ports: 8080 (HTTP), 8443 (HTTPS when `/etc/nginx/tls/tls.crt` and `tls.key` are mounted).
- Settings (environment): `MSCD_DOMAIN`, `MSCD_HTTP_REDIRECT`, `MSCD_HTTPS_PUBLIC_PORT`, `MSCD_HSTS`, `MSCD_HSTS_MAX_AGE`, `MSCD_EXTERNAL_FONTS`. See `nginx/40-mscd-runtime.sh`.

## Checks before a release

```bash
docker run --rm -v "$PWD/deploy/scripts:/mnt:ro" -w /mnt koalaman/shellcheck:stable -x install.sh upgrade.sh uninstall.sh build-bundle.sh lib/common.sh
docker run --rm -v "$PWD/deploy/nginx:/mnt:ro" -w /mnt koalaman/shellcheck:stable -s sh 40-mscd-runtime.sh
docker run --rm -v "$PWD/deploy/helm/mscd-web:/chart:ro" alpine/helm:3 lint /chart
docker run --rm -v "$PWD/deploy/helm/mscd-web:/chart:ro" alpine/helm:3 template mscd-web /chart -f /chart/values-ha.yaml
```
