#!/usr/bin/env bash
# Static checks of the mscd Helm chart (build plan J.1, I.4). Runs on any host
# with Docker and Node.js 22 (repository dependencies installed); no cluster.
#
#   bash deploy/helm/mscd/ci/validate.sh
#
# 1. helm lint --strict with values.yaml, values-ha.yaml and values-ci.yaml;
# 2. helm template for the three values files, plus renders that must fail
#    (missing database URLs, test services without generated secrets, no
#    trusted proxy ranges, mixed TLS modes);
# 3. kubeconform 0.7.0 (-strict, Kubernetes 1.34.1; cert-manager resources
#    from the CRDs catalog at a pinned commit), schemas cached in ci/.schema-cache;
# 4. ci/assert-render.mjs on each render.
#
# helm and kubeconform run in alpine/k8s:1.34.1 with the host network, so
# HTTPS_PROXY works. MSCD_BUILD_CA (a CA bundle file) is mounted as the
# container's CA bundle when set, for networks with a TLS-inspecting proxy.
# MSCD_HELM_CHECK_IMAGE overrides the image.
set -euo pipefail

CHART_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
IMAGE=${MSCD_HELM_CHECK_IMAGE:-alpine/k8s:1.34.1}
KUBE_VERSION=1.34.1
CACHE_DIR="$CHART_DIR/ci/.schema-cache"
# CRDs catalog pinned to a commit (main on 2 Oct 2026), so upstream changes cannot change the check.
CRD_CATALOG_REF=d373c2da9702bc9509a004db83e57263fe3bdfc1
CRD_SCHEMAS="https://raw.githubusercontent.com/datreeio/CRDs-catalog/$CRD_CATALOG_REF/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json"
RELEASE=mscd
NAMESPACE=mscd

OUT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/mscd-helm-validate.XXXXXX")
cleanup() { rm -rf "$OUT_DIR"; }
trap cleanup EXIT

log() { printf '[validate] %s\n' "$*"; }
die() { printf '[validate] ERROR: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker is required"
command -v node >/dev/null 2>&1 || die "node is required (for ci/assert-render.mjs)"
mkdir -p "$CACHE_DIR"

ca_args=()
if [ -n "${MSCD_BUILD_CA:-}" ] && [ -s "$MSCD_BUILD_CA" ]; then
  ca_args=(-v "$(cd "$(dirname "$MSCD_BUILD_CA")" && pwd)/$(basename "$MSCD_BUILD_CA"):/etc/mscd-ca.crt:ro" -e SSL_CERT_FILE=/etc/mscd-ca.crt)
fi

# tool <command...>: runs helm or kubeconform in the check image.
tool() {
  docker run --rm --name "mscd-helm-check-$$-$RANDOM" \
    --network host \
    --user "$(id -u):$(id -g)" \
    -e HOME=/tmp \
    -e HTTPS_PROXY="${HTTPS_PROXY:-${https_proxy:-}}" \
    -e NO_PROXY="${NO_PROXY:-${no_proxy:-}}" \
    "${ca_args[@]}" \
    -v "$CHART_DIR:/chart:ro" \
    -v "$OUT_DIR:/out" \
    -v "$CACHE_DIR:/cache" \
    "$IMAGE" "$@"
}

# name:values-file:assert-flags
renders=(
  "default::"
  "ha:values-ha.yaml:"
  "ci:values-ci.yaml:--secrets-create"
)

log "helm lint"
for entry in "${renders[@]}"; do
  IFS=: read -r name values _ <<<"$entry"
  args=(helm lint --strict /chart --namespace "$NAMESPACE" --kube-version "$KUBE_VERSION")
  [ -n "$values" ] && args+=(-f "/chart/$values")
  tool "${args[@]}" >"$OUT_DIR/lint-$name.log" 2>&1 || { cat "$OUT_DIR/lint-$name.log" >&2; die "helm lint failed for $name"; }
  log "  $name: ok"
done

log "helm template"
for entry in "${renders[@]}"; do
  IFS=: read -r name values _ <<<"$entry"
  args=(helm template "$RELEASE" /chart --namespace "$NAMESPACE" --kube-version "$KUBE_VERSION")
  [ -n "$values" ] && args+=(-f "/chart/$values")
  tool "${args[@]}" >"$OUT_DIR/$name.yaml" 2>"$OUT_DIR/template-$name.log" || { cat "$OUT_DIR/template-$name.log" >&2; die "helm template failed for $name"; }
  log "  $name: $(grep -c '^kind:' "$OUT_DIR/$name.yaml") objects"
done

# Extra renders: cert-manager with a given issuer, and the chart-made certificates without secrets.create.
tool helm template "$RELEASE" /chart --namespace "$NAMESPACE" --kube-version "$KUBE_VERSION" \
  --set certManager.enabled=true --set certManager.issuerRef.name=corp-ca --set certManager.issuerRef.kind=ClusterIssuer \
  >"$OUT_DIR/certmanager.yaml" 2>"$OUT_DIR/template-certmanager.log" || { cat "$OUT_DIR/template-certmanager.log" >&2; die "helm template failed with certManager.issuerRef"; }
grep -q '^kind: Issuer' "$OUT_DIR/certmanager.yaml" && die "an Issuer was rendered although certManager.issuerRef names one"
log "  certmanager (given issuer): $(grep -c '^kind: Certificate' "$OUT_DIR/certmanager.yaml") certificates"

log "renders that must fail"
expect_failure() {
  local what=$1 pattern=$2
  shift 2
  if tool helm template "$RELEASE" /chart --namespace "$NAMESPACE" --kube-version "$KUBE_VERSION" "$@" >"$OUT_DIR/fail.log" 2>&1; then
    die "render succeeded but must fail: $what"
  fi
  grep -q -- "$pattern" "$OUT_DIR/fail.log" || { cat "$OUT_DIR/fail.log" >&2; die "render failed without the expected message ($pattern): $what"; }
  log "  refused: $what"
}
expect_failure "secrets.create without database URLs" "dbAppUrl" \
  --set secrets.create=true --set secrets.values.s3AccessKey=a --set secrets.values.s3SecretKey=b
expect_failure "testServices without secrets.create" "needs secrets.create" --set testServices.enabled=true
expect_failure "no trusted proxy ranges for the api" "trustedProxyCidrs" --set-json 'api.trustedProxyCidrs=[]'
expect_failure "different TLS modes of gateway and clients" "must be equal" --set profile.gateway.tls.mode=off
expect_failure "web TLS without a certificate Secret" "web.tls.secretName" --set web.tls.enabled=true

log "kubeconform (Kubernetes $KUBE_VERSION)"
tool kubeconform -strict -summary -kubernetes-version "$KUBE_VERSION" -cache /cache \
  -schema-location default -schema-location "$CRD_SCHEMAS" \
  /out/default.yaml /out/ha.yaml /out/ci.yaml /out/certmanager.yaml

log "assert-render"
for entry in "${renders[@]}"; do
  IFS=: read -r name _ flags <<<"$entry"
  # shellcheck disable=SC2086 # flags is empty or one word
  node "$CHART_DIR/ci/assert-render.mjs" $flags "$OUT_DIR/$name.yaml"
done
node "$CHART_DIR/ci/assert-render.mjs" "$OUT_DIR/certmanager.yaml"

log "all checks passed"
