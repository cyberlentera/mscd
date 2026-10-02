#!/usr/bin/env bash
# Release artefact check (build plan R-11, R-13).
#
#   deploy/scripts/check-release-artefacts.sh <bundle dir | archive | image>...
#
# Fails (exit 1) when any file of the given release artefacts contains:
#   - a development key id listed in packages/pack-tools/dev-keys/dev-key-ids.json;
#   - a file whose SHA-256 equals that of a file in one of the development secret
#     folders of R-11 (hashed when this check runs, so no list of development
#     secrets is kept anywhere);
#   - a demo.yaml or test.yaml server profile;
#   - the demo seed data (apps/server/src/seed/demo, sample-snapshot.json).
#
# Arguments:
#   a directory      every file in it (an extracted bundle, for example)
#   an archive       .tar, .tar.gz, .tgz or .pack file
#   an image         a local Docker image such as cyberlentera/mscd-server:1.0.0,
#                    read with docker save
# Archives found inside (images/*.tar.gz of a bundle, every image layer, the
# Helm chart, the packs) are opened and checked as well.
#
# Exit codes: 0 clean, 1 something forbidden was found, 2 usage or tool error.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "$SCRIPT_DIR/../.." && pwd)

# Development secret folders of R-11, relative to the repository root.
readonly DEV_SECRET_DIRS=(
    packages/pack-tools/dev-keys
    apps/server/test/fixtures/secrets
    deploy/compose/config/demo-secrets
    deploy/compose/dev
)
readonly DEV_KEY_IDS_FILE=packages/pack-tools/dev-keys/dev-key-ids.json
readonly SEED_DIR=apps/server/src/seed/demo
# Archives inside archives are opened up to this depth (bundle > image > layer > pack).
readonly MAX_DEPTH=4

if [[ -t 1 && -z ${NO_COLOR:-} ]]; then
    C_RED=$'\033[31m' C_GREEN=$'\033[32m' C_BOLD=$'\033[1m' C_RESET=$'\033[0m'
else
    C_RED='' C_GREEN='' C_BOLD='' C_RESET=''
fi

usage() {
    cat <<'EOF'
Usage: deploy/scripts/check-release-artefacts.sh <bundle dir | archive | image>...

Checks release artefacts for development keys, development secrets, the demo
and test profiles and the demo seed data (build plan R-13). Archives inside the
artefacts (image files, image layers, the Helm chart, packs) are checked too.

Exit codes: 0 clean, 1 something forbidden was found, 2 usage or tool error.
EOF
}

die() {
    printf '%sERROR%s %s\n' "$C_RED" "$C_RESET" "$*" >&2
    exit 2
}

WORK=''
cleanup() {
    if [[ -n $WORK && -d $WORK ]]; then
        chmod -R u+rwX "$WORK" 2>/dev/null || true
        rm -rf -- "$WORK"
    fi
}
trap cleanup EXIT

FINDINGS=0
# finding LABEL REASON
finding() {
    FINDINGS=$((FINDINGS + 1))
    printf '  %sFOUND%s %s\n        %s\n' "$C_RED" "$C_RESET" "$1" "$2"
}

# ---------------------------------------------------------------------------
# Reference data, read from the repository when the check runs
# ---------------------------------------------------------------------------
KEY_IDS_FILE='' HASHES_FILE='' SIZES=''

load_reference() {
    local ids dir file size hash count=0
    [[ -f $REPO_DIR/$DEV_KEY_IDS_FILE ]] || die "Cannot find $DEV_KEY_IDS_FILE; run this script from the MSCD repository"
    KEY_IDS_FILE=$WORK/dev-key-ids.txt
    ids=$(grep -o '"[0-9a-f]\{16\}"' "$REPO_DIR/$DEV_KEY_IDS_FILE" | tr -d '"' || true)
    [[ -n $ids ]] || die "$DEV_KEY_IDS_FILE lists no key id"
    printf '%s\n' "$ids" >"$KEY_IDS_FILE"

    # sha256 of every non-empty file of the development secret folders and of
    # the demo seed data. An empty file matches nothing on purpose.
    HASHES_FILE=$WORK/dev-hashes.txt
    : >"$HASHES_FILE"
    for dir in "${DEV_SECRET_DIRS[@]}" "$SEED_DIR"; do
        [[ -d $REPO_DIR/$dir ]] || die "Cannot find the folder $dir in $REPO_DIR"
        while IFS= read -r -d '' file; do
            size=$(stat -c %s "$file")
            hash=$(sha256sum "$file" | cut -d' ' -f1)
            printf '%s %s %s\n' "$hash" "$size" "${file#"$REPO_DIR"/}" >>"$HASHES_FILE"
            count=$((count + 1))
        done < <(find "$REPO_DIR/$dir" -type f -size +0 -print0)
    done
    # Sizes to look at: only files of exactly these sizes need a hash.
    SIZES=$(cut -d' ' -f2 "$HASHES_FILE" | sort -un | paste -sd ' ' -)
    printf '  Reference: %s development key ids, %s files of the development secret folders and the seed data\n' \
        "$(wc -l <"$KEY_IDS_FILE")" "$count"
}

# ---------------------------------------------------------------------------
# Checks of one extracted tree
# ---------------------------------------------------------------------------

# check_tree DIR LABEL: every check on the files below DIR. LABEL names DIR in
# the report (for example "images/mscd-server.tar.gz > layer 3f2a...").
check_tree() {
    local dir=$1 label=$2 file rel hash size id matches
    # 1. Development key ids anywhere in a file (text or binary).
    while IFS= read -r file; do
        [[ -n $file ]] || continue
        rel=${file#"$dir"/}
        matches=$(grep -aoF -f "$KEY_IDS_FILE" -- "$file" 2>/dev/null | sort -u | paste -sd ' ' - || true)
        finding "$label: $rel" "contains the development key id ${matches:-?}"
    done < <(grep -rlaF -f "$KEY_IDS_FILE" -- "$dir" 2>/dev/null || true)

    # 2. Files identical to a development secret or seed file. Only files with
    #    one of the reference sizes are hashed.
    if [[ -n $SIZES ]]; then
        while IFS=' ' read -r size file; do
            [[ -n $file ]] || continue
            hash=$(sha256sum -- "$file" | cut -d' ' -f1)
            id=$(awk -v h="$hash" -v s="$size" '$1 == h && $2 == s { print $3 }' "$HASHES_FILE" | paste -sd ',' - | sed 's/,/, /g')
            if [[ -n $id ]]; then
                finding "$label: ${file#"$dir"/}" "is identical to the development file(s) $id"
            fi
        done < <(find "$dir" -type f -printf '%s %p\n' 2>/dev/null |
            awk -v sizes="$SIZES" 'BEGIN { n = split(sizes, a, " "); for (i = 1; i <= n; i++) want[a[i]] = 1 } ($1 in want)')
    fi

    # 3. Demo and test profiles, and 4. the demo seed data, by name.
    while IFS= read -r file; do
        [[ -n $file ]] || continue
        rel=${file#"$dir"/}
        case "$rel" in
            */profiles/demo.yaml | profiles/demo.yaml | */profiles/test.yaml | profiles/test.yaml)
                finding "$label: $rel" "is a demo or test server profile" ;;
            */seed/demo/* | seed/demo/*)
                finding "$label: $rel" "is demo seed data" ;;
            *sample-snapshot.json)
                finding "$label: $rel" "is the demo seed snapshot" ;;
            */node_modules/*) ;;
            *demo.yaml | *test.yaml)
                finding "$label: $rel" "looks like a demo or test server profile" ;;
        esac
    done < <(find "$dir" \( -type f -o -type l \) \( -name 'demo.yaml' -o -name 'test.yaml' \
        -o -name 'sample-snapshot.json' -o -path '*/seed/demo/*' \) 2>/dev/null)
}

# is_archive FILE: archives that are opened and checked inside.
is_archive() {
    case "$1" in
        *.tar | *.tar.gz | *.tgz | *.pack) return 0 ;;
    esac
    # Image layers in a docker save archive: blobs/sha256/<digest> (OCI layout)
    # or <id>/layer.tar (older layout). Configs and manifests are JSON, which
    # tar refuses; they stay plain files.
    case "$1" in
        */blobs/sha256/* | */layer.tar)
            tar -tf "$1" >/dev/null 2>&1
            return
            ;;
    esac
    return 1
}

# extract ARCHIVE DEST: unpacks a (compressed) tar archive without owners,
# device files or absolute paths. GNU tar detects the compression itself.
extract() {
    local archive=$1 dest=$2
    mkdir -p "$dest"
    tar -xf "$archive" -C "$dest" --no-same-owner --no-same-permissions --delay-directory-restore \
        --exclude='dev/*' --warning=no-unknown-keyword --warning=no-timestamp 2>/dev/null || {
        # A layer can hold entries tar cannot create here (device nodes, odd
        # permissions); what could be written is still checked.
        true
    }
    chmod -R u+rwX "$dest" 2>/dev/null || true
}

# check_path DIR LABEL DEPTH: checks DIR, then every archive below it.
check_path() {
    local dir=$1 label=$2 depth=$3 file rel sub n=0
    check_tree "$dir" "$label"
    ((depth < MAX_DEPTH)) || return 0
    while IFS= read -r -d '' file; do
        is_archive "$file" || continue
        rel=${file#"$dir"/}
        n=$((n + 1))
        sub=$(mktemp -d "$WORK/x.XXXXXX")
        extract "$file" "$sub"
        check_path "$sub" "$label > $(short_name "$rel")" $((depth + 1))
        chmod -R u+rwX "$sub" 2>/dev/null || true
        rm -rf -- "$sub"
    done < <(find "$dir" -type f -print0 2>/dev/null)
}

# short_name PATH: layer blobs are named by their digest; keep 12 characters.
short_name() {
    case "$1" in
        */blobs/sha256/* | blobs/sha256/*) printf 'layer %s' "$(basename -- "$1" | cut -c1-12)" ;;
        *) printf '%s' "$1" ;;
    esac
}

# ---------------------------------------------------------------------------
# Targets
# ---------------------------------------------------------------------------
check_target() {
    local target=$1 tmp before=$FINDINGS
    printf '\n%s==> %s%s\n' "$C_BOLD" "$target" "$C_RESET"
    if [[ -d $target ]]; then
        check_path "$(cd -- "$target" && pwd)" "$target" 0
    elif [[ -f $target ]]; then
        is_archive "$target" || die "$target is not a directory, a .tar, .tar.gz, .tgz or .pack archive, or an image"
        tmp=$(mktemp -d "$WORK/t.XXXXXX")
        extract "$target" "$tmp"
        check_path "$tmp" "$target" 1
    elif command -v docker >/dev/null 2>&1 && docker image inspect "$target" >/dev/null 2>&1; then
        tmp=$(mktemp -d "$WORK/i.XXXXXX")
        docker save "$target" -o "$tmp/image.tar" || die "docker save failed for $target"
        extract "$tmp/image.tar" "$tmp/image"
        rm -f -- "$tmp/image.tar"
        check_path "$tmp/image" "image $target" 1
    else
        die "$target is not a directory, an archive or a local Docker image"
    fi
    if ((FINDINGS == before)); then
        printf '  %sPASS%s  no development key, development secret, demo or test profile, or seed data\n' "$C_GREEN" "$C_RESET"
    fi
}

main() {
    if [[ $# -eq 0 ]]; then
        usage >&2
        exit 2
    fi
    case "$1" in
        -h | --help) usage; exit 0 ;;
    esac
    local tool
    for tool in tar sha256sum grep awk find stat; do
        command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed"
    done
    WORK=$(mktemp -d "${TMPDIR:-/tmp}/mscd-release-check.XXXXXX")

    printf '%sMSCD release artefact check (R-13)%s\n' "$C_BOLD" "$C_RESET"
    load_reference
    local target
    for target in "$@"; do
        check_target "$target"
    done

    echo
    if ((FINDINGS > 0)); then
        printf '%sFAILED%s: %s forbidden file(s) found. Do not release these artefacts.\n' "$C_RED$C_BOLD" "$C_RESET" "$FINDINGS"
        exit 1
    fi
    printf '%sPASSED%s: the artefacts carry no development key, development secret, demo or test profile, or seed data.\n' \
        "$C_GREEN$C_BOLD" "$C_RESET"
}

main "$@"
