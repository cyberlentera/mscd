# MSCD server image: one image for the run modes api, worker, storage-gateway and migrate
# and the admin commands of mscd-server (build plan D-01, D-24, I.2).
#
# Targets:
#   release (default, the last stage)  cyberlentera/mscd-server
#       Release flavour. Trusted keys come only from the named build context
#       "trusted-keys" (licence-*.pub, pack-*.pub, anchor-*.pub); the packs are
#       signed with the build secret "pack_signing_key" (no default). The build
#       fails when either holds a key listed in dev-key-ids.json. No demo or
#       test profile, no seed data, no dev key or dev secret in the image (R-13).
#   demo                               cyberlentera/mscd-server-demo
#       Development flavour for the demo overlay, the smoke tests and the API
#       E2E stack only; never part of the offline bundle. Development trust
#       anchors and development-signed packs, plus the demo and test profiles,
#       the demo seed snapshot and the development licences.
#
# Build from the repository root (the build context):
#
#   docker buildx build --load -f deploy/docker/server.Dockerfile \
#     --secret id=build_ca,src="$MSCD_BUILD_CA" \
#     --secret id=pack_signing_key,src=/secure/pack-release.key \
#     --build-context trusted-keys=/secure/trusted-keys \
#     --build-arg VERSION=1.0.0 --build-arg REVISION=$(git rev-parse --short=12 HEAD) \
#     -t cyberlentera/mscd-server:1.0.0 .
#
#   docker buildx build --load -f deploy/docker/server.Dockerfile --target demo \
#     --secret id=build_ca,src="$MSCD_BUILD_CA" -t cyberlentera/mscd-server-demo:1.0.0 .
#
# MSCD_BUILD_CA names the CA certificate of a TLS-inspecting proxy between the
# build machine and the npm registry or the Alpine mirrors (R-12). Without such a
# proxy, point it to an empty file (BuildKit does not accept /dev/null).
#
# Build arguments: VERSION, REVISION, CREATED, APK_UPGRADE (true, auto or false,
# default auto, as in web.Dockerfile) and NODE_IMAGE. deploy/docker/README.md
# describes every input.

ARG NODE_IMAGE=node:22-alpine

# Replaced by --build-context trusted-keys=<folder>. Left empty, the release build
# stops with "holds no licence-*.pub key" (D-16: release keys never come from the
# repository). The demo target does not use it.
FROM scratch AS trusted-keys

# ---- Manifests stage -------------------------------------------------------
# Every workspace package.json (outside node_modules) and the root lockfile, in
# their repository paths, so the npm ci layers depend on these files only.
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

# ---- Dependencies (build) --------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /src
ENV CI=true NPM_CONFIG_UPDATE_NOTIFIER=false
COPY --from=manifests /manifests/ ./
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=secret,id=build_ca \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --no-audit --no-fund --loglevel=error

# ---- Sources ---------------------------------------------------------------
# Only what the server build reads: the three packages it compiles, the pack
# sources and the dev key folder (its dev-key-ids.json is how a release build
# recognises the keys of R-11; the demo target also signs with them).
FROM deps AS sources
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/pack-tools/ packages/pack-tools/
COPY packs/sources/ packs/sources/
COPY apps/server/ apps/server/
# Files of apps/server/src that tsc does not emit (for example the common
# password list of F.4) are copied next to the compiled modules. The demo seed
# snapshot (src/seed/demo) is added by the demo target only.
RUN printf '%s\n' \
      'set -eu' \
      'cd /src/apps/server/src' \
      'find . -type f ! -name "*.ts" ! -name "*.md" ! -path "./seed/demo/*" ! -path "./generated/*" > /tmp/assets.txt' \
      'if [ -s /tmp/assets.txt ]; then tar -cf - -T /tmp/assets.txt | tar -xf - -C /src/apps/server/dist; fi' \
      'rm -f /tmp/assets.txt' \
      > /usr/local/bin/mscd-copy-assets \
 && chmod 0755 /usr/local/bin/mscd-copy-assets

# ---- Release build ---------------------------------------------------------
FROM sources AS build-release
ARG VERSION=0.0.0-dev
ARG REVISION=unknown
# gen-build-info.mjs (prebuild of @mscd/server) compiles the keys of the
# trusted-keys context into the build and refuses a missing folder, a folder
# without a licence or pack key, and any key listed in dev-key-ids.json (D-16).
# The packs are then signed with the pack_signing_key secret; build-all
# --reject-dev-keys refuses a listed key, and every pack is verified against the
# release pack keys. Last, no compiled file may contain a listed key id (R-13).
# (The failure messages come from the tools; this file avoids their wording so
# a search of the build output for them finds only real refusals.)
RUN --mount=type=bind,from=trusted-keys,target=/trusted-keys \
    --mount=type=secret,id=pack_signing_key \
    set -eu; \
    if [ ! -s /run/secrets/pack_signing_key ]; then \
        echo "The release target needs the build secret pack_signing_key (the release pack signing key, Ed25519 PEM); it has no default: --secret id=pack_signing_key,src=<file>" >&2; \
        exit 1; \
    fi; \
    mkdir -p apps/server/dist; \
    MSCD_BUILD_FLAVOR=release MSCD_TRUSTED_KEYS_DIR=/trusted-keys \
    MSCD_VERSION="$VERSION" MSCD_REVISION="$REVISION" \
        npm run build -w @mscd/shared -w @mscd/pack-tools -w @mscd/server; \
    mscd-copy-assets; \
    node packages/pack-tools/dist/cli.js build-all --reject-dev-keys \
        --sign-key-file /run/secrets/pack_signing_key --out /packs; \
    for pack in /packs/*.pack; do \
        node packages/pack-tools/dist/cli.js verify "$pack" --reject-dev-keys --trusted /trusted-keys/pack-*.pub >/dev/null; \
    done; \
    ids=$(node -e 'process.stdout.write(require("./packages/pack-tools/dev-keys/dev-key-ids.json").join("\n"))'); \
    if [ -n "$ids" ] && printf '%s\n' "$ids" | grep -rlF -f - apps/server/dist packages/shared/dist packages/pack-tools/dist; then \
        echo "The files above contain a key id listed in dev-key-ids.json; release builds never ship one (R-13)" >&2; \
        exit 1; \
    fi; \
    grep -q 'BUILD_FLAVOR = "release"' apps/server/dist/generated/build-info.js \
        || { echo "apps/server/dist/generated/build-info.js is not a release build" >&2; exit 1; }; \
    chmod -R u=rwX,go=rX packages/shared/dist packages/pack-tools/dist apps/server/dist apps/server/migrations \
        apps/server/profiles /packs

# ---- Demo build ------------------------------------------------------------
FROM sources AS build-demo
ARG VERSION=0.0.0-dev
ARG REVISION=unknown
RUN set -eu; \
    mkdir -p apps/server/dist; \
    MSCD_BUILD_FLAVOR=dev MSCD_TRUSTED_KEYS_DIR=/src/packages/pack-tools/dev-keys \
    MSCD_VERSION="$VERSION" MSCD_REVISION="$REVISION" \
        npm run build -w @mscd/shared -w @mscd/pack-tools -w @mscd/server; \
    mscd-copy-assets; \
    node packages/pack-tools/dist/cli.js build-all \
        --sign-key-file packages/pack-tools/dev-keys/pack-signing.key --out /packs; \
    chmod -R u=rwX,go=rX packages/shared/dist packages/pack-tools/dist packages/pack-tools/dev-licences \
        apps/server/dist apps/server/migrations apps/server/profiles apps/server/src/seed/demo /packs

# ---- Production dependencies ----------------------------------------------
# Only the runtime dependencies of the server and of the two packages it loads.
# Workspace links and manifests of the other workspaces are removed.
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /src
ENV CI=true NPM_CONFIG_UPDATE_NOTIFIER=false
COPY --from=manifests /manifests/ ./
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=secret,id=build_ca \
    set -eu; \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --omit=dev --no-audit --no-fund --loglevel=error \
        -w @mscd/server -w @mscd/shared -w @mscd/pack-tools; \
    for link in node_modules/@mscd/*; do \
        case "${link##*/}" in \
            server | shared | pack-tools) ;; \
            *) rm -rf "$link" ;; \
        esac; \
    done; \
    rm -rf apps/web tools package-lock.json node_modules/.package-lock.json; \
    find . -name node_modules -prune -o -type f -name package.json -print | sort > /tmp/manifests.txt; \
    cat /tmp/manifests.txt; \
    rm /tmp/manifests.txt; \
    chmod -R u=rwX,go=rX /src

# ---- Runtime base ----------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime-base
ARG APK_UPGRADE=auto
# Alpine security updates, with the same modes and messages as web.Dockerfile:
# true fails the build when "apk update" fails, auto warns and keeps the base
# packages, false skips the step.
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
# The runtime needs node only: npm, npx, corepack and yarn are removed, so the
# image carries no package manager and none of its dependencies.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && mkdir -p /app
WORKDIR /app
COPY --from=prod-deps /src/ /app/
ENV NODE_ENV=production HOME=/tmp

# ---- Demo target -----------------------------------------------------------
FROM runtime-base AS demo
ARG VERSION=0.0.0-dev
ARG REVISION=unknown
ARG CREATED=unknown
LABEL org.opencontainers.image.title="MSCD Server (demo)" \
      org.opencontainers.image.description="MSCD server, development flavour with demo data: demo, smoke tests and API E2E only, never for production" \
      org.opencontainers.image.vendor="CyberLentera" \
      org.opencontainers.image.url="https://mscd.cyberlentera.com" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      com.cyberlentera.mscd.flavor="dev"
COPY --from=build-demo /src/packages/shared/dist/ packages/shared/dist/
COPY --from=build-demo /src/packages/pack-tools/dist/ packages/pack-tools/dist/
COPY --from=build-demo /src/packages/pack-tools/dev-licences/ packages/pack-tools/dev-licences/
COPY --from=build-demo /src/apps/server/dist/ apps/server/dist/
COPY --from=build-demo /src/apps/server/migrations/ apps/server/migrations/
COPY --from=build-demo /src/apps/server/profiles/onprem.yaml /src/apps/server/profiles/saas.yaml \
                       /src/apps/server/profiles/demo.yaml /src/apps/server/profiles/test.yaml apps/server/profiles/
COPY --from=build-demo /src/apps/server/src/seed/demo/ apps/server/src/seed/demo/
COPY --from=build-demo /packs/ packs/
# The packs are in /app/packs (demo.yaml points at the repository's packs/dist).
# A Compose overlay or test mounts its own secrets and overrides the secret file
# paths of demo.yaml, which point into the source tree.
ENV MSCD_PROFILE_FILE=/app/apps/server/profiles/demo.yaml \
    MSCD__PACKS__DIR=/app/packs
USER 10001:0
EXPOSE 3000 8443 9464
ENTRYPOINT ["node", "apps/server/dist/main.js"]
CMD ["api"]

# ---- Release target (default) ---------------------------------------------
FROM runtime-base AS release
ARG VERSION=0.0.0-dev
ARG REVISION=unknown
ARG CREATED=unknown
LABEL org.opencontainers.image.title="MSCD Server" \
      org.opencontainers.image.description="MSCD (Management System Compliance Dashboard) server: api, worker, storage-gateway and migrate" \
      org.opencontainers.image.vendor="CyberLentera" \
      org.opencontainers.image.url="https://mscd.cyberlentera.com" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      com.cyberlentera.mscd.flavor="release"
COPY --from=build-release /src/packages/shared/dist/ packages/shared/dist/
COPY --from=build-release /src/packages/pack-tools/dist/ packages/pack-tools/dist/
COPY --from=build-release /src/apps/server/dist/ apps/server/dist/
COPY --from=build-release /src/apps/server/migrations/ apps/server/migrations/
COPY --from=build-release /src/apps/server/profiles/onprem.yaml /src/apps/server/profiles/saas.yaml apps/server/profiles/
COPY --from=build-release /packs/ packs/
# Everything in /app is owned by root and read-only for the run user 10001
# (group 0; the build stages set the modes, COPY keeps them). Compose and Helm
# add a read-only root filesystem and a /tmp. The checks below fail the build if
# anything of R-13 slipped in.
RUN set -eu; \
    for f in apps/server/profiles/demo.yaml apps/server/profiles/test.yaml apps/server/src \
             apps/server/test packages/pack-tools/dev-keys packages/pack-tools/dev-licences; do \
        if [ -e "/app/$f" ]; then echo "release image must not contain $f (R-13)" >&2; exit 1; fi; \
    done; \
    if find /app -name 'sample-snapshot.json' -not -path '*/node_modules/*' | grep -q .; then \
        echo "release image must not contain the demo seed snapshot (R-13)" >&2; exit 1; \
    fi; \
    ls /app/packs/*.pack >/dev/null
ENV MSCD_PROFILE_FILE=/app/apps/server/profiles/onprem.yaml
USER 10001:0
EXPOSE 3000 8443 9464
ENTRYPOINT ["node", "apps/server/dist/main.js"]
CMD ["api"]
