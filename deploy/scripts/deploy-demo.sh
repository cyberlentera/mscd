#!/usr/bin/env bash
# Builds the three demo images from this checkout and starts the demo stack on a
# test server. Run from the repository root:  bash deploy/scripts/deploy-demo.sh
#
# Settings (environment variables):
#   MSCD_DEMO_PUBLIC_URL  address people open in the browser, for example
#                         http://203.0.113.10 (default: http://<first server address>)
#   MSCD_PUBLIC_PORT      published web port (default: the first free port from 8080;
#                         the chosen ports are kept in deploy/compose/.demo-ports for
#                         the next run, delete that file to choose again)
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

# port_free PORT: true when nothing on this server listens on PORT.
port_free() {
  if command -v ss >/dev/null 2>&1; then
    [ -z "$(ss -Hltn "sport = :$1" 2>/dev/null)" ]
  else
    if (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; then return 1; fi
  fi
}
# pick_port START: the first free port from START, skipping ports already chosen in this run.
chosen=" "
pick_port() {
  local p=$1
  while [ "$p" -lt 65535 ]; do
    case "$chosen" in *" $p "*) ;; *) if port_free "$p"; then chosen="$chosen$p "; echo "$p"; return; fi ;; esac
    p=$((p + 1))
  done
  echo "No free port found from $1" >&2
  exit 1
}

# Ports: values given in the environment win, then the ports of the last run (so an update keeps
# the same address), then the first free ports.
ports_file=deploy/compose/.demo-ports
if [ -f "$ports_file" ]; then
  # shellcheck disable=SC1090
  . "$ports_file"
fi
port="${MSCD_PUBLIC_PORT:-${SAVED_PUBLIC_PORT:-$(pick_port 8080)}}"
chosen="$chosen$port "
https_port="${MSCD_HTTPS_PORT:-${SAVED_HTTPS_PORT:-$(pick_port 18443)}}"
chosen="$chosen$https_port "
keycloak_port="${MSCD_KEYCLOAK_PORT:-${SAVED_KEYCLOAK_PORT:-$(pick_port 18088)}}"
chosen="$chosen$keycloak_port "
mailpit_port="${MSCD_MAILPIT_PORT:-${SAVED_MAILPIT_PORT:-$(pick_port 18025)}}"
printf 'SAVED_PUBLIC_PORT=%s\nSAVED_HTTPS_PORT=%s\nSAVED_KEYCLOAK_PORT=%s\nSAVED_MAILPIT_PORT=%s\n' \
  "$port" "$https_port" "$keycloak_port" "$mailpit_port" > "$ports_file"
echo "==> Web port $port (local only: HTTPS $https_port, Keycloak $keycloak_port, Mailpit $mailpit_port)"

if [ -z "${MSCD_DEMO_PUBLIC_URL:-}" ]; then
  address="$(hostname -I 2>/dev/null | awk '{print $1}')"
  MSCD_DEMO_PUBLIC_URL="http://${address:-localhost}"
  [ "$port" = "80" ] || MSCD_DEMO_PUBLIC_URL="${MSCD_DEMO_PUBLIC_URL}:${port}"
fi
export MSCD_HTTPS_PORT="$https_port" MSCD_KEYCLOAK_PORT="$keycloak_port" MSCD_MAILPIT_PORT="$mailpit_port"
version="demo-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M)"

export MSCD_VERSION="$version" MSCD_DEMO_PUBLIC_URL MSCD_PUBLIC_PORT="$port"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-mscd-demo}"
compose=(docker compose --env-file /dev/null
  -f deploy/compose/docker-compose.yml
  -f deploy/compose/docker-compose.demo.yml
  -f deploy/compose/docker-compose.vps.yml)

# Some servers (kernel or AppArmor settings of the host) refuse the hardened container options the
# stack uses, and every container then stops with "exec ...: operation not permitted". Test them once
# and, when needed, add an overlay that relaxes only what this server refuses.
compat_file=deploy/compose/.docker-compose.compat.yml
rm -f "$compat_file"
probe() { docker run --rm --pull missing "$@" postgres:16.15-alpine true >/dev/null 2>&1; }
hardened=(--cap-drop ALL --security-opt no-new-privileges:true --init)
compat=""
echo "==> Checking that this server accepts the container security options"
if probe "${hardened[@]}"; then
  echo "    All options work."
elif probe "${hardened[@]}" --security-opt apparmor=unconfined; then
  compat=apparmor
  echo "    This server needs AppArmor relaxed for the demo containers."
elif probe --cap-drop ALL --init; then
  compat=nnp
  echo "    This server refuses no-new-privileges; the demo runs without it."
elif probe; then
  compat=all
  echo "    This server refuses the hardened options; the demo runs with Docker defaults."
else
  echo "Docker on this server cannot start any container. Details:" >&2
  docker run --rm postgres:16.15-alpine true || true
  uname -r >&2
  echo "Reinstall Docker (curl -fsSL https://get.docker.com | sh) and try again." >&2
  exit 1
fi
if [ -n "$compat" ]; then
  {
    echo "# Written by deploy-demo.sh for this server ($compat). Do not commit."
    echo "services:"
    for service in $("${compose[@]}" --profile '*' config --services); do
      echo "  $service:"
      case "$compat" in
        apparmor) echo "    security_opt: [\"apparmor=unconfined\"]" ;;
        nnp) echo "    security_opt: !reset []" ;;
        all) printf '    security_opt: !reset []\n    cap_drop: !reset []\n    init: false\n' ;;
      esac
    done
  } > "$compat_file"
  compose+=(-f "$compat_file")
fi

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

If the page does not open from another computer, allow port $port in the firewall
(for example: ufw allow $port/tcp) and in the firewall of your VPS provider.

Sign in with rina.kusuma@nusantaradigital.co.id and the password Mscd-Demo-2026!
The second factor code: node tools/scripts/demo-totp.mjs rina
(or add the secret from: node tools/scripts/demo-totp.mjs rina --secret
to an authenticator app).

Stop:  ${compose[*]} down
DONE
