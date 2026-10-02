#!/usr/bin/env bash
# Install test of the mscd Helm chart in k3s (build plan I.4, J.1, J.10).
# Nightly CI job "helm" only: k3s cannot start pods on hosts with cgroup v1 and
# nested runc (the build sandbox), so no work package runs it.
#
#   bash deploy/helm/mscd/ci/k3s-test.sh [options]
#
# Steps: build the demo server image and the web image (tag "ci", as
# values-ci.yaml expects), save them and the third-party images (PostgreSQL,
# SeaweedFS, and the k3s pause, CoreDNS and local-path images) as tar files,
# start rancher/k3s:v1.34.1-k3s1 privileged with the build CA mounted and the
# tar files in its auto-import folder (nothing is pulled inside the cluster),
# install the chart with values-ci.yaml (the migrate hook must succeed), wait
# for every pod, run "helm test", check the per-component secret split inside
# the pods, upgrade once with a changed value (the migrate hook runs again, the
# pods roll, generated keys stay the same), run "helm test" again, then delete
# the cluster. Everything is removed on exit, also on failure, unless --keep.
#
# Options:
#   --build-ca <file>    CA bundle for image builds (default $MSCD_BUILD_CA;
#                        an empty file when unset). Also mounted into k3s.
#   --no-build           use existing images cyberlentera/mscd-server-demo:ci
#                        and cyberlentera/mscd-web:ci
#   --name <prefix>      container and file prefix (default mscd-k3s-test)
#   --api-port <port>    host port of the Kubernetes API (default 16443)
#   --timeout <seconds>  wait limit for install, upgrade and pods (default 900)
#   --keep               leave the cluster running for inspection
#   -h, --help           this text
#
# Needs docker (with buildx) and network access to Docker Hub for the
# third-party images. helm runs in alpine/k8s:1.34.1; kubectl is the one in k3s.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CHART_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
REPO_ROOT=$(cd "$CHART_DIR/../../.." && pwd)

K3S_IMAGE=rancher/k3s:v1.34.1-k3s1
HELM_IMAGE=${MSCD_HELM_CHECK_IMAGE:-alpine/k8s:1.34.1}
SERVER_IMAGE=cyberlentera/mscd-server-demo:ci
WEB_IMAGE=cyberlentera/mscd-web:ci
# Third-party images of values-ci.yaml (testServices).
TEST_IMAGES=(postgres:16.15-alpine chrislusf/seaweedfs:4.48)
# System images of k3s v1.34.1+k3s1 with traefik, servicelb and metrics-server
# disabled. Override with K3S_SYSTEM_IMAGES (space separated) for another k3s.
read -r -a SYSTEM_IMAGES <<<"${K3S_SYSTEM_IMAGES:-rancher/mirrored-pause:3.6 rancher/mirrored-coredns-coredns:1.12.3 rancher/local-path-provisioner:v0.0.32 rancher/mirrored-library-busybox:1.36.1}"
PAUSE_IMAGE=${SYSTEM_IMAGES[0]}

RELEASE=mscd
NAMESPACE=mscd
NAME=mscd-k3s-test
API_PORT=16443
TIMEOUT=900
BUILD=1
KEEP=0
BUILD_CA=${MSCD_BUILD_CA:-}

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'; }
log() { printf '[k3s-test] %s\n' "$*"; }
die() { printf '[k3s-test] ERROR: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --build-ca) BUILD_CA=${2:?--build-ca needs a file}; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    --name) NAME=${2:?--name needs a value}; shift 2 ;;
    --api-port) API_PORT=${2:?--api-port needs a port}; shift 2 ;;
    --timeout) TIMEOUT=${2:?--timeout needs seconds}; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done
case "$API_PORT" in ''|*[!0-9]*) die "--api-port must be a number" ;; esac
case "$TIMEOUT" in ''|*[!0-9]*) die "--timeout must be a number of seconds" ;; esac
command -v docker >/dev/null 2>&1 || die "docker is required"

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/$NAME.XXXXXX")
IMAGES_DIR="$WORK_DIR/images"
KUBECONFIG_FILE="$WORK_DIR/kubeconfig"
mkdir -p "$IMAGES_DIR"
chmod 0755 "$WORK_DIR"

if [ -z "$BUILD_CA" ]; then
  BUILD_CA="$WORK_DIR/empty-ca.crt"
  : >"$BUILD_CA"
fi
[ -f "$BUILD_CA" ] || die "build CA file $BUILD_CA does not exist"
BUILD_CA=$(cd "$(dirname "$BUILD_CA")" && pwd)/$(basename "$BUILD_CA")

cleanup() {
  local status=$?
  if [ "$status" -ne 0 ] && docker inspect "$NAME" >/dev/null 2>&1; then
    log "failure: cluster state"
    kctl get pods -A -o wide 2>&1 || true
    kctl -n "$NAMESPACE" get events --sort-by=.lastTimestamp 2>&1 | tail -n 40 || true
    for pod in $(kctl -n "$NAMESPACE" get pods -o name 2>/dev/null); do
      log "logs of $pod"
      kctl -n "$NAMESPACE" logs "$pod" --all-containers --tail=60 2>&1 || true
    done
  fi
  if [ "$KEEP" -eq 1 ]; then
    log "kept: container $NAME, kubeconfig $KUBECONFIG_FILE"
  else
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    rm -rf "$WORK_DIR"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# kctl <args>: kubectl inside the k3s container.
kctl() { docker exec "$NAME" kubectl "$@"; }

# helm_run <args>: helm in the check image against the k3s API.
helm_run() {
  docker run --rm --name "$NAME-helm-$RANDOM" --network host --user "$(id -u):$(id -g)" \
    -e HOME=/tmp -e KUBECONFIG=/work/kubeconfig \
    -v "$WORK_DIR:/work:ro" -v "$CHART_DIR:/chart:ro" \
    "$HELM_IMAGE" helm "$@"
}

# wait_for <description> <command...>: retries every 3 s up to TIMEOUT.
wait_for() {
  local what=$1 deadline=$((SECONDS + TIMEOUT))
  shift
  until "$@" >/dev/null 2>&1; do
    [ "$SECONDS" -lt "$deadline" ] || die "timed out waiting for $what"
    sleep 3
  done
}

if docker inspect "$NAME" >/dev/null 2>&1; then
  die "a container named $NAME exists; remove it or use --name"
fi

if [ "$BUILD" -eq 1 ]; then
  log "building $SERVER_IMAGE and $WEB_IMAGE"
  docker buildx build --load --secret id=build_ca,src="$BUILD_CA" --target demo \
    -f "$REPO_ROOT/deploy/docker/server.Dockerfile" -t "$SERVER_IMAGE" "$REPO_ROOT"
  docker buildx build --load --secret id=build_ca,src="$BUILD_CA" \
    -f "$REPO_ROOT/deploy/docker/web.Dockerfile" --build-context nginx-config="$REPO_ROOT/deploy/nginx" \
    -t "$WEB_IMAGE" "$REPO_ROOT"
fi
for image in "$SERVER_IMAGE" "$WEB_IMAGE"; do
  docker image inspect "$image" >/dev/null 2>&1 || die "image $image is missing (build it or drop --no-build)"
done

log "saving images for the k3s auto-import"
index=0
for image in "${TEST_IMAGES[@]}" "${SYSTEM_IMAGES[@]}"; do
  docker image inspect "$image" >/dev/null 2>&1 || docker pull -q "$image" >/dev/null
done
for image in "$SERVER_IMAGE" "$WEB_IMAGE" "${TEST_IMAGES[@]}" "${SYSTEM_IMAGES[@]}"; do
  index=$((index + 1))
  docker save -o "$IMAGES_DIR/$(printf '%02d' "$index").tar" "$image"
done
chmod 0644 "$IMAGES_DIR"/*.tar

log "starting $K3S_IMAGE as $NAME (API on 127.0.0.1:$API_PORT)"
ca_mount=()
if [ -s "$BUILD_CA" ]; then
  ca_mount=(-v "$BUILD_CA:/etc/ssl/certs/mscd-build-ca.pem:ro")
fi
docker run -d --name "$NAME" --privileged \
  --tmpfs /run --tmpfs /var/run \
  -p "127.0.0.1:$API_PORT:6443" \
  -e K3S_KUBECONFIG_MODE=0644 \
  "${ca_mount[@]}" \
  -v "$IMAGES_DIR:/var/lib/rancher/k3s/agent/images:ro" \
  "$K3S_IMAGE" server \
  --disable=traefik,servicelb,metrics-server \
  --tls-san=127.0.0.1 \
  --pause-image="$PAUSE_IMAGE" >/dev/null

wait_for "the Kubernetes API" kctl get --raw /readyz
wait_for "the node to be Ready" sh -c "docker exec '$NAME' kubectl get nodes --no-headers 2>/dev/null | grep -qw Ready"
wait_for "CoreDNS" kctl -n kube-system rollout status deployment/coredns --timeout=10s
for image in "$SERVER_IMAGE" "$WEB_IMAGE" "${TEST_IMAGES[@]}"; do
  wait_for "the import of $image" sh -c "docker exec '$NAME' crictl inspecti '$image'"
done
docker exec "$NAME" cat /etc/rancher/k3s/k3s.yaml | sed "s#https://127.0.0.1:6443#https://127.0.0.1:$API_PORT#" >"$KUBECONFIG_FILE"
chmod 0644 "$KUBECONFIG_FILE"

log "helm install with values-ci.yaml"
kctl create namespace "$NAMESPACE" >/dev/null
helm_run install "$RELEASE" /chart --namespace "$NAMESPACE" -f /chart/values-ci.yaml --wait --timeout "${TIMEOUT}s"

# check_release <label>: migrate hook done, every pod ready, helm test, secret split.
check_release() {
  local label=$1
  [ "$(kctl -n "$NAMESPACE" get job "$RELEASE-migrate" -o jsonpath='{.status.succeeded}')" = "1" ] \
    || die "$label: the migrate hook did not succeed"
  kctl -n "$NAMESPACE" logs "job/$RELEASE-migrate" | grep -q 'migrate: done' || die "$label: the migrate log has no 'migrate: done'"
  for deployment in web api worker gateway; do
    kctl -n "$NAMESPACE" rollout status "deployment/$RELEASE-$deployment" --timeout="${TIMEOUT}s" >/dev/null
  done
  helm_run test "$RELEASE" --namespace "$NAMESPACE" --logs --timeout 300s
  kctl -n "$NAMESPACE" exec "deploy/$RELEASE-api" -- sh -c 'test ! -e /run/secrets/storage.key && test -e /run/secrets/platform.key && test -e /run/secrets/client.crt' \
    || die "$label: api secrets are wrong"
  kctl -n "$NAMESPACE" exec "deploy/$RELEASE-worker" -- sh -c 'test ! -e /run/secrets/storage.key && test -e /run/secrets/audit-anchor.key' \
    || die "$label: worker secrets are wrong"
  kctl -n "$NAMESPACE" exec "deploy/$RELEASE-gateway" -- sh -c 'test -e /run/secrets/storage.key && test ! -e /run/secrets/platform.key && test ! -e /run/secrets/db-app.url' \
    || die "$label: gateway secrets are wrong"
  log "$label: migrate hook, pods, helm test and secret split ok"
}
check_release install

key_before=$(kctl -n "$NAMESPACE" get secret "$RELEASE-gateway" -o jsonpath='{.data.storage\.key}')
pod_before=$(kctl -n "$NAMESPACE" get pods -l app.kubernetes.io/component=api -o jsonpath='{.items[0].metadata.name}')

log "helm upgrade with a changed value (observability.log_level debug)"
helm_run upgrade "$RELEASE" /chart --namespace "$NAMESPACE" -f /chart/values-ci.yaml \
  --set profile.observability.log_level=debug --wait --timeout "${TIMEOUT}s"
check_release upgrade

[ "$(kctl -n "$NAMESPACE" get secret "$RELEASE-gateway" -o jsonpath='{.data.storage\.key}')" = "$key_before" ] \
  || die "upgrade: storage.key changed (generated keys must be kept)"
pod_after=$(kctl -n "$NAMESPACE" get pods -l app.kubernetes.io/component=api -o jsonpath='{.items[0].metadata.name}')
[ "$pod_after" != "$pod_before" ] || die "upgrade: the api pod did not roll after the profile changed"
kctl -n "$NAMESPACE" get configmap "$RELEASE-profile" -o jsonpath='{.data.profile\.yaml}' | grep -q 'log_level: debug' \
  || die "upgrade: the profile does not carry the new value"

log "all checks passed"
