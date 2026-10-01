# MSCD mock providers image: local stand-ins for the Microsoft identity platform,
# Microsoft Graph and the Google OAuth and Drive v3 APIs (tools/mock-providers).
# Demo overlay and tests only; never part of the offline bundle (build plan I.2).
#
# Build from the repository root (the build context):
#
#   docker buildx build --load -f deploy/docker/mock-providers.Dockerfile \
#     --secret id=build_ca,src="$MSCD_BUILD_CA" \
#     -t cyberlentera/mscd-mock-providers:1.0.0 .
#
# Build arguments: VERSION, REVISION, CREATED, APK_UPGRADE (true, auto or false,
# default auto, as in web.Dockerfile) and NODE_IMAGE.
#
# The server listens on 4310 with the demo fixtures (tools/mock-providers/fixtures/
# demo.json). Pass other arguments to change that, for example
# "--port 4310 --fixtures example" or "--fixtures /fixtures/mine.json" with a
# mounted file.

ARG NODE_IMAGE=node:22-alpine

# ---- Manifests stage -------------------------------------------------------
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

# ---- Build -----------------------------------------------------------------
# The workspace and the root (TypeScript and the Node types live there).
FROM ${NODE_IMAGE} AS build
WORKDIR /src
ENV CI=true NPM_CONFIG_UPDATE_NOTIFIER=false
COPY --from=manifests /manifests/ ./
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=secret,id=build_ca \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci -w @mscd/mock-providers --include-workspace-root --no-audit --no-fund --loglevel=error
COPY tsconfig.base.json ./
COPY tools/mock-providers/ tools/mock-providers/
RUN npm run build -w @mscd/mock-providers \
 && chmod -R u=rwX,go=rX tools/mock-providers/dist tools/mock-providers/fixtures

# ---- Production dependencies ----------------------------------------------
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /src
ENV CI=true NPM_CONFIG_UPDATE_NOTIFIER=false
COPY --from=manifests /manifests/ ./
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=secret,id=build_ca \
    set -eu; \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --omit=dev -w @mscd/mock-providers --no-audit --no-fund --loglevel=error; \
    for link in node_modules/@mscd/*; do \
        [ "${link##*/}" = mock-providers ] || rm -rf "$link"; \
    done; \
    rm -rf apps packages tools/smoke package-lock.json node_modules/.package-lock.json; \
    chmod -R u=rwX,go=rX /src

# ---- Runtime ---------------------------------------------------------------
FROM ${NODE_IMAGE}
ARG APK_UPGRADE=auto
ARG VERSION=0.0.0-dev
ARG REVISION=unknown
ARG CREATED=unknown
LABEL org.opencontainers.image.title="MSCD Mock Providers" \
      org.opencontainers.image.description="Mock Microsoft 365 and Google Drive APIs for MSCD demos and tests; not for production" \
      org.opencontainers.image.vendor="CyberLentera" \
      org.opencontainers.image.url="https://mscd.cyberlentera.com" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}"
# Alpine security updates, with the same modes and messages as web.Dockerfile.
RUN --mount=type=secret,id=build_ca \
    set -eu; \
    case "$APK_UPGRADE" in \
        true | auto) ;; \
        false) echo "Skipping apk upgrade (APK_UPGRADE=false)"; exit 0 ;; \
        *) echo "APK_UPGRADE must be true, auto or false, not '$APK_UPGRADE'" >&2; exit 1 ;; \
    esac; \
    if [ -s /run/secrets/build_ca ]; then \
        cat /etc/ssl/certs/ca-certificates.crt /run/secrets/build_ca >/tmp/build-ca.pem; \
        export SSL_CERT_FILE=/tmp/build-ca.pem; \
    fi; \
    if apk update; then \
        apk upgrade; \
    elif [ "$APK_UPGRADE" = auto ]; then \
        echo "WARNING: apk update failed, see the messages above (mirror not reachable or blocked by a proxy, or TLS certificate not trusted: check the build_ca secret). Alpine updates are NOT applied (APK_UPGRADE=auto)." >&2; \
        echo "WARNING: build with --build-arg APK_UPGRADE=true to make this an error." >&2; \
    else \
        echo "apk update failed and APK_UPGRADE=true, see the messages above (mirror not reachable or blocked by a proxy, or TLS certificate not trusted). Allow access to the mirrors, pass the CA of a TLS-inspecting proxy as the build_ca secret, or build with --build-arg APK_UPGRADE=false." >&2; \
        exit 1; \
    fi; \
    rm -rf /tmp/build-ca.pem /var/cache/apk/*
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && mkdir -p /app
WORKDIR /app
COPY --from=prod-deps /src/ /app/
COPY --from=build /src/tools/mock-providers/dist/ tools/mock-providers/dist/
COPY --from=build /src/tools/mock-providers/fixtures/ tools/mock-providers/fixtures/
ENV NODE_ENV=production HOME=/tmp
USER 10001:0
EXPOSE 4310
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -T 2 -O /dev/null http://127.0.0.1:4310/_admin/health || exit 1
ENTRYPOINT ["node", "tools/mock-providers/dist/server.js"]
CMD ["--port", "4310", "--fixtures", "demo"]
