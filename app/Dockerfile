# MSCD web image: builds the single-page app and serves it with unprivileged NGINX.
#
# Build from the repository root. The NGINX configuration comes from deploy/nginx
# through a named build context (BuildKit, Docker 23 or later):
#
#   docker buildx build --pull --load -f app/Dockerfile \
#     --build-context nginx-config=deploy/nginx \
#     --build-arg VERSION=1.0.0 --build-arg REVISION=$(git rev-parse --short HEAD) \
#     -t cyberlentera/mscd-web:1.0.0 app
#
# Build machine behind a TLS-inspecting proxy? Pass its CA certificate:
#   --secret id=build_ca,src=/path/to/proxy-ca.pem
#
# deploy/scripts/build-bundle.sh runs this build for you and scans the result
# for known vulnerabilities before it packages the image.

ARG NODE_IMAGE=node:22-alpine
# Current stable NGINX on a current Alpine. The minor tag follows patch releases;
# build with --pull so every release starts from the latest patched base.
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.30-alpine3.24

# Replaced by --build-context nginx-config=deploy/nginx
FROM scratch AS nginx-config

# ---- Build stage -----------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /src
ENV CI=true NPM_CONFIG_UPDATE_NOTIFIER=false

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=secret,id=build_ca \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --no-audit --no-fund --loglevel=error

COPY . .
# The Google Fonts links in index.html serve only the optional alternative font
# pairings. They are moved out of the page so browsers make no external request
# by default; the runtime adds them back when MSCD_EXTERNAL_FONTS=true.
# Text assets are pre-compressed so NGINX can serve them with gzip_static.
RUN npm run build \
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
COPY --from=build /src/external-fonts.html /etc/nginx/mscd/external-fonts.html
COPY --from=build /src/dist/ /usr/share/nginx/html/

# Configuration and content are owned by root and read-only for the NGINX user.
RUN chown -R root:root /etc/nginx /usr/share/nginx/html \
 && chmod -R u=rwX,go=rX /etc/nginx /usr/share/nginx/html \
 && nginx -t -q

USER 101
EXPOSE 8080 8443

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -q -T 2 -O /dev/null http://127.0.0.1:8080/healthz || exit 1
