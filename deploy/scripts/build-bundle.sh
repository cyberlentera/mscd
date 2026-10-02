#!/usr/bin/env bash
# Builds the MSCD on-premise offline bundle (build plan I.5). Run it on a build
# machine with internet access, from the repository root or anywhere else:
#
#   deploy/scripts/build-bundle.sh --version 1.0.0 \
#     --trusted-keys-dir /secure/release-keys \
#     --pack-signing-key /secure/release-keys/pack-release.key \
#     --sign-key /secure/mscd-release.key
#
# Output in deploy/dist/ (or --output):
#   mscd-onprem-<version>/                 bundle contents
#   mscd-onprem-<version>.tar.gz           the file to deliver
#   mscd-onprem-<version>.tar.gz.sha256    checksum to publish next to it
#   mscd-release.pub                       public key to deliver (with --sign-key)
#   mscd-onprem-<version>.logs/            build logs (not delivered)
#
# The bundle holds the web image, the release server image, PostgreSQL,
# SeaweedFS and Valkey, the Compose files, the Helm chart, the packs, the
# release public keys, the scripts and INSTALL-ONPREM.md. Nothing is downloaded
# at install time. The bundle is checked for development keys, development
# secrets, demo profiles and demo data (check-release-artefacts.sh, R-13)
# before its checksums are written.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "$SCRIPT_DIR/../.." && pwd)
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

# Third-party images of the bundle (build plan A.3), in BUNDLE-INFO order.
readonly EXTRA_IMAGES=(postgres:16.15-alpine chrislusf/seaweedfs:4.48 valkey/valkey:8.1-alpine)
HELM_IMAGE=${HELM_IMAGE:-alpine/k8s:1.34.1}
TRIVY_IMAGE=${TRIVY_IMAGE:-aquasec/trivy:0.74.0}
TRIVY_CACHE=${TRIVY_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/mscd-trivy}
# Release gate for the MSCD images: no HIGH or CRITICAL vulnerability that has a fix.
readonly SCAN_SEVERITY=HIGH,CRITICAL

usage() {
    cat <<'EOF'
Usage: deploy/scripts/build-bundle.sh --trusted-keys-dir DIR --pack-signing-key FILE [options]
       deploy/scripts/build-bundle.sh --release --version 1.0.0 --trusted-keys-dir DIR \
           --pack-signing-key FILE --sign-key FILE

Builds the MSCD on-premise offline bundle: the web image (API mode), the
release server image, the bundled PostgreSQL, SeaweedFS and Valkey images,
the Compose files, the Helm chart, the packs and the install scripts.

Required:
  --trusted-keys-dir DIR    Release public keys compiled into the server: one or more
                            licence-*.pub and pack-*.pub, and anchor-*.pub (Ed25519, PEM).
                            Only the *.pub files of the folder are used.
  --pack-signing-key FILE   Release pack signing key (Ed25519 private key, PEM). Its
                            public key must be one of the pack-*.pub keys.
                            Release keys never come from the repository; a development
                            key stops the build.

Options:
  --version VERSION         Release version (default: "version" in apps/server/package.json)
  --revision REV            Source revision for the image labels (default: git describe)
  --build-ca FILE           CA certificate of a TLS-inspecting proxy, for npm, apk and the
                            scanner (default: $MSCD_BUILD_CA; none when unset)
  --sign-key FILE           Sign SHA256SUMS with this RSA or EC private key (PEM)
  --release                 Build a bundle to deliver: same as --pull --os-updates true
                            --scan gate, needs --sign-key and committed sources
  --os-updates MODE         Alpine updates in the MSCD images: true (required; the build
                            fails when the mirrors cannot be reached), auto (default: applied
                            when the mirrors answer, otherwise a warning) or false
  --no-os-updates           Same as --os-updates false
  --scan MODE               Vulnerability scan with Trivy: gate (stop on a HIGH or CRITICAL
                            vulnerability with a fix in an MSCD image), auto (default: gate
                            when the Alpine updates were applied, otherwise report and mark
                            the bundle as a test build), report (write the report only) or off
  --skip-scan               Same as --scan off (test builds only; never for a release)
  --pull                    Pull the newest base images (node, NGINX) before building; use it
                            for a release (default: use the base images on this machine,
                            pulled when missing)
  --no-build                Package images that already exist locally as
                            <server image>:VERSION and <web image>:VERSION
  --server-image NAME       Server image repository (default: cyberlentera/mscd-server)
  --web-image NAME          Web image repository (default: cyberlentera/mscd-web)
  --output DIR              Output directory (default: deploy/dist)
  -h, --help                Show this help

Environment:
  MSCD_BUILD_CA      Default of --build-ca
  HELM_IMAGE         Helm container used when helm is not installed (default: alpine/k8s:1.34.1)
  TRIVY_IMAGE        Trivy container used when trivy is not installed (default: aquasec/trivy:0.74.0)
  TRIVY_CACHE_DIR    Trivy database cache (default: ~/.cache/mscd-trivy)

An SBOM per image is written to sbom/ when syft is installed.
EOF
}

VERSION='' REVISION='' BUILD=true BUILD_CA=${MSCD_BUILD_CA:-} SIGN_KEY=''
TRUSTED_KEYS_DIR='' PACK_SIGNING_KEY='' OS_UPDATES=auto SCAN=auto PULL=false RELEASE=false
SERVER_REPO=$MSCD_DEFAULT_SERVER_IMAGE WEB_REPO=$MSCD_DEFAULT_IMAGE
OUTPUT_DIR=$REPO_DIR/deploy/dist
WORK=''

need_value() {
    if [[ $# -lt 2 || -z $2 || $2 == --* ]]; then
        die "Option $1 needs a value. See --help"
    fi
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --version) need_value "$@"; VERSION=$2; shift 2 ;;
            --revision) need_value "$@"; REVISION=$2; shift 2 ;;
            --build-ca) need_value "$@"; BUILD_CA=$(absolute_path "$2"); shift 2 ;;
            --sign-key) need_value "$@"; SIGN_KEY=$(absolute_path "$2"); shift 2 ;;
            --trusted-keys-dir) need_value "$@"; TRUSTED_KEYS_DIR=$(absolute_path "$2"); shift 2 ;;
            --pack-signing-key) need_value "$@"; PACK_SIGNING_KEY=$(absolute_path "$2"); shift 2 ;;
            --os-updates) need_value "$@"; OS_UPDATES=$2; shift 2 ;;
            --no-os-updates) OS_UPDATES=false; shift ;;
            --scan) need_value "$@"; SCAN=$2; shift 2 ;;
            --skip-scan) SCAN=off; shift ;;
            --pull) PULL=true; shift ;;
            --no-build) BUILD=false; shift ;;
            --release) RELEASE=true; shift ;;
            --server-image) need_value "$@"; SERVER_REPO=$2; shift 2 ;;
            --web-image) need_value "$@"; WEB_REPO=$2; shift 2 ;;
            --output) need_value "$@"; OUTPUT_DIR=$(absolute_path "$2"); shift 2 ;;
            -h | --help) usage; exit 0 ;;
            *) die "Unknown option: $1. See --help" ;;
        esac
    done
    case "$OS_UPDATES" in true | auto | false) ;; *) die "--os-updates takes true, auto or false" ;; esac
    if [[ $RELEASE == true ]]; then
        [[ $OS_UPDATES != false && $SCAN != report && $SCAN != off ]] ||
            die "--release cannot be combined with --no-os-updates, --scan report or --scan off"
        PULL=true OS_UPDATES=true SCAN=gate
    fi
    case "$SCAN" in auto | gate | report | off) ;; *) die "--scan takes auto, gate, report or off" ;; esac
    if [[ $RELEASE == true && -z $SIGN_KEY ]]; then
        die "--release needs --sign-key (customers check the bundle signature)"
    fi
    [[ -n $TRUSTED_KEYS_DIR ]] || die "--trusted-keys-dir is required (the release public keys; see --help)"
    [[ -n $PACK_SIGNING_KEY ]] || die "--pack-signing-key is required (the release pack signing key; see --help)"
    if [[ -n $BUILD_CA ]]; then BUILD_CA=$(absolute_path "$BUILD_CA"); fi
}

cleanup() {
    if [[ -n $WORK && -d $WORK ]]; then rm -rf -- "$WORK"; fi
}
trap cleanup EXIT

# run_logged LOG COMMAND...: runs the command with its output in LOG. On
# failure, prints the last lines of the log and stops.
run_logged() {
    local log=$1
    shift
    if "$@" >"$log" 2>&1; then
        return 0
    fi
    printf '        Last lines of %s:\n' "$log"
    tail -n 40 "$log" | sed 's/^/          /'
    die "The step failed. The full output is in $log"
}

# helm_run ARGS...: local helm, or helm in the Helm container with the work
# folder and the output folder mounted.
helm_run() {
    if command -v helm >/dev/null 2>&1; then
        helm "$@"
    else
        docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp --entrypoint helm \
            -v "$WORK:$WORK" -v "$STAGE:$STAGE" -w "$WORK" "$HELM_IMAGE" "$@"
    fi
}

# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

# check_release_keys: the trusted keys folder holds release public keys, which
# are copied to a folder of their own (never a private key in a build context).
check_release_keys() {
    local f n=0 licence=0 pack=0 anchor=0
    KEYS_CONTEXT=$WORK/trusted-keys
    install -d -m 0755 "$KEYS_CONTEXT"
    if [[ ! -d $TRUSTED_KEYS_DIR ]]; then
        fail "--trusted-keys-dir $TRUSTED_KEYS_DIR is not a folder" "Pass the folder with the release public keys"
        return 0
    fi
    for f in "$TRUSTED_KEYS_DIR"/*.pub; do
        [[ -f $f ]] || continue
        case "$(basename -- "$f")" in
            licence-*.pub) licence=$((licence + 1)) ;;
            pack-*.pub) pack=$((pack + 1)) ;;
            anchor-*.pub) anchor=$((anchor + 1)) ;;
            *) continue ;;
        esac
        if ! openssl pkey -pubin -in "$f" -noout >/dev/null 2>&1; then
            fail "$f is not a PEM public key" "Use the .pub files written by mscd-pack keygen"
            continue
        fi
        install -m 0644 "$f" "$KEYS_CONTEXT/"
        n=$((n + 1))
    done
    if ((licence == 0 || pack == 0)); then
        fail "$TRUSTED_KEYS_DIR needs at least one licence-*.pub and one pack-*.pub key (found $licence and $pack)" \
            "Generate release keys with: node packages/pack-tools/dist/cli.js keygen --out DIR --name pack-release (and licence-release, anchor-release)"
    else
        pass "Release public keys: $licence licence, $pack pack, $anchor anchor key(s)"
    fi
    if [[ ! -r $PACK_SIGNING_KEY ]] || ! openssl pkey -in "$PACK_SIGNING_KEY" -noout -passin pass: >/dev/null 2>&1; then
        fail "Cannot read the pack signing key $PACK_SIGNING_KEY" "Pass the Ed25519 private key (PEM, no passphrase) to --pack-signing-key"
    else
        local pub match=false
        pub=$(openssl pkey -in "$PACK_SIGNING_KEY" -pubout 2>/dev/null)
        for f in "$KEYS_CONTEXT"/pack-*.pub; do
            [[ -f $f ]] || continue
            if [[ $(openssl pkey -pubin -in "$f" 2>/dev/null) == "$pub" ]]; then match=true; fi
        done
        if [[ $match == true ]]; then
            pass "The pack signing key belongs to one of the pack-*.pub keys"
        else
            fail "The public key of $PACK_SIGNING_KEY is not one of the pack-*.pub keys in $TRUSTED_KEYS_DIR" \
                "Put the matching pack-*.pub next to the other release public keys"
        fi
    fi
    case "$PACK_SIGNING_KEY/" in
        "$REPO_DIR"/*)
            fail "The pack signing key is inside the repository ($PACK_SIGNING_KEY)" \
                "Release keys never come from the repository (R-11). Keep them outside it."
            ;;
    esac
    case "$TRUSTED_KEYS_DIR/" in
        "$REPO_DIR"/*)
            fail "--trusted-keys-dir is inside the repository ($TRUSTED_KEYS_DIR)" \
                "Release keys never come from the repository (R-11). Keep them outside it."
            ;;
    esac
}

# semver_below A B: true when semantic version A is lower than B (a
# pre-release such as 1.0.0-rc.1 is lower than 1.0.0).
semver_below() {
    local a=${1%%-*} b=${2%%-*} i x y
    local -a pa pb
    IFS=. read -r -a pa <<<"$a"
    IFS=. read -r -a pb <<<"$b"
    for i in 0 1 2; do
        x=$((10#${pa[$i]:-0})) y=$((10#${pb[$i]:-0}))
        if ((x != y)); then
            ((x < y))
            return
        fi
    done
    [[ $1 == *-* && $2 != *-* ]]
}

# check_pack_versions: every framework pack names the lowest server version
# that may install it (engine_min_version); a bundle whose server is older
# could not install its own packs.
check_pack_versions() {
    local manifest min id too_new=()
    for manifest in "$REPO_DIR"/packs/sources/*/manifest.json; do
        [[ -f $manifest ]] || continue
        min=$(sed -n 's/.*"engine_min_version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" | head -n1)
        id=$(basename -- "$(dirname -- "$manifest")")
        if [[ -n $min ]] && semver_below "$VERSION" "$min"; then
            too_new+=("$id (needs $min)")
        fi
    done
    if ((${#too_new[@]} > 0)); then
        fail "Version $VERSION is lower than the server version the packs need: ${too_new[*]}" \
            "Use a version that is at least the engine_min_version of every pack in packs/sources"
    else
        pass "Every pack can be installed by server version $VERSION"
    fi
}

check_build_ca() {
    if [[ -z $BUILD_CA ]]; then
        BUILD_CA=$WORK/build-ca.pem
        : >"$BUILD_CA"
        info "No build CA (MSCD_BUILD_CA is not set); npm and apk use the system certificates"
    elif [[ ! -r $BUILD_CA ]]; then
        fail "Cannot read the build CA $BUILD_CA" "Pass a PEM file to --build-ca, or unset MSCD_BUILD_CA"
    elif [[ -s $BUILD_CA ]]; then
        pass "Build CA $BUILD_CA"
    fi
}

check_tools() {
    check_tool docker "builds and saves the images"
    if command -v docker >/dev/null 2>&1 && ! docker buildx version >/dev/null 2>&1; then
        fail "docker buildx is not available (builds the images with secrets)" "Install the Docker Buildx plugin"
    fi
    check_tool openssl "checks the keys and signs the checksums"
    check_tool sha256sum "writes checksums"
    check_tool tar "packs the bundle"
    check_tool gzip "compresses the bundle"
    if [[ -n $SIGN_KEY ]]; then
        if [[ ! -r $SIGN_KEY ]] || ! openssl pkey -in "$SIGN_KEY" -noout -passin pass: >/dev/null 2>&1; then
            fail "Cannot read the signing key $SIGN_KEY" "Pass a PEM private key without a passphrase to --sign-key"
        fi
    fi
}

# ---------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------

# build_image LOG ARGS...: docker buildx build with the shared arguments.
build_image() {
    local log=$1
    shift
    local args=(buildx build --load --progress=plain --provenance=false --sbom=false
        --secret "id=build_ca,src=$BUILD_CA"
        --build-arg "VERSION=$VERSION" --build-arg "REVISION=$REVISION" --build-arg "CREATED=$CREATED"
        --build-arg "APK_UPGRADE=$OS_UPDATES")
    if [[ $PULL == true ]]; then args+=(--pull); fi
    run_logged "$log" docker "${args[@]}" "$@" "$REPO_DIR"
}

# os_updates_result LOG: what happened to the Alpine updates in that build.
os_updates_result() {
    if [[ $OS_UPDATES == false ]]; then
        echo skipped
    elif grep -q 'apk update failed' "$1"; then
        echo not-applied
    else
        echo applied
    fi
}

build_images() {
    local logs=$LOG_DIR
    if [[ $BUILD == false ]]; then
        image_exists "$SERVER_REF" || die "--no-build: image $SERVER_REF does not exist"
        image_exists "$WEB_REF" || die "--no-build: image $WEB_REF does not exist"
        [[ $(docker image inspect --format '{{index .Config.Labels "com.cyberlentera.mscd.flavor"}}' "$SERVER_REF") == release ]] ||
            die "--no-build: $SERVER_REF is not a release build (label com.cyberlentera.mscd.flavor)"
        info "Using the existing images $SERVER_REF and $WEB_REF (--no-build)"
        OS_RESULT_SERVER=unknown OS_RESULT_WEB=unknown
        return 0
    fi

    info "Building $WEB_REF (log: $logs/build-web.log)"
    build_image "$logs/build-web.log" -f "$REPO_DIR/deploy/docker/web.Dockerfile" \
        --build-context "nginx-config=$REPO_DIR/deploy/nginx" \
        --build-arg VITE_DATA_SOURCE=api -t "$WEB_REF"
    OS_RESULT_WEB=$(os_updates_result "$logs/build-web.log")
    pass "Web image $WEB_REF (API mode)"

    info "Building $SERVER_REF, target release (log: $logs/build-server.log)"
    build_image "$logs/build-server.log" -f "$REPO_DIR/deploy/docker/server.Dockerfile" --target release \
        --build-context "trusted-keys=$KEYS_CONTEXT" \
        --secret "id=pack_signing_key,src=$PACK_SIGNING_KEY" -t "$SERVER_REF"
    OS_RESULT_SERVER=$(os_updates_result "$logs/build-server.log")
    pass "Server image $SERVER_REF (release flavour, packs signed with the release key)"

    if [[ $OS_RESULT_WEB == not-applied || $OS_RESULT_SERVER == not-applied ]]; then
        warn "Alpine updates were NOT applied (the mirrors could not be reached); the scan decides whether the base is current enough"
        detail "Build with --os-updates true on a machine that reaches the Alpine mirrors for a release."
    fi
}

# extra_images: the third-party images, pulled when they are not on this machine.
extra_images() {
    local ref
    for ref in "${EXTRA_IMAGES[@]}"; do
        if ! image_exists "$ref"; then
            info "Pulling $ref"
            run_logged "$LOG_DIR/pull-${ref//[\/:]/-}.log" docker pull --platform "linux/$ARCH" "$ref"
        fi
        if [[ $(docker image inspect --format '{{.Architecture}}' "$ref") != "$ARCH" ]]; then
            die "$ref on this machine is not built for $ARCH. Remove it and run again so the $ARCH image is pulled."
        fi
        pass "Image $ref"
    done
}

# image_file REF: file name in images/ for an image reference.
image_file() {
    local name=${1##*/}
    printf 'images/%s-%s.tar.gz' "${name//:/-}" "$ARCH"
}

# save_image REF FILE
save_image() {
    local ref=$1 file=$2
    docker save --platform "linux/$ARCH" "$ref" | gzip -6 >"$STAGE/$file"
    pass "$ref saved to $file ($(du -m "$STAGE/$file" | cut -f1) MB, layers $(image_fingerprint "$ref"))"
}

# export_packs: the signed packs of the release server image (/app/packs).
export_packs() {
    local id count
    id=$(docker create "$SERVER_REF")
    install -d -m 0755 "$STAGE/packs"
    if ! docker cp "$id:/app/packs/." "$STAGE/packs/" >/dev/null; then
        docker rm -f "$id" >/dev/null
        die "Cannot copy /app/packs from $SERVER_REF"
    fi
    docker rm -f "$id" >/dev/null
    find "$STAGE/packs" -type f -exec chmod 0644 {} +
    count=$(find "$STAGE/packs" -type f -name '*.pack' | wc -l)
    ((count > 0)) || die "$SERVER_REF holds no pack in /app/packs"
    pass "$count packs copied to packs/ (signed with the release pack key)"
}

# package_chart: the mscd chart without its CI files (ci/, values-ci.yaml).
package_chart() {
    local chart=$WORK/chart/mscd
    install -d "$WORK/chart"
    cp -R "$REPO_DIR/deploy/helm/mscd" "$chart"
    rm -rf -- "$chart/ci" "$chart/values-ci.yaml"
    install -d -m 0755 "$STAGE/helm"
    run_logged "$LOG_DIR/helm.log" helm_run lint "$chart"
    run_logged "$LOG_DIR/helm.log" helm_run package "$chart" --version "$VERSION" --app-version "$VERSION" \
        --destination "$STAGE/helm"
    install -m 0644 "$REPO_DIR/deploy/helm/mscd/values-ha.yaml" "$STAGE/helm/values-ha.yaml"
    CHART_FILE=helm/mscd-$VERSION.tgz
    [[ -f $STAGE/$CHART_FILE ]] || die "helm package did not write $CHART_FILE"
    pass "Helm chart $CHART_FILE (lint passed) and helm/values-ha.yaml"
}

# ---------------------------------------------------------------------------
# Vulnerability scan and SBOM
# ---------------------------------------------------------------------------

# trivy_command: sets TRIVY (array) and TRIVY_IN (how the image file is named).
trivy_command() {
    if command -v trivy >/dev/null 2>&1; then
        TRIVY=(trivy)
        TRIVY_IN=$STAGE
        return 0
    fi
    mkdir -p "$TRIVY_CACHE"
    TRIVY=(docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp
        -e TRIVY_CACHE_DIR=/cache -v "$TRIVY_CACHE:/cache" -v "$STAGE/images:/scan/images:ro")
    if [[ -n ${HTTPS_PROXY:-${https_proxy:-}} ]]; then
        # The proxy of this machine is reached through the host network.
        TRIVY+=(--network host -e "HTTPS_PROXY=${HTTPS_PROXY:-${https_proxy:-}}" -e "NO_PROXY=${NO_PROXY:-${no_proxy:-}}")
    fi
    if [[ -s $BUILD_CA ]]; then
        # Go reads every file in SSL_CERT_DIR, next to the system bundle.
        TRIVY+=(-v "$BUILD_CA:/etc/mscd-ca/build-ca.pem:ro" -e SSL_CERT_DIR=/etc/ssl/certs:/etc/mscd-ca)
    fi
    TRIVY+=("$TRIVY_IMAGE")
    TRIVY_IN=/scan
}

# scan_images: Trivy on every saved image file. The MSCD images are a release
# gate (unless --scan report); the third-party images are reported only.
scan_images() {
    local template file ref out rc version db_date info gate_failed=false gate=false report=$STAGE/SECURITY-SCAN.txt
    if [[ $SCAN == gate ]]; then
        gate=true
    elif [[ $SCAN == auto ]]; then
        if [[ $OS_RESULT_WEB == not-applied || $OS_RESULT_SERVER == not-applied || $OS_UPDATES == false ]]; then
            warn "The Alpine updates were not applied, so the scan only reports (--scan auto). This bundle is a test build."
        else
            gate=true
        fi
    fi
    template='{{- range . }}{{ .Target }}: {{ len .Vulnerabilities }}
{{ range .Vulnerabilities }}  {{ .VulnerabilityID }} {{ .PkgName }} {{ .InstalledVersion }}, fixed in {{ .FixedVersion }} ({{ .Severity }})
{{ end }}{{ end }}'
    trivy_command
    if ! "${TRIVY[@]}" --version >/dev/null 2>&1; then
        die "Cannot run the scanner ($TRIVY_IMAGE). Install trivy, set TRIVY_IMAGE, or use --skip-scan for a test build."
    fi
    info=$("${TRIVY[@]}" --version 2>/dev/null || true)
    version=$(sed -n 's/^Version: //p' <<<"$info" | head -n1)
    {
        printf 'MSCD %s image security scan\n\n' "$VERSION"
        printf 'Scanned:   %s with Trivy %s\n' "$(date -u +%Y-%m-%d)" "${version:-unknown}"
        printf 'Policy:    no HIGH or CRITICAL vulnerability that has a fix in the MSCD images;\n'
        printf '           the PostgreSQL, SeaweedFS and Valkey images are listed for information\n'
    } >"$report"
    while IFS='|' read -r ref file; do
        rc=0
        out=$("${TRIVY[@]}" image --quiet --scanners vuln --severity "$SCAN_SEVERITY" --ignore-unfixed \
            --exit-code 3 --format template --template "$template" --input "$TRIVY_IN/$file" 2>&1) || rc=$?
        out=${out//\/scan\//}
        case "$rc" in
            0)
                pass "Scan of $ref: no HIGH or CRITICAL vulnerability with a fix"
                printf '\n%s (%s): passed\n' "$ref" "$file" >>"$report"
                ;;
            3)
                printf '\n%s (%s): HIGH or CRITICAL vulnerabilities with a fix\n%s\n' "$ref" "$file" "$out" >>"$report"
                if [[ $ref == "$SERVER_REF" || $ref == "$WEB_REF" ]]; then
                    if [[ $gate == true ]]; then
                        fail "$ref has HIGH or CRITICAL vulnerabilities that have a fix (see SECURITY-SCAN.txt)" \
                            "Rebuild with --os-updates true so the Alpine updates are applied, or move to a newer base image"
                        gate_failed=true
                    else
                        warn "$ref has HIGH or CRITICAL vulnerabilities that have a fix (report only; see SECURITY-SCAN.txt)"
                        SCAN_FINDINGS=true
                    fi
                else
                    warn "$ref has HIGH or CRITICAL vulnerabilities that have a fix (third-party image; listed in SECURITY-SCAN.txt)"
                fi
                ;;
            *)
                printf '%s\n' "$out" | tail -n 5 | sed 's/^/        /'
                die "The scan of $ref could not run. Check access to the vulnerability database (use --build-ca behind a TLS-inspecting proxy)."
                ;;
        esac
    done < <(printf '%s|%s\n' "$WEB_REF" "$WEB_FILE" "$SERVER_REF" "$SERVER_FILE" \
        "${EXTRA_IMAGES[0]}" "${EXTRA_FILES[0]}" "${EXTRA_IMAGES[1]}" "${EXTRA_FILES[1]}" \
        "${EXTRA_IMAGES[2]}" "${EXTRA_FILES[2]}")
    db_date=$("${TRIVY[@]}" --version 2>/dev/null | sed -n 's/^ *UpdatedAt: \([0-9-]*\).*/\1/p' | head -n1 || true)
    printf '\nVulnerability database of %s\n' "${db_date:-unknown}" >>"$report"
    if [[ $gate_failed == true ]]; then
        die "The bundle was not packed: an MSCD image has HIGH or CRITICAL vulnerabilities that have a fix (see $report)."
    fi
    if [[ $gate == true ]]; then
        SCAN_RESULT="passed $(date -u +%Y-%m-%d), see SECURITY-SCAN.txt"
    elif [[ $SCAN_FINDINGS == true ]]; then
        SCAN_RESULT="report only $(date -u +%Y-%m-%d), MSCD images have findings, see SECURITY-SCAN.txt"
    else
        SCAN_RESULT="report only $(date -u +%Y-%m-%d), no finding in the MSCD images, see SECURITY-SCAN.txt"
    fi
}

write_sboms() {
    local ref file name
    if ! command -v syft >/dev/null 2>&1; then
        warn "syft is not installed; no SBOM written (install syft to add sbom/*.spdx.json)"
        return 0
    fi
    install -d -m 0755 "$STAGE/sbom"
    while IFS='|' read -r ref file; do
        name=$(basename -- "$file" .tar.gz)
        run_logged "$LOG_DIR/sbom-$name.log" syft scan "docker-archive:$STAGE/$file" -o "spdx-json=$STAGE/sbom/$name.spdx.json"
        pass "SBOM sbom/$name.spdx.json"
    done < <(printf '%s|%s\n' "$WEB_REF" "$WEB_FILE" "$SERVER_REF" "$SERVER_FILE" \
        "${EXTRA_IMAGES[0]}" "${EXTRA_FILES[0]}" "${EXTRA_IMAGES[1]}" "${EXTRA_FILES[1]}" \
        "${EXTRA_IMAGES[2]}" "${EXTRA_FILES[2]}")
}

# ---------------------------------------------------------------------------
# Bundle
# ---------------------------------------------------------------------------
copy_files() {
    install -d -m 0755 "$STAGE/lib" "$STAGE/compose" "$STAGE/images" "$STAGE/keys"
    install -m 0755 "$SCRIPT_DIR/install.sh" "$SCRIPT_DIR/upgrade.sh" "$SCRIPT_DIR/uninstall.sh" "$STAGE/"
    install -m 0644 "$SCRIPT_DIR/lib/common.sh" "$STAGE/lib/"
    install -m 0644 "$REPO_DIR/deploy/compose/docker-compose.yml" "$STAGE/compose/"
    sed -e "s|^MSCD_VERSION=.*|MSCD_VERSION=$VERSION|" \
        -e "s|^MSCD_IMAGE=.*|MSCD_IMAGE=$WEB_REPO|" \
        -e "s|^MSCD_SERVER_IMAGE=.*|MSCD_SERVER_IMAGE=$SERVER_REPO|" \
        "$REPO_DIR/deploy/compose/.env.example" >"$STAGE/compose/.env.example"
    chmod 0644 "$STAGE/compose/.env.example"
    # The configuration folders of Compose, without the development secrets.
    install_config "$REPO_DIR/deploy/compose/config" "$STAGE/compose/config"
    [[ ! -e $STAGE/compose/config/demo-secrets ]] || die "compose/config/demo-secrets must not be in the bundle"
    install -m 0644 "$KEYS_CONTEXT"/*.pub "$STAGE/keys/"
    install -m 0644 "$REPO_DIR/docs/INSTALL-ONPREM.md" "$STAGE/INSTALL-ONPREM.md"
    printf '%s\n' "$VERSION" >"$STAGE/VERSION"
    pass "Scripts, Compose files, configuration, release public keys and INSTALL-ONPREM.md"
}

write_bundle_info() {
    local i
    {
        printf 'VERSION=%s\n' "$VERSION"
        printf 'IMAGE=%s\nIMAGE_FILE=%s\nIMAGE_ARCH=%s\nIMAGE_LAYERS=%s\n' \
            "$WEB_REPO" "$WEB_FILE" "$ARCH" "$(image_fingerprint "$WEB_REF")"
        printf 'SERVER_IMAGE=%s\nSERVER_IMAGE_FILE=%s\nSERVER_IMAGE_LAYERS=%s\n' \
            "$SERVER_REPO" "$SERVER_FILE" "$(image_fingerprint "$SERVER_REF")"
        for i in "${!EXTRA_IMAGES[@]}"; do
            printf 'EXTRA_IMAGE_%s=%s %s %s\n' "$((i + 1))" "${EXTRA_IMAGES[$i]}" "${EXTRA_FILES[$i]}" \
                "$(image_fingerprint "${EXTRA_IMAGES[$i]}")"
        done
        printf 'CHART_FILE=%s\n' "$CHART_FILE"
        printf 'REVISION=%s\nCREATED=%s\n' "$REVISION" "$CREATED"
        printf 'OS_UPDATES=%s (web %s, server %s)\n' "$OS_UPDATES" "$OS_RESULT_WEB" "$OS_RESULT_SERVER"
        printf 'SECURITY_SCAN=%s\n' "$SCAN_RESULT"
        printf 'RELEASE_BUILD=%s\n' "$RELEASE"
    } >"$STAGE/BUNDLE-INFO"
    pass "BUNDLE-INFO written"
}

write_checksums() {
    local sums
    sums=$(cd "$STAGE" && find . -type f ! -name SHA256SUMS ! -name SHA256SUMS.sig -printf '%P\n' |
        LC_ALL=C sort | xargs -d '\n' sha256sum)
    printf '%s\n' "$sums" >"$STAGE/SHA256SUMS"
    pass "SHA256SUMS written for $(wc -l <"$STAGE/SHA256SUMS") files"
    if [[ -n $SIGN_KEY ]]; then
        openssl dgst -sha256 -sign "$SIGN_KEY" -out "$STAGE/SHA256SUMS.sig" "$STAGE/SHA256SUMS"
        openssl pkey -in "$SIGN_KEY" -pubout -out "$OUTPUT_DIR/$MSCD_PUBLIC_KEY"
        openssl dgst -sha256 -verify "$OUTPUT_DIR/$MSCD_PUBLIC_KEY" -signature "$STAGE/SHA256SUMS.sig" \
            "$STAGE/SHA256SUMS" >/dev/null || die "The new signature does not verify with $OUTPUT_DIR/$MSCD_PUBLIC_KEY"
        pass "SHA256SUMS signed (SHA256SUMS.sig) and checked with $OUTPUT_DIR/$MSCD_PUBLIC_KEY"
    fi
}

main() {
    parse_args "$@"

    if [[ -z $VERSION ]]; then
        VERSION=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO_DIR/apps/server/package.json" | head -n1)
    fi
    [[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] ||
        die "Version '$VERSION' is not a semantic version such as 1.0.0 or 1.1.0-rc.1"
    if [[ -z $REVISION ]]; then
        REVISION=$(git -C "$REPO_DIR" describe --always --dirty 2>/dev/null || echo unknown)
        # describe --dirty ignores untracked files; the release sources must count too.
        if [[ $REVISION != unknown && $REVISION != *-dirty ]] &&
            [[ -n $(git -C "$REPO_DIR" status --porcelain -- apps packages packs tools package.json package-lock.json deploy docs 2>/dev/null) ]]; then
            REVISION+=-dirty
        fi
    fi
    [[ $REVISION =~ ^[0-9A-Za-z._-]{1,64}$ ]] || die "Revision '$REVISION' may hold only letters, digits, '.', '_' and '-'"
    CREATED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    SERVER_REF=$SERVER_REPO:$VERSION
    WEB_REF=$WEB_REPO:$VERSION
    local name=mscd-onprem-$VERSION
    STAGE=$OUTPUT_DIR/$name
    LOG_DIR=$OUTPUT_DIR/$name.logs
    local tarball=$OUTPUT_DIR/$name.tar.gz
    install -d -m 0755 "$OUTPUT_DIR"
    WORK=$(mktemp -d "$OUTPUT_DIR/.build-$VERSION.XXXXXX")

    title "Building the MSCD on-premise bundle $VERSION"

    step "Checking tools and inputs"
    check_tools
    abort_if_failed
    check_build_ca
    check_release_keys
    check_pack_versions
    if [[ $REVISION == *-dirty ]]; then
        if [[ $RELEASE == true ]]; then
            fail "The sources have uncommitted or untracked files ($REVISION)" "Commit the sources before building a release"
        else
            warn "The sources have uncommitted or untracked files; the images are labelled $REVISION"
            detail "Commit the sources before building a release."
        fi
    fi
    if [[ $RELEASE == false ]]; then
        info "Test build: add --release for a bundle to deliver (newest base images, Alpine updates required, scan gate, signature)"
    fi
    if [[ $SCAN == off ]]; then
        warn "--scan off: the images are not scanned. Do not deliver this bundle to customers."
    fi
    abort_if_failed
    rm -rf -- "$STAGE" "$LOG_DIR" "$tarball" "$tarball.sha256"
    install -d -m 0755 "$STAGE" "$LOG_DIR"

    step "Building the MSCD images"
    OS_RESULT_WEB=skipped OS_RESULT_SERVER=skipped
    build_images
    ARCH=$(docker image inspect --format '{{.Architecture}}' "$SERVER_REF")
    [[ $(docker image inspect --format '{{.Architecture}}' "$WEB_REF") == "$ARCH" ]] ||
        die "$WEB_REF and $SERVER_REF are built for different architectures"

    step "Third-party images"
    extra_images

    step "Assembling $STAGE"
    copy_files
    export_packs
    package_chart

    step "Saving the images"
    WEB_FILE=$(image_file "$WEB_REF")
    SERVER_FILE=$(image_file "$SERVER_REF")
    save_image "$WEB_REF" "$WEB_FILE"
    save_image "$SERVER_REF" "$SERVER_FILE"
    EXTRA_FILES=()
    local ref file
    for ref in "${EXTRA_IMAGES[@]}"; do
        file=$(image_file "$ref")
        EXTRA_FILES+=("$file")
        save_image "$ref" "$file"
    done

    step "Scanning the images"
    SCAN_FINDINGS=false
    if [[ $SCAN == off ]]; then
        warn "Scan skipped (--scan off)"
        SCAN_RESULT=skipped
    else
        scan_images
    fi
    write_sboms
    write_bundle_info

    step "Checking for development keys, secrets and demo data (R-13)"
    if ! bash "$SCRIPT_DIR/check-release-artefacts.sh" "$STAGE" 2>&1 | tee "$LOG_DIR/release-check.log"; then
        die "The bundle contains development keys, development secrets or demo data (see above). It was not packed."
    fi

    step "Checksums"
    write_checksums

    step "Packing"
    tar --sort=name --owner=0 --group=0 --numeric-owner -C "$OUTPUT_DIR" -cf - "$name" | gzip -n -6 >"$tarball"
    (cd "$OUTPUT_DIR" && sha256sum "$name.tar.gz" >"$name.tar.gz.sha256")
    pass "$tarball ($(du -m "$tarball" | cut -f1) MB)"
    pass "$tarball.sha256"

    if [[ -n $SIGN_KEY ]]; then
        printf '\n%sBundle ready.%s Deliver these three files:\n  %s\n  %s\n  %s\n' "$C_GREEN$C_BOLD" "$C_RESET" \
            "$tarball" "$tarball.sha256" "$OUTPUT_DIR/$MSCD_PUBLIC_KEY"
        printf 'Publish the public key fingerprint through a second channel (for example your support portal):\n  %s\n' \
            "$(openssl pkey -pubin -in "$OUTPUT_DIR/$MSCD_PUBLIC_KEY" -outform DER 2>/dev/null | sha256sum | cut -d' ' -f1)"
    else
        printf '\n%sBundle ready (unsigned).%s Deliver both files:\n  %s\n  %s\n' "$C_GREEN$C_BOLD" "$C_RESET" \
            "$tarball" "$tarball.sha256"
    fi
}

main "$@"
