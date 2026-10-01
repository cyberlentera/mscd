#!/usr/bin/env bash
# Image smoke test of the MSCD server (demo target) and web images (build plan
# WP-18): builds both images, starts PostgreSQL, bootstraps and migrates the
# database, starts the storage gateway (TLS off, demo mode), seeds the demo data,
# starts the api and the web image in front of it, then checks through NGINX:
#
#   - GET /api/v1/system/profile through the web container answers 200 with JSON
#     and the api's security headers;
#   - a request with "X-Forwarded-For: 203.0.113.9" and "?token=secret" leaves no
#     203.0.113.9 as client and no secret in the NGINX access log, and the token
#     value reaches neither the NGINX nor the api log;
#   - the static site still refuses methods other than GET and HEAD.
#
# Everything it creates is removed at the end (also on failure or Ctrl-C), unless
# --keep is given.
#
# Usage: deploy/docker/smoke.sh [options]
#   --build-ca <file>      CA certificate of a TLS-inspecting proxy for the image
#                          builds (default: $MSCD_BUILD_CA; an empty file when unset)
#   --no-build             use the images named below as they are
#   --server-image <ref>   demo server image (default mscd-server-demo:smoke)
#   --web-image <ref>      web image (default mscd-web:smoke)
#   --port <port>          host port of the web container on 127.0.0.1 (default 18082)
#   --subnet <cidr>        subnet of the test network, a /24 (default 172.31.251.0/24)
#   --prefix <name>        name prefix of the containers and the network
#                          (default wp-18-smoke)
#   --keep                 leave the containers running for inspection
#   -h, --help             show this text
#
# Requirements: Docker with BuildKit (docker buildx), curl, and the images
# postgres:16.15-alpine and node:22-alpine (pulled when missing).
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

BUILD_CA=${MSCD_BUILD_CA:-}
BUILD=true
SERVER_IMAGE=mscd-server-demo:smoke
WEB_IMAGE=mscd-web:smoke
PORT=18082
SUBNET=172.31.251.0/24
PREFIX=wp-18-smoke
KEEP=false
POSTGRES_IMAGE=postgres:16.15-alpine

usage() { sed -n '2,/^set -euo/p' "$0" | sed -e '/^set -euo/d' -e 's/^# \{0,1\}//'; }
die() { echo "smoke: $*" >&2; exit 2; }
need_value() { [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value"; }

while [ $# -gt 0 ]; do
    case "$1" in
        --build-ca) need_value "$@"; BUILD_CA=$2; shift 2 ;;
        --no-build) BUILD=false; shift ;;
        --server-image) need_value "$@"; SERVER_IMAGE=$2; shift 2 ;;
        --web-image) need_value "$@"; WEB_IMAGE=$2; shift 2 ;;
        --port) need_value "$@"; PORT=$2; shift 2 ;;
        --subnet) need_value "$@"; SUBNET=$2; shift 2 ;;
        --prefix) need_value "$@"; PREFIX=$2; shift 2 ;;
        --keep) KEEP=true; shift ;;
        -h | --help) usage; exit 0 ;;
        *) usage >&2; die "unknown option $1" ;;
    esac
done

case "$PORT" in '' | *[!0-9]*) die "--port must be a number, got '$PORT'" ;; esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "--port must be 1 to 65535, got '$PORT'"
[[ "$SUBNET" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.0/24$ ]] || die "--subnet must be a /24 such as 172.31.251.0/24, got '$SUBNET'"
NET_BASE="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.${BASH_REMATCH[3]}"
WEB_IP="$NET_BASE.10"
[[ "$PREFIX" =~ ^[a-z0-9][a-z0-9_.-]{0,40}$ ]] || die "--prefix must be lower-case letters, digits, '.', '_' or '-', got '$PREFIX'"
command -v docker >/dev/null || die "docker is required"
command -v curl >/dev/null || die "curl is required"

NETWORK="$PREFIX-net"
C_PG="$PREFIX-postgres"
C_GATEWAY="$PREFIX-gateway"
C_API="$PREFIX-api"
C_WEB="$PREFIX-web"
CONTAINERS=("$C_WEB" "$C_API" "$C_GATEWAY" "$C_PG")
WORK=$(mktemp -d "${TMPDIR:-/tmp}/mscd-image-smoke.XXXXXX")
BASE_URL="http://localhost:$PORT"
FAILED=0

log() { echo "smoke: $*"; }
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*" >&2; FAILED=1; }

remove_all() {
    docker rm -f "${CONTAINERS[@]}" >/dev/null 2>&1 || true
    docker network rm "$NETWORK" >/dev/null 2>&1 || true
}

show_logs() {
    for c in "${CONTAINERS[@]}"; do
        if docker inspect "$c" >/dev/null 2>&1; then
            echo "----- last log lines of $c" >&2
            docker logs --tail 40 "$c" 2>&1 | sed 's/^/  /' >&2 || true
        fi
    done
}

cleanup() {
    local status=$?
    if [ "$status" -ne 0 ] || [ "$FAILED" -ne 0 ]; then show_logs; fi
    if [ "$KEEP" = true ]; then
        log "--keep: containers ${CONTAINERS[*]} and network $NETWORK are still running; remove them with: docker rm -f ${CONTAINERS[*]}; docker network rm $NETWORK"
    else
        remove_all
    fi
    rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

random_hex() { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }
random_b64() { head -c "$1" /dev/urandom | base64 | tr -d '\n'; }

# ---- Images ---------------------------------------------------------------
if [ "$BUILD" = true ]; then
    if [ -z "$BUILD_CA" ]; then
        BUILD_CA="$WORK/empty-ca.pem"
        : >"$BUILD_CA"
    fi
    [ -f "$BUILD_CA" ] || die "--build-ca $BUILD_CA is not a file"
    build() {
        local name=$1
        shift
        log "building $name"
        if ! docker buildx build --load --progress=plain --secret id=build_ca,src="$BUILD_CA" "$@" "$ROOT" >"$WORK/build.log" 2>&1; then
            tail -n 60 "$WORK/build.log" >&2
            die "building $name failed"
        fi
    }
    build "$SERVER_IMAGE" -f "$ROOT/deploy/docker/server.Dockerfile" --target demo -t "$SERVER_IMAGE"
    build "$WEB_IMAGE" -f "$ROOT/deploy/docker/web.Dockerfile" --build-context nginx-config="$ROOT/deploy/nginx" -t "$WEB_IMAGE"
fi
for image in "$SERVER_IMAGE" "$WEB_IMAGE"; do
    docker image inspect "$image" >/dev/null 2>&1 || die "image $image not found (build it or drop --no-build)"
done

# ---- Network and secrets ----------------------------------------------------
remove_all
log "network $NETWORK ($SUBNET, web at $WEB_IP)"
docker network create --subnet "$SUBNET" "$NETWORK" >/dev/null \
    || die "cannot create network $NETWORK with subnet $SUBNET (in use? pick another with --subnet)"

# Each container gets only its own secret files (I.3): migrate (bootstrap,
# migrate and seed), gateway and api. Fresh random values on every run.
ADMIN_PW=$(random_hex 16)
MIGRATOR_PW=$(random_hex 16)
APP_PW=$(random_hex 16)
PACK_PW=$(random_hex 16)
GATEWAY_TOKEN=$(random_hex 32)
PLATFORM_KEY=$(random_b64 32)
STORAGE_KEY=$(random_b64 32)
DB="postgres:5432/mscd"
mkdir -p "$WORK/secrets/migrate" "$WORK/secrets/gateway" "$WORK/secrets/api"
put() { printf '%s' "$3" >"$WORK/secrets/$1/$2"; }
put migrate db-admin.url "postgres://postgres:$ADMIN_PW@$DB"
put migrate db-migrator.url "postgres://mscd_migrator:$MIGRATOR_PW@$DB"
put migrate db-pack.url "postgres://mscd_pack_installer:$PACK_PW@$DB"
put migrate db-app.url "postgres://mscd_app:$APP_PW@$DB"
put migrate platform.key "$PLATFORM_KEY"
put migrate gateway.token "$GATEWAY_TOKEN"
put migrate keycloak-client.secret "mscd-dev-oidc-secret"
put gateway storage.key "$STORAGE_KEY"
put gateway gateway.token "$GATEWAY_TOKEN"
put gateway s3.access "mscd-dev"
put gateway s3.secret "mscd-dev-secret-0123456789"
put api db-app.url "postgres://mscd_app:$APP_PW@$DB"
put api platform.key "$PLATFORM_KEY"
put api gateway.token "$GATEWAY_TOKEN"
put api keycloak-client.secret "mscd-dev-oidc-secret"
chmod 0755 "$WORK" "$WORK/secrets"
if [ "$(id -u)" = 0 ]; then
    chown -R 10001:0 "$WORK/secrets"
    find "$WORK/secrets" -type d -exec chmod 0500 {} +
    find "$WORK/secrets" -type f -exec chmod 0400 {} +
else
    find "$WORK/secrets" -type d -exec chmod 0755 {} +
    find "$WORK/secrets" -type f -exec chmod 0444 {} +
fi

# The demo profile of the image with its secret paths pointed at /run/secrets.
SERVER_ENV=(
    -e MSCD_PROFILE_FILE=/app/apps/server/profiles/demo.yaml
    -e MSCD__KMS__FILE__PATH=/run/secrets/platform.key
    -e MSCD__STORAGE__GATEWAY__TOKEN_FILE=/run/secrets/gateway.token
    -e MSCD__GATEWAY__TOKEN_FILES='[/run/secrets/gateway.token]'
    -e MSCD__GATEWAY__KMS__FILE__PATH=/run/secrets/storage.key
    -e MSCD__GATEWAY__VAULT__ACCESS_KEY_FILE=/run/secrets/s3.access
    -e MSCD__GATEWAY__VAULT__SECRET_KEY_FILE=/run/secrets/s3.secret
    -e MSCD__AUDIT__ANCHOR_KEY_FILE=/run/secrets/audit-anchor.key
    -e MSCD__HTTP__PUBLIC_URL="$BASE_URL"
    -e MSCD__HTTP__TRUST_PROXY="{cidrs: [\"$WEB_IP/32\"]}"
)
HARDENING=(--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true --init)
server() {
    # server <secret set> <docker run options...> -- <mscd-server arguments...>
    local set=$1
    shift
    local opts=()
    while [ $# -gt 0 ] && [ "$1" != -- ]; do opts+=("$1"); shift; done
    shift
    docker run --network "$NETWORK" "${HARDENING[@]}" --user 10001:0 \
        -v "$WORK/secrets/$set:/run/secrets:ro" "${SERVER_ENV[@]}" "${opts[@]}" "$SERVER_IMAGE" "$@"
}
db_env=(
    -e MSCD_DATABASE_ADMIN_URL_FILE=/run/secrets/db-admin.url
    -e MSCD_DATABASE_MIGRATOR_URL_FILE=/run/secrets/db-migrator.url
    -e MSCD_DATABASE_PACK_URL_FILE=/run/secrets/db-pack.url
    -e MSCD_DATABASE_URL_FILE=/run/secrets/db-app.url
)

wait_for() {
    # wait_for <description> <seconds> <command...>
    local what=$1 seconds=$2
    shift 2
    local i
    for ((i = 0; i < seconds; i++)); do
        if "$@" >/dev/null 2>&1; then return 0; fi
        sleep 1
    done
    die "$what did not become ready within ${seconds}s"
}
in_container_get() { docker exec "$1" wget -q -T 2 -O /dev/null "$2"; }

# ---- PostgreSQL -------------------------------------------------------------
log "starting $POSTGRES_IMAGE"
docker run -d --name "$C_PG" --network "$NETWORK" --network-alias postgres \
    -e POSTGRES_PASSWORD="$ADMIN_PW" -e POSTGRES_DB=mscd \
    --tmpfs /var/lib/postgresql/data "$POSTGRES_IMAGE" >/dev/null
# pg_isready over TCP: the init scripts run on a socket-only server first.
wait_for "PostgreSQL" 90 docker exec "$C_PG" pg_isready -q -h 127.0.0.1 -U postgres -d mscd

# ---- Bootstrap, migrate -------------------------------------------------------
log "db bootstrap"
server migrate --rm "${db_env[@]}" -- db bootstrap
log "migrate"
server migrate --rm "${db_env[@]}" -- migrate

# ---- Storage gateway (TLS off: demo mode only) -------------------------------
log "starting the storage gateway"
server gateway -d --name "$C_GATEWAY" --network-alias storage-gateway -- storage-gateway >/dev/null
wait_for "storage gateway" 60 in_container_get "$C_GATEWAY" http://127.0.0.1:9464/healthz

# ---- Seed ----------------------------------------------------------------------
log "seed demo (data keys and credentials through the gateway)"
server migrate --rm "${db_env[@]}" -- seed demo --keys gateway

# ---- api and web ------------------------------------------------------------------
log "starting the api"
server api -d --name "$C_API" --network-alias api -e MSCD_DATABASE_URL_FILE=/run/secrets/db-app.url -- api >/dev/null
wait_for "api" 90 in_container_get "$C_API" http://127.0.0.1:3000/readyz

log "starting the web image on 127.0.0.1:$PORT"
docker run -d --name "$C_WEB" --network "$NETWORK" --ip "$WEB_IP" -p "127.0.0.1:$PORT:8080" \
    --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
    -e MSCD_API_UPSTREAM=api:3000 "$WEB_IMAGE" >/dev/null
wait_for "web" 30 curl -fsS -o /dev/null "$BASE_URL/healthz"

# ---- Checks -------------------------------------------------------------------------
HEADERS="$WORK/headers.txt"
BODY="$WORK/body.json"
header() { tr -d '\r' <"$HEADERS" | grep -i "^$1:" | head -n 1 | cut -d' ' -f2-; }

code=$(curl -sS -D "$HEADERS" -o "$BODY" -w '%{http_code}' "$BASE_URL/api/v1/system/profile")
if [ "$code" = 200 ]; then pass "GET $BASE_URL/api/v1/system/profile through the web container: 200"; else fail "GET /api/v1/system/profile through the web container: $code, expected 200"; fi
case "$(header content-type)" in
    application/json*) pass "system profile is JSON" ;;
    *) fail "system profile content type is '$(header content-type)', expected application/json" ;;
esac
if grep -q '"deploy"' "$BODY"; then pass "system profile body names the deployment"; else fail "system profile body has no \"deploy\" field: $(head -c 300 "$BODY")"; fi
[ "$(header cache-control)" = no-store ] && pass "Cache-Control: no-store on /api" || fail "Cache-Control on /api is '$(header cache-control)', expected no-store"
[ "$(header content-security-policy)" = "default-src 'none'; frame-ancestors 'none'; sandbox" ] \
    && pass "the api's Content-Security-Policy reaches the client" \
    || fail "Content-Security-Policy on /api is '$(header content-security-policy)'"
[ -n "$(header x-request-id)" ] && pass "X-Request-Id set by NGINX is echoed by the api" || fail "no X-Request-Id on /api"

# The request of the acceptance, then one with a value found nowhere else.
UNIQUE="wp18smoke$(random_hex 8)"
code=$(curl -sS -o /dev/null -w '%{http_code}' -H 'X-Forwarded-For: 203.0.113.9' "$BASE_URL/api/v1/system/profile?token=secret")
[ "$code" = 200 ] || fail "GET /api/v1/system/profile?token=secret with X-Forwarded-For: $code, expected 200"
code=$(curl -sS -o /dev/null -w '%{http_code}' -H 'X-Forwarded-For: 203.0.113.9' "$BASE_URL/api/v1/system/profile?token=$UNIQUE&code=$UNIQUE&q=1")
[ "$code" = 200 ] || fail "GET /api/v1/system/profile?token=...&code=... with X-Forwarded-For: $code, expected 200"
sleep 1
docker logs "$C_WEB" >"$WORK/web.log" 2>&1
docker logs "$C_API" >"$WORK/api.log" 2>&1
if grep -q 'GET /api/v1/system/profile?token=\[redacted\]' "$WORK/web.log"; then
    pass "NGINX access log has the request with token=[redacted]"
else
    fail "NGINX access log has no line for /api/v1/system/profile?token=[redacted]"
fi
if grep -q '203\.0\.113\.9' "$WORK/web.log"; then fail "NGINX access log names 203.0.113.9 (the client's X-Forwarded-For)"; else pass "NGINX access log does not name 203.0.113.9 as client"; fi
if grep -q 'secret' "$WORK/web.log"; then fail "NGINX access log contains the token value 'secret'"; else pass "NGINX access log does not contain 'secret'"; fi
if grep -q "$UNIQUE" "$WORK/web.log" "$WORK/api.log"; then fail "a token or code value reached the NGINX or api log"; else pass "token and code values reach neither the NGINX nor the api log"; fi
if grep -q '203\.0\.113\.9' "$WORK/api.log"; then fail "the api log names 203.0.113.9"; else pass "the api log does not name 203.0.113.9"; fi

code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/")
[ "$code" = 405 ] && pass "POST / on the static site: 405" || fail "POST / on the static site: $code, expected 405"
code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/login")
[ "$code" = 200 ] && pass "client-side route /login serves the app: 200" || fail "GET /login: $code, expected 200"

if [ "$FAILED" -ne 0 ]; then
    echo "smoke: FAILED" >&2
    exit 1
fi
echo "smoke: all checks passed"
