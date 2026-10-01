#!/usr/bin/env bash
# Builds the MSCD on-premise offline bundle (run on a build machine with internet access).
#
#   deploy/scripts/build-bundle.sh [--version 1.0.0]
#
# Output in deploy/dist/:
#   mscd-onprem-<version>/                 bundle contents
#   mscd-onprem-<version>.tar.gz           the file to deliver
#   mscd-onprem-<version>.tar.gz.sha256    checksum to publish next to it
#   mscd-release.pub                       public key to deliver (with --sign-key)
#
# The image is scanned for known vulnerabilities before the bundle is signed.
# The bundle needs nothing from the internet at install time.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "$SCRIPT_DIR/../.." && pwd)
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

HELM_IMAGE=${HELM_IMAGE:-alpine/helm:3}
TRIVY_IMAGE=${TRIVY_IMAGE:-aquasec/trivy:0.74.0}
TRIVY_CACHE=${TRIVY_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/mscd-trivy}
# Release gate: no HIGH or CRITICAL vulnerability that has a fix may ship.
readonly SCAN_SEVERITY=HIGH,CRITICAL

usage() {
    cat <<'EOF'
Usage: deploy/scripts/build-bundle.sh [options]

Options:
  --version VERSION   Release version (default: "version" in app/package.json)
  --revision REV      Source revision for the image label (default: git describe)
  --image NAME        Image repository (default: cyberlentera/mscd-web)
  --no-build          Package an image that already exists locally as NAME:VERSION
  --no-os-updates     Do not run "apk upgrade" in the image (build machines that
                      cannot reach the Alpine mirrors); the scan still runs
  --build-ca FILE     Extra CA certificate for npm, apk and the scanner
                      (build machines behind a TLS-inspecting proxy)
  --sign-key FILE     Sign SHA256SUMS with this RSA or EC private key (PEM)
  --skip-scan         Do not scan the image (test builds only; never for a release)
  --output DIR        Output directory (default: deploy/dist)
  -h, --help          Show this help

The image is scanned with Trivy before the bundle is signed. The build stops
when it finds a HIGH or CRITICAL vulnerability that has a fix.

Environment:
  HELM_IMAGE          Helm container used when helm is not installed (default: alpine/helm:3)
  TRIVY_IMAGE         Trivy container used when trivy is not installed (default: aquasec/trivy:0.74.0)
  TRIVY_CACHE_DIR     Trivy database cache (default: ~/.cache/mscd-trivy)
EOF
}

VERSION='' REVISION='' IMAGE_REPO=$MSCD_DEFAULT_IMAGE BUILD=true BUILD_CA='' SIGN_KEY=''
OS_UPDATES=true SCAN=true
OUTPUT_DIR=$REPO_DIR/deploy/dist

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --version) VERSION=${2:?--version needs a value}; shift 2 ;;
            --revision) REVISION=${2:?--revision needs a value}; shift 2 ;;
            --image) IMAGE_REPO=${2:?--image needs a value}; shift 2 ;;
            --no-build) BUILD=false; shift ;;
            --no-os-updates) OS_UPDATES=false; shift ;;
            --skip-scan) SCAN=false; shift ;;
            --build-ca) BUILD_CA=$(absolute_path "${2:?--build-ca needs a value}"); shift 2 ;;
            --sign-key) SIGN_KEY=$(absolute_path "${2:?--sign-key needs a value}"); shift 2 ;;
            --output) OUTPUT_DIR=$(absolute_path "${2:?--output needs a value}"); shift 2 ;;
            -h | --help) usage; exit 0 ;;
            *) die "Unknown option: $1. See --help" ;;
        esac
    done
}

# helm_run ARGS...: local helm, or the Helm container with the repo mounted.
helm_run() {
    if command -v helm >/dev/null 2>&1; then
        helm "$@"
    else
        docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
            -v "$REPO_DIR:$REPO_DIR:ro" -v "$OUTPUT_DIR:$OUTPUT_DIR" -w "$REPO_DIR" "$HELM_IMAGE" "$@"
    fi
}

build_image() {
    local args=(
        buildx build --load --pull
        --provenance=false --sbom=false
        -f "$REPO_DIR/app/Dockerfile"
        --build-context "nginx-config=$REPO_DIR/deploy/nginx"
        --build-arg "VERSION=$VERSION"
        --build-arg "REVISION=$REVISION"
        --build-arg "CREATED=$CREATED"
        --build-arg "APK_UPGRADE=$OS_UPDATES"
        -t "$IMAGE_REF"
    )
    if [[ -n $BUILD_CA ]]; then
        [[ -r $BUILD_CA ]] || die "Cannot read --build-ca file $BUILD_CA"
        args+=(--secret "id=build_ca,src=$BUILD_CA")
    fi
    docker "${args[@]}" "$REPO_DIR/app"
}

# scan_image TARBALL REPORT: Trivy scan of the saved image, the exact file that
# ships. Writes a plain-text report and fails on fixable HIGH/CRITICAL findings.
scan_image() {
    local tarball=$1 report=$2 dir file out rc=0 trivy=() info version db_date
    local template='{{- range . }}{{ .Target }}: {{ len .Vulnerabilities }}
{{ range .Vulnerabilities }}  {{ .VulnerabilityID }} {{ .PkgName }} {{ .InstalledVersion }}, fixed in {{ .FixedVersion }} ({{ .Severity }})
{{ end }}{{ end }}'
    local scan_args=(image --quiet --scanners vuln --severity "$SCAN_SEVERITY" --ignore-unfixed
        --exit-code 3 --format template --template "$template")
    dir=$(dirname -- "$tarball")
    file=$(basename -- "$tarball")
    if command -v trivy >/dev/null 2>&1; then
        trivy=(trivy)
        scan_args+=(--input "$tarball")
    else
        mkdir -p "$TRIVY_CACHE"
        trivy=(docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp
            -e TRIVY_CACHE_DIR=/cache -v "$TRIVY_CACHE:/cache" -v "$dir:/scan:ro")
        if [[ -n $BUILD_CA ]]; then
            # Go reads every file in SSL_CERT_DIR, next to the system bundle.
            trivy+=(-v "$BUILD_CA:/etc/mscd-ca/build-ca.pem:ro" -e SSL_CERT_DIR=/etc/ssl/certs:/etc/mscd-ca)
        fi
        trivy+=("$TRIVY_IMAGE")
        scan_args+=(--input "/scan/$file")
        "${trivy[@]}" --version >/dev/null 2>&1 ||
            die "Cannot run the scanner image $TRIVY_IMAGE. Install trivy, set TRIVY_IMAGE, or use --skip-scan for a test build."
    fi
    out=$("${trivy[@]}" "${scan_args[@]}" 2>&1) || rc=$?
    out=${out//\/scan\//}
    case "$rc" in
        0)
            info=$("${trivy[@]}" --version 2>/dev/null || true)
            version=$(sed -n 's/^Version: //p' <<<"$info" | head -n1)
            db_date=$(sed -n 's/^ *UpdatedAt: \([0-9-]*\).*/\1/p' <<<"$info" | head -n1)
            {
                printf 'MSCD %s image security scan\n\n' "$VERSION"
                printf 'Image:     %s (%s)\n' "$IMAGE_REF" "$file"
                printf 'Scanned:   %s with Trivy %s, vulnerability database of %s\n' \
                    "$(date -u +%Y-%m-%d)" "${version:-unknown}" "${db_date:-unknown}"
                printf 'Policy:    no HIGH or CRITICAL vulnerability that has a fix\n\n'
                printf 'Findings that break the policy, per scanned target:\n%s\n' "$out"
            } >"$report"
            pass "Security scan: no HIGH or CRITICAL vulnerability with a fix (Trivy ${version:-unknown})"
            ;;
        3)
            printf '%s\n' "$out" | sed 's/^/        /'
            fail "The image has HIGH or CRITICAL vulnerabilities that have a fix" \
                "Rebuild so the latest base image and Alpine updates are used, or move NGINX_IMAGE in app/Dockerfile to a newer tag"
            abort_if_failed
            ;;
        *)
            printf '%s\n' "$out" | tail -n 5 | sed 's/^/        /'
            die "The security scan could not run. Check access to the vulnerability database (use --build-ca behind a TLS-inspecting proxy)."
            ;;
    esac
}

main() {
    parse_args "$@"

    if [[ -z $VERSION ]]; then
        VERSION=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO_DIR/app/package.json" | head -n1)
    fi
    [[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]] ||
        die "Version '$VERSION' is not a semantic version such as 1.0.0"
    if [[ -z $REVISION ]]; then
        REVISION=$(git -C "$REPO_DIR" describe --always --dirty 2>/dev/null || echo unknown)
        # describe --dirty ignores untracked files; the release sources must count too.
        if [[ $REVISION != unknown && $REVISION != *-dirty ]] &&
            [[ -n $(git -C "$REPO_DIR" status --porcelain -- app deploy docs 2>/dev/null) ]]; then
            REVISION+=-dirty
        fi
    fi
    CREATED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    IMAGE_REF=$IMAGE_REPO:$VERSION
    local name=mscd-onprem-$VERSION
    local stage=$OUTPUT_DIR/$name
    local tarball=$OUTPUT_DIR/$name.tar.gz

    title "Building the MSCD on-premise bundle $VERSION"

    step "Checking tools"
    check_tool docker "builds and saves the image"
    check_tool sha256sum "writes checksums"
    check_tool tar "packs the bundle"
    check_tool gzip "compresses the bundle"
    if [[ -n $SIGN_KEY ]]; then
        check_tool openssl "signs the checksums"
        if [[ ! -r $SIGN_KEY ]] || ! openssl pkey -in "$SIGN_KEY" -noout -passin pass: >/dev/null 2>&1; then
            fail "Cannot read the signing key $SIGN_KEY" "Pass a PEM private key without a passphrase to --sign-key"
        fi
    fi
    if [[ $REVISION == *-dirty ]]; then
        warn "app/, deploy/ or docs/ have uncommitted or untracked files; the image label says $REVISION"
        detail "Commit the sources before building a release."
    fi
    if [[ $SCAN == false ]]; then
        warn "--skip-scan: the image will not be scanned. Do not deliver this bundle to customers."
    fi
    if [[ $OS_UPDATES == false ]]; then
        warn "--no-os-updates: Alpine updates are not applied; the scan decides whether the base is current enough"
    fi
    abort_if_failed

    step "Building the image $IMAGE_REF"
    if [[ $BUILD == true ]]; then
        build_image
    else
        docker image inspect "$IMAGE_REF" >/dev/null 2>&1 || die "--no-build: image $IMAGE_REF does not exist"
        info "Using the existing image $IMAGE_REF (--no-build)"
    fi
    local arch layers size_mb
    arch=$(docker image inspect --format '{{.Architecture}}' "$IMAGE_REF")
    layers=$(image_fingerprint "$IMAGE_REF")
    size_mb=$(($(docker image inspect --format '{{.Size}}' "$IMAGE_REF") / 1024 / 1024))
    pass "Image $IMAGE_REF ($arch, $size_mb MB, layers $layers)"

    step "Assembling $stage"
    rm -rf -- "$stage" "$tarball" "$tarball.sha256"
    install -d "$stage/lib" "$stage/compose" "$stage/nginx" "$stage/helm" "$stage/images"
    install -m 0755 "$SCRIPT_DIR/install.sh" "$SCRIPT_DIR/upgrade.sh" "$SCRIPT_DIR/uninstall.sh" "$stage/"
    install -m 0644 "$SCRIPT_DIR/lib/common.sh" "$stage/lib/"
    install -m 0644 "$REPO_DIR/deploy/compose/docker-compose.yml" "$stage/compose/"
    sed -e "s|^MSCD_VERSION=.*|MSCD_VERSION=$VERSION|" -e "s|^MSCD_IMAGE=.*|MSCD_IMAGE=$IMAGE_REPO|" \
        "$REPO_DIR/deploy/compose/.env.example" >"$stage/compose/.env.example"
    install -m 0644 "$REPO_DIR"/deploy/nginx/* "$stage/nginx/"
    install -m 0644 "$REPO_DIR/docs/INSTALL-ONPREM.md" "$stage/INSTALL-ONPREM.md"
    printf '%s\n' "$VERSION" >"$stage/VERSION"
    pass "Scripts, Compose files, NGINX configuration and guide"

    helm_run lint "$REPO_DIR/deploy/helm/mscd-web" >/dev/null
    helm_run package "$REPO_DIR/deploy/helm/mscd-web" --version "$VERSION" --app-version "$VERSION" \
        --destination "$stage/helm" >/dev/null
    install -m 0644 "$REPO_DIR/deploy/helm/mscd-web/values-ha.yaml" "$stage/helm/values-ha.yaml"
    pass "Helm chart helm/mscd-web-$VERSION.tgz (lint passed)"

    local image_file=images/mscd-web-$VERSION-$arch.tar.gz scan_result
    docker save "$IMAGE_REF" | gzip -6 >"$stage/$image_file"
    pass "Image saved to $image_file ($(du -m "$stage/$image_file" | cut -f1) MB)"

    step "Scanning the image"
    if [[ $SCAN == true ]]; then
        scan_image "$stage/$image_file" "$stage/SECURITY-SCAN.txt"
        scan_result="passed $(date -u +%Y-%m-%d), see SECURITY-SCAN.txt"
    else
        warn "Scan skipped (--skip-scan)"
        scan_result=skipped
    fi

    cat >"$stage/BUNDLE-INFO" <<EOF
VERSION=$VERSION
IMAGE=$IMAGE_REPO
IMAGE_FILE=$image_file
IMAGE_ARCH=$arch
IMAGE_LAYERS=$layers
CHART_FILE=helm/mscd-web-$VERSION.tgz
REVISION=$REVISION
CREATED=$CREATED
OS_UPDATES=$OS_UPDATES
SECURITY_SCAN=$scan_result
EOF

    local sums
    sums=$(cd "$stage" && find . -type f -printf '%P\n' | LC_ALL=C sort | xargs -d '\n' sha256sum)
    printf '%s\n' "$sums" >"$stage/SHA256SUMS"
    pass "SHA256SUMS written for $(wc -l <"$stage/SHA256SUMS") files"
    if [[ -n $SIGN_KEY ]]; then
        openssl dgst -sha256 -sign "$SIGN_KEY" -out "$stage/SHA256SUMS.sig" "$stage/SHA256SUMS"
        openssl pkey -in "$SIGN_KEY" -pubout -out "$OUTPUT_DIR/mscd-release.pub"
        openssl dgst -sha256 -verify "$OUTPUT_DIR/mscd-release.pub" -signature "$stage/SHA256SUMS.sig" \
            "$stage/SHA256SUMS" >/dev/null || die "The new signature does not verify with $OUTPUT_DIR/mscd-release.pub"
        pass "SHA256SUMS signed (SHA256SUMS.sig) and checked with $OUTPUT_DIR/mscd-release.pub"
    fi

    step "Packing"
    tar --sort=name --owner=0 --group=0 --numeric-owner -C "$OUTPUT_DIR" -cf - "$name" | gzip -n -6 >"$tarball"
    (cd "$OUTPUT_DIR" && sha256sum "$name.tar.gz" >"$name.tar.gz.sha256")
    pass "$tarball ($(du -m "$tarball" | cut -f1) MB)"
    pass "$tarball.sha256"

    if [[ -n $SIGN_KEY ]]; then
        printf '\n%sBundle ready.%s Deliver these three files:\n  %s\n  %s\n  %s\n' "$C_GREEN$C_BOLD" "$C_RESET" \
            "$tarball" "$tarball.sha256" "$OUTPUT_DIR/mscd-release.pub"
        printf 'Publish the public key fingerprint through a second channel (for example your support portal):\n  %s\n' \
            "$(openssl pkey -pubin -in "$OUTPUT_DIR/mscd-release.pub" -outform DER 2>/dev/null | sha256sum | cut -d' ' -f1)"
    else
        printf '\n%sBundle ready (unsigned).%s Deliver both files:\n  %s\n  %s\n' "$C_GREEN$C_BOLD" "$C_RESET" \
            "$tarball" "$tarball.sha256"
    fi
}

main "$@"
