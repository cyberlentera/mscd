#!/usr/bin/env bash
# Builds the three demo images from this checkout and starts the demo stack on a
# test server. Run from the repository root:  bash deploy/scripts/deploy-demo.sh
#
# Settings (environment variables):
#   MSCD_DEMO_PUBLIC_URL  address people open in the browser, for example
#                         http://203.0.113.10 (default: http://<first server address>)
#   MSCD_PUBLIC_PORT      published web port (default 80)
#   MSCD_DEMO_RESET=1     delete the demo data and seed it again
#
# Demo data and public demo keys: for trying the platform, never for real data.
set -euo pipefail

cd "$(dirname "$0")/../.."

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed. Install it with: curl -fsSL https://get.docker.com | sh" >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "The Docker Compose plugin is missing. Install docker-compose-plugin." >&2
  exit 1
fi

port="${MSCD_PUBLIC_PORT:-80}"
if [ -z "${MSCD_DEMO_PUBLIC_URL:-}" ]; then
  address="$(hostname -I 2>/dev/null | awk '{print $1}')"
  MSCD_DEMO_PUBLIC_URL="http://${address:-localhost}"
  [ "$port" = "80" ] || MSCD_DEMO_PUBLIC_URL="${MSCD_DEMO_PUBLIC_URL}:${port}"
fi
version="demo-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M)"

export MSCD_VERSION="$version" MSCD_DEMO_PUBLIC_URL MSCD_PUBLIC_PORT="$port"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-mscd-demo}"
compose=(docker compose --env-file /dev/null
  -f deploy/compose/docker-compose.yml
  -f deploy/compose/docker-compose.demo.yml
  -f deploy/compose/docker-compose.vps.yml)

echo "==> Building images $version (this takes several minutes the first time)"
docker build --target demo -f deploy/docker/server.Dockerfile -t "cyberlentera/mscd-server-demo:$version" .
docker build -f deploy/docker/web.Dockerfile --build-context nginx-config=deploy/nginx -t "cyberlentera/mscd-web:$version" .
docker build -f deploy/docker/mock-providers.Dockerfile -t "cyberlentera/mscd-mock-providers:$version" .

if [ "${MSCD_DEMO_RESET:-0}" = "1" ]; then
  echo "==> Removing the old demo data"
  "${compose[@]}" down -v
fi

echo "==> Starting the stack"
if ! "${compose[@]}" up -d --wait --remove-orphans; then
  echo "The stack did not become healthy. Last log lines:" >&2
  "${compose[@]}" ps >&2 || true
  "${compose[@]}" logs --tail 60 >&2 || true
  exit 1
fi

echo "==> Checking the web address"
curl -fsS "http://127.0.0.1:${port}/healthz" >/dev/null
curl -fsS "http://127.0.0.1:${port}/api/v1/system/profile" >/dev/null

docker image prune -f >/dev/null 2>&1 || true

cat <<DONE

MSCD demo is running: $MSCD_DEMO_PUBLIC_URL

Sign in with rina.kusuma@nusantaradigital.co.id and the password Mscd-Demo-2026!
The second factor code: node tools/scripts/demo-totp.mjs rina
(or add the secret from: node tools/scripts/demo-totp.mjs rina --secret
to an authenticator app).

Stop:  ${compose[*]} down
DONE
