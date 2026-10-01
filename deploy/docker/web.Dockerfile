# MSCD web image: builds the single-page app and serves it with unprivileged NGINX.
#
# Build from the repository root (the build context), so npm ci runs against the
# workspace lockfile. The NGINX configuration comes from deploy/nginx through a
# named build context (BuildKit, Docker 23 or later):
#
#   docker buildx build --pull --load -f deploy/docker/web.Dockerfile \
#     --build-context nginx-config=deploy/nginx \
#     --secret id=build_ca,src="$MSCD_BUILD_CA" \
#     --build-arg VERSION=1.0.0 --build-arg REVISION=$(git rev-parse --short HEAD) \
#     -t cyberlentera/mscd-web:1.0.0 .
#
# MSCD_BUILD_CA names the CA certificate of a TLS-inspecting proxy between the build
# machine and the npm registry or the Alpine mirrors. Without such a proxy, point it
# to an empty file (BuildKit does not accept /dev/null); an empty secret is ignored.
#
# Build arguments: VITE_DATA_SOURCE (sample or api, default sample), VERSION,
# REVISION, CREATED, APK_UPGRADE, NODE_IMAGE and NGINX_IMAGE.
#
# deploy/scripts/build-bundle.sh runs this build for you and scans the result
# for known vulnerabilities before it packages the image.

ARG NODE_IMAGE=node:22-alpine
# Current stable NGINX on a current Alpine. The minor tag follows patch releases;
# build with --pull so every release starts from the latest patched base.
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.30-alpine3.24

# Replaced by --build-context nginx-config=deploy/nginx
FROM scratch AS nginx-config

# ---- Manifests stage -------------------------------------------------------
# Every workspace package.json (outside node_modules) and the root lockfile, in
# their repository paths. The dependency layer of the build stage depends on
# these files only, so a source change does not run npm ci again.
FROM ${NODE_IMAGE} AS manifests
RUN --mount=type=bind,target=/context \
    set -eu; \
    cd /context; \
    test -f package-lock.json || { echo "package-lock.json missing: build from the repository root" >&2; exit 1; }; \
    find . -name node_modules -prune -o -type f -name package.json -print | while IFS= read -r f; do \
        mkdir -p "/manifests/${f%/*}"; \
        cp "$f" "/manifests/$f"; \
    done; \
    cp package-lock.json /manifests/package-lock.json

# ---- Build stage -----------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /src
ENV CI=true NPM_CONFIG_UPDATE_NOTIFIER=false

COPY --from=manifests /manifests/ ./
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=secret,id=build_ca \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --no-audit --no-fund --loglevel=error

# Only the web app sources. When the web build imports another workspace (for
# example packages/shared), copy that workspace here as well.
COPY apps/web/ apps/web/

# sample: the bundled sample organisation, no back end.
# api: the MSCD API behind /api (served by mscd-server).
ARG VITE_DATA_SOURCE=sample
# The Google Fonts links in index.html serve only the optional alternative font
# pairings. They are moved out of the page so browsers make no external request
# by default; the runtime adds them back when MSCD_EXTERNAL_FONTS=true.
# Text assets are pre-compressed so NGINX can serve them with gzip_static.
RUN case "$VITE_DATA_SOURCE" in \
        sample | api) ;; \
        *) echo "VITE_DATA_SOURCE must be sample or api, not '$VITE_DATA_SOURCE'" >&2; exit 1 ;; \
    esac \
 && VITE_DATA_SOURCE="$VITE_DATA_SOURCE" npm run build -w @mscd/web \
 && cd apps/web \
 && grep -E 'fonts\.(googleapis|gstatic)\.com' dist/index.html | sed -e 's/^[[:space:]]*//' | tr -d '\n' >external-fonts.html \
 && sed -i -E '/fonts\.(googleapis|gstatic)\.com/d' dist/index.html \
 && if grep -q 'fonts.g' dist/index.html; then echo "external font links left in index.html" >&2; exit 1; fi \
 && if grep -q "['\$\\\\]" external-fonts.html; then echo "unexpected characters in the font links" >&2; exit 1; fi \
 && find dist -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.svg' -o -name '*.json' \) \
      -size +1k -exec gzip -9 -k -n {} +

# ---- Runtime stage ---------------------------------------------------------
FROM ${NGINX_IMAGE}

ARG NGINX_IMAGE
# false skips the Alpine updates below, for build machines that cannot reach the
# Alpine mirrors. build-bundle.sh still scans the image before packaging it.
ARG APK_UPGRADE=true
ARG VERSION=0.0.0-dev
ARG REVISION=unknown
ARG CREATED=unknown

LABEL org.opencontainers.image.title="MSCD Web" \
      org.opencontainers.image.description="MSCD (Management System Compliance Dashboard) web application" \
      org.opencontainers.image.vendor="CyberLentera" \
      org.opencontainers.image.url="https://mscd.cyberlentera.com" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.base.name="${NGINX_IMAGE}"

USER root

# Apply the Alpine security updates published since the base image was built.
RUN --mount=type=secret,id=build_ca \
    if [ "$APK_UPGRADE" != true ]; then echo "Skipping apk upgrade (APK_UPGRADE=$APK_UPGRADE)"; exit 0; fi; \
    if [ -s /run/secrets/build_ca ]; then \
        cat /etc/ssl/certs/ca-certificates.crt /run/secrets/build_ca >/tmp/build-ca.pem; \
        export SSL_CERT_FILE=/tmp/build-ca.pem; \
    fi; \
    apk upgrade --no-cache \
 && rm -f /tmp/build-ca.pem

# Drop entrypoint helpers that rewrite config files (the root filesystem is
# read-only at runtime) and the stock site.
RUN rm -f /docker-entrypoint.d/10-listen-on-ipv6-by-default.sh \
          /docker-entrypoint.d/20-envsubst-on-templates.sh \
 && rm -rf /usr/share/nginx/html/* /etc/nginx/conf.d/* \
 && mkdir -p /etc/nginx/mscd /etc/nginx/tls

COPY --from=nginx-config nginx.conf /etc/nginx/nginx.conf
COPY --from=nginx-config default.conf /etc/nginx/conf.d/default.conf
COPY --from=nginx-config site.conf security-headers.conf https.conf /etc/nginx/mscd/
COPY --from=nginx-config --chmod=0755 40-mscd-runtime.sh /docker-entrypoint.d/40-mscd-runtime.sh
COPY --from=build /src/apps/web/external-fonts.html /etc/nginx/mscd/external-fonts.html
COPY --from=build /src/apps/web/dist/ /usr/share/nginx/html/

# Configuration and content are owned by root and read-only for the NGINX user.
# The configuration test runs as root and leaves a root-owned pid file and temp
# folders in /tmp; they are removed so NGINX (user 101) can create its own when
# /tmp is not a tmpfs, as with a plain "docker run".
RUN chown -R root:root /etc/nginx /usr/share/nginx/html \
 && chmod -R u=rwX,go=rX /etc/nginx /usr/share/nginx/html \
 && nginx -t -q \
 && rm -rf /tmp/nginx.pid /tmp/*_temp

USER 101
EXPOSE 8080 8443

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -q -T 2 -O /dev/null http://127.0.0.1:8080/healthz || exit 1
