#!/usr/bin/env bash
# MSCD on-premise upgrade (Docker Compose).
#
# Upgrade: run it from the extracted bundle of the NEW version:
#   sudo ./upgrade.sh
# Roll back to the version that ran before the last upgrade:
#   sudo /opt/mscd/upgrade.sh --rollback
#
# Settings (.env) and certificates are kept. Before switching, the new image is
# started once on its own as a test (canary). If the switched service does not
# become healthy, the previous version is restored automatically.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

readonly KEEP_BACKUPS=5

usage() {
    cat <<'EOF'
Usage: sudo ./upgrade.sh [options]
       sudo /opt/mscd/upgrade.sh --rollback [options]

Upgrades an existing MSCD installation to the version in this bundle, keeping
settings and certificates. Rolls back automatically if the new version fails
its health check.

Options:
  --dir DIR                Install directory (default: /opt/mscd)
  --rollback               Return to the version and settings saved before the last upgrade
  --skip-canary            Do not test the new image before switching (not recommended)
  --verify-key FILE        Public key for the bundle signature
                           (default: mscd-release.pub next to the bundle directory)
  --skip-signature-check   Upgrade from a signed bundle without checking its signature (not recommended)
  --timeout SECONDS        How long to wait for the health check (default: 180)
  -y, --yes                Do not ask for confirmation. Required when there is no terminal.
  -h, --help               Show this help
EOF
}

OPT_DIR='' ROLLBACK=false SKIP_CANARY=false VERIFY_KEY='' SKIP_SIGNATURE=false TIMEOUT=180

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dir) [[ $# -ge 2 ]] || die "--dir needs a value"; OPT_DIR=$2; shift 2 ;;
            --rollback) ROLLBACK=true; shift ;;
            --skip-canary) SKIP_CANARY=true; shift ;;
            --verify-key) [[ $# -ge 2 ]] || die "--verify-key needs a value"; VERIFY_KEY=$(absolute_path "$2"); shift 2 ;;
            --skip-signature-check) SKIP_SIGNATURE=true; shift ;;
            --timeout) [[ $# -ge 2 && $2 =~ ^[0-9]+$ ]] || die "--timeout takes a number of seconds"; TIMEOUT=$2; shift 2 ;;
            -y | --yes) ASSUME_YES=true; shift ;;
            -h | --help) usage; exit 0 ;;
            *) die "Unknown option: $1. See ./upgrade.sh --help" ;;
        esac
    done
    require_terminal_or_yes
}

check_installation() {
    if [[ ! -f $INSTALL_DIR/$MSCD_MARKER || ! -f $INSTALL_DIR/.env ]]; then
        fail "No MSCD installation found in $INSTALL_DIR" "Run ./install.sh first, or pass --dir"
        return 0
    fi
    if [[ ! -r $INSTALL_DIR/.env || ! -w $INSTALL_DIR/.env || ! -w $INSTALL_DIR ]]; then
        fail "User $(id -un) cannot change the MSCD installation in $INSTALL_DIR (it was installed with sudo)" \
            "Run the script with sudo"
        return 0
    fi
    CURRENT_VERSION=$(kv_get "$INSTALL_DIR/.env" MSCD_VERSION)
    CURRENT_IMAGE=$(kv_get "$INSTALL_DIR/.env" MSCD_IMAGE):$CURRENT_VERSION
    pass "MSCD $CURRENT_VERSION is installed in $INSTALL_DIR"
    check_container_owner "$INSTALL_DIR"
}

latest_backup() {
    local dirs=()
    if [[ -d $INSTALL_DIR/backups ]]; then
        mapfile -t dirs < <(find "$INSTALL_DIR/backups" -mindepth 1 -maxdepth 1 -type d | sort)
    fi
    if ((${#dirs[@]} > 0)); then
        echo "${dirs[-1]}"
    fi
}

# save_backup: copies the current settings to backups/<time>-<version>.
save_backup() {
    local stamp dirs=() i
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    BACKUP_DIR=$INSTALL_DIR/backups/$stamp-$CURRENT_VERSION
    install -d -m 0700 "$BACKUP_DIR"
    cp -p "$INSTALL_DIR/.env" "$INSTALL_DIR/docker-compose.yml" "$BACKUP_DIR/"
    if [[ -f $INSTALL_DIR/VERSION ]]; then cp -p "$INSTALL_DIR/VERSION" "$BACKUP_DIR/"; fi
    pass "Current settings saved to $BACKUP_DIR"

    mapfile -t dirs < <(find "$INSTALL_DIR/backups" -mindepth 1 -maxdepth 1 -type d | sort)
    for ((i = 0; i < ${#dirs[@]} - KEEP_BACKUPS; i++)); do
        rm -rf -- "${dirs[i]}"
    done
}

# restore_backup DIR: puts saved settings back and starts that version.
restore_backup() {
    local backup=$1 image
    image=$(kv_get "$backup/.env" MSCD_IMAGE):$(kv_get "$backup/.env" MSCD_VERSION)
    if ! docker image inspect "$image" >/dev/null 2>&1; then
        fail "Image $image is no longer on this host" "Load it from its bundle: docker load -i images/<file>"
        return 1
    fi
    cp -p "$backup/.env" "$INSTALL_DIR/.env"
    cp -p "$backup/docker-compose.yml" "$INSTALL_DIR/docker-compose.yml"
    if [[ -f $backup/VERSION ]]; then cp -p "$backup/VERSION" "$INSTALL_DIR/VERSION"; fi
    compose_in "$INSTALL_DIR" up -d --remove-orphans --force-recreate --wait --wait-timeout "$TIMEOUT" &&
        verify_endpoints "$INSTALL_DIR/.env"
}

run_canary() {
    local env=$INSTALL_DIR/.env ok=true uid gid
    uid=$(kv_get "$env" MSCD_RUN_UID)
    gid=$(kv_get "$env" MSCD_RUN_GID)
    docker rm -f "$MSCD_CANARY" >/dev/null 2>&1 || true
    docker run -d --name "$MSCD_CANARY" --network none \
        --user "${uid:-$MSCD_IMAGE_UID}:${gid:-$MSCD_IMAGE_UID}" \
        --read-only --tmpfs /tmp:size=64m,mode=1777 \
        --cap-drop ALL --security-opt no-new-privileges:true \
        --health-interval 2s --health-timeout 2s --health-retries 3 --health-start-period 5s \
        -e MSCD_HTTP_REDIRECT="$(kv_get "$env" MSCD_HTTP_REDIRECT)" \
        -e MSCD_HTTPS_PUBLIC_PORT="$(kv_get "$env" MSCD_HTTPS_PORT)" \
        -e MSCD_DOMAIN="$(kv_get "$env" MSCD_DOMAIN)" \
        -e MSCD_HSTS="$(kv_get "$env" MSCD_HSTS)" \
        -e MSCD_EXTERNAL_FONTS="$(kv_get "$env" MSCD_EXTERNAL_FONTS)" \
        -v "$INSTALL_DIR/tls:/etc/nginx/tls:ro,z" \
        --label com.cyberlentera.mscd.component=canary \
        "$NEW_IMAGE" >/dev/null

    if wait_healthy "$MSCD_CANARY" 90; then
        pass "The new image started with your settings and passed its health check"
        if [[ -f $INSTALL_DIR/tls/tls.crt ]]; then
            if docker exec "$MSCD_CANARY" curl -fsk -o /dev/null --max-time 5 https://127.0.0.1:8443/healthz; then
                pass "The new image serves HTTPS with the installed certificate"
            else
                fail "The new image does not serve HTTPS with the installed certificate"
                ok=false
            fi
        fi
    else
        fail "The new image did not pass its health check"
        show_logs "$MSCD_CANARY" 20
        ok=false
    fi
    docker rm -f "$MSCD_CANARY" >/dev/null 2>&1 || true
    [[ $ok == true ]]
}

install_new_files() {
    install -m 0644 "$SCRIPT_DIR/compose/docker-compose.yml" "$INSTALL_DIR/docker-compose.yml"
    install -m 0644 "$SCRIPT_DIR/compose/.env.example" "$INSTALL_DIR/.env.example"
    install -d -m 0755 "$INSTALL_DIR/lib"
    install -m 0644 "$SCRIPT_DIR/lib/common.sh" "$INSTALL_DIR/lib/common.sh"
    install -m 0755 "$SCRIPT_DIR/upgrade.sh" "$SCRIPT_DIR/uninstall.sh" "$INSTALL_DIR/"
    install -m 0644 "$SCRIPT_DIR/VERSION" "$SCRIPT_DIR/INSTALL-ONPREM.md" "$INSTALL_DIR/"
    env_merge_defaults "$SCRIPT_DIR/compose/.env.example" "$INSTALL_DIR/.env"
    env_set "$INSTALL_DIR/.env" MSCD_IMAGE "$BUNDLE_IMAGE"
    env_set "$INSTALL_DIR/.env" MSCD_VERSION "$TARGET_VERSION"
    pass "Settings kept; version set to $TARGET_VERSION"
}

# running_text VERSION: what users have now, for messages that change nothing.
running_text() {
    local state
    state=$(container_state "$MSCD_CONTAINER")
    if [[ $state == healthy ]]; then
        echo "MSCD $1 keeps running."
    else
        echo "The MSCD container is $state."
    fi
}

rollback_main() {
    local backup target image
    title "MSCD rollback"

    step "Checking"
    check_privileges
    check_docker
    check_installation
    abort_if_failed

    backup=$(latest_backup)
    [[ -n $backup ]] || die "No saved settings in $INSTALL_DIR/backups. There is nothing to roll back to."
    target=$(kv_get "$backup/.env" MSCD_VERSION)
    info "Saved settings: $backup (version $target)"
    image=$(kv_get "$backup/.env" MSCD_IMAGE):$target
    if [[ $target != "$CURRENT_VERSION" ]] && ! image_exists "$image"; then
        fail "Image $image is no longer on this host" \
            "Load it from the $target bundle, then run --rollback again: docker load -i mscd-onprem-$target/images/mscd-web-$target-$(host_arch).tar.gz"
        printf '\nNothing was changed. %s\n' "$(running_text "$CURRENT_VERSION")"
        exit 1
    fi
    if [[ $target == "$CURRENT_VERSION" && $(container_state "$MSCD_CONTAINER") == healthy ]] &&
        cmp -s "$backup/.env" "$INSTALL_DIR/.env"; then
        rm -rf -- "$backup"
        pass "MSCD $target is already running with these settings. Nothing to do."
        return 0
    fi
    confirm "Roll back MSCD from $CURRENT_VERSION to $target?" || die "Cancelled. Nothing was changed."
    lock_dir "$INSTALL_DIR"

    step "Rolling back"
    if restore_backup "$backup"; then
        # The restored settings are now current; the next --rollback goes one release further back.
        rm -rf -- "$backup"
        printf '\n%sMSCD is back on version %s and healthy.%s\n' "$C_GREEN$C_BOLD" "$target" "$C_RESET"
    else
        show_logs "$MSCD_CONTAINER" 30
        die "Rollback did not finish. See the troubleshooting table in INSTALL-ONPREM.md."
    fi
}

upgrade_main() {
    [[ -f $SCRIPT_DIR/BUNDLE-INFO ]] ||
        die "Run upgrade.sh from the extracted bundle of the new version. This copy only supports --rollback."

    TARGET_VERSION=$(tr -d '[:space:]' <"$SCRIPT_DIR/VERSION")
    BUNDLE_IMAGE=$(kv_get "$SCRIPT_DIR/BUNDLE-INFO" IMAGE)
    BUNDLE_IMAGE=${BUNDLE_IMAGE:-$MSCD_DEFAULT_IMAGE}
    NEW_IMAGE=$BUNDLE_IMAGE:$TARGET_VERSION
    title "MSCD on-premise upgrade to version $TARGET_VERSION"

    step "Checking this host"
    check_privileges
    check_docker
    check_resources "$INSTALL_DIR"
    check_tool openssl "needed for the signature and certificate checks"

    step "Checking the bundle"
    verify_checksums "$SCRIPT_DIR"
    if [[ $ASSUME_YES == false && -z $VERIFY_KEY && $SKIP_SIGNATURE == false && -z $(find_public_key "$SCRIPT_DIR") ]]; then
        VERIFY_KEY=$(ask_public_key "$SCRIPT_DIR")
    fi
    verify_signature "$SCRIPT_DIR" "$VERIFY_KEY" "$SKIP_SIGNATURE"
    check_arch "$(kv_get "$SCRIPT_DIR/BUNDLE-INFO" IMAGE_ARCH)"

    step "Checking the installation"
    check_installation
    abort_if_failed

    if [[ $CURRENT_VERSION == "$TARGET_VERSION" ]]; then
        if [[ $(container_state "$MSCD_CONTAINER") == healthy ]]; then
            pass "MSCD $TARGET_VERSION is already installed and healthy. Nothing to do."
            return 0
        fi
        info "MSCD $TARGET_VERSION is installed but not healthy; starting it again"
        compose_in "$INSTALL_DIR" up -d --remove-orphans --force-recreate --wait --wait-timeout "$TIMEOUT" ||
            die "MSCD did not become healthy. See: docker logs $MSCD_CONTAINER"
        return 0
    fi
    if ! version_ge "$TARGET_VERSION" "$CURRENT_VERSION"; then
        die "This bundle ($TARGET_VERSION) is older than the installed version ($CURRENT_VERSION). Use --rollback instead."
    fi
    confirm "Upgrade MSCD from $CURRENT_VERSION to $TARGET_VERSION?" || die "Cancelled. Nothing was changed."
    lock_dir "$INSTALL_DIR"

    step "Loading the new image"
    local had_image=false
    if image_exists "$NEW_IMAGE"; then had_image=true; fi
    load_image "$SCRIPT_DIR/$(kv_get "$SCRIPT_DIR/BUNDLE-INFO" IMAGE_FILE)" "$NEW_IMAGE" \
        "$(kv_get "$SCRIPT_DIR/BUNDLE-INFO" IMAGE_LAYERS)"

    if [[ $SKIP_CANARY == true ]]; then
        warn "Skipping the test run of the new image (--skip-canary)"
    else
        step "Testing the new image before switching"
        if ! run_canary; then
            if [[ $had_image == false ]] && [[ -z $(docker ps -aq --filter "ancestor=$NEW_IMAGE") ]] &&
                docker image rm "$NEW_IMAGE" >/dev/null 2>&1; then
                info "Removed the image $NEW_IMAGE that failed the test"
            else
                info "The image $NEW_IMAGE stays on this host. Remove it with: docker image rm $NEW_IMAGE"
            fi
            die "The new image failed its test run. Nothing was changed. $(running_text "$CURRENT_VERSION")"
        fi
    fi

    step "Switching to $TARGET_VERSION"
    save_backup
    install_new_files
    if compose_in "$INSTALL_DIR" up -d --remove-orphans --wait --wait-timeout "$TIMEOUT" &&
        verify_endpoints "$INSTALL_DIR/.env"; then
        printf '\n%sMSCD is upgraded from %s to %s.%s\n' "$C_GREEN$C_BOLD" "$CURRENT_VERSION" "$TARGET_VERSION" "$C_RESET"
        printf '  Open %s\n' "$(public_url "$INSTALL_DIR/.env")"
        printf '  The previous image stays on this host for rollback: %s\n' "$CURRENT_IMAGE"
        printf '  To roll back later: %s%s/upgrade.sh --rollback\n' "$(sudo_prefix)" "$INSTALL_DIR"
        return 0
    fi

    fail "MSCD $TARGET_VERSION did not become healthy"
    show_logs "$MSCD_CONTAINER" 30

    step "Rolling back to $CURRENT_VERSION"
    if restore_backup "$BACKUP_DIR"; then
        rm -rf -- "$BACKUP_DIR"
        printf '\n%sUpgrade failed and was rolled back. MSCD %s is running and healthy.%s\n' \
            "$C_YELLOW$C_BOLD" "$CURRENT_VERSION" "$C_RESET"
        printf '  Send the log lines above to CyberLentera support.\n'
        exit 1
    fi
    show_logs "$MSCD_CONTAINER" 30
    die "Rollback did not finish. Saved settings are in $BACKUP_DIR. See INSTALL-ONPREM.md, Upgrade and rollback."
}

main() {
    parse_args "$@"
    INSTALL_DIR=$(absolute_path "${OPT_DIR:-$(default_install_dir)}")
    if [[ $ROLLBACK == true ]]; then
        rollback_main
    else
        upgrade_main
    fi
}

main "$@"
exit 0
