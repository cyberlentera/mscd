#!/usr/bin/env bash
# MSCD on-premise upgrade (Docker Compose, build plan I.3 and I.6).
#
# Upgrade: run it from the extracted bundle of the NEW version:
#   sudo ./upgrade.sh
# Roll back to the version that ran before the last upgrade:
#   sudo /opt/mscd/upgrade.sh --rollback
#
# Settings (.env), secrets and certificates are kept. Order of an upgrade:
#   1. the new images are loaded and the new web image is started once on its
#      own as a test (canary);
#   2. the database migrations of the new version run (docker compose run --rm
#      migrate) while the old containers keep running; when they fail, nothing
#      else changes and the migrate log is shown;
#   3. docker compose up -d replaces api, worker, storage-gateway and web.
#      If they do not become healthy, the previous version starts again.
# Migrations are compatible with the previous release (expand and contract), so
# a rollback starts the previous images on the migrated database. Undoing a
# migration needs the database backup taken before the upgrade.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh disable=SC1091  # followed with shellcheck -x
. "$SCRIPT_DIR/lib/common.sh"

readonly KEEP_BACKUPS=5

usage() {
    cat <<'EOF'
Usage: sudo ./upgrade.sh [options]
       sudo /opt/mscd/upgrade.sh --rollback [options]

Upgrades an existing MSCD installation to the version in this bundle, keeping
settings, secrets and certificates. The database migrations run before any
running service is replaced; if the new version fails its health checks, the
previous version is started again.

Back up the database and the object store before every upgrade (see
INSTALL-ONPREM.md, Upgrades and backups).

Options:
  --dir DIR                Install directory (default: /opt/mscd)
  --rollback               Return to the version and settings saved before the last upgrade
  --skip-canary            Do not test the new web image before switching (not recommended)
  --verify-key FILE        Public key for the bundle signature
                           (default: mscd-release.pub next to the bundle directory)
  --skip-signature-check   Upgrade from a signed bundle without checking its signature (not recommended)
  --timeout SECONDS        How long to wait for the services to become healthy (default: 600)
  -y, --yes                Do not ask for confirmation. Required when there is no terminal.
  -h, --help               Show this help
EOF
}

OPT_DIR='' ROLLBACK=false SKIP_CANARY=false VERIFY_KEY='' SKIP_SIGNATURE=false TIMEOUT=600

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
    CURRENT_SERVER_IMAGE=$(kv_get "$INSTALL_DIR/.env" MSCD_SERVER_IMAGE)
    if [[ ! -d $INSTALL_DIR/secrets || -z $CURRENT_SERVER_IMAGE ]]; then
        fail "MSCD $CURRENT_VERSION in $INSTALL_DIR is the web-only package" \
            "Run ./install.sh from this bundle with --dir $INSTALL_DIR; it adds the platform and keeps the settings"
        return 0
    fi
    CURRENT_SERVER_IMAGE+=:$CURRENT_VERSION
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

# save_backup: copies the current settings and Compose files to backups/<time>-<version>.
save_backup() {
    local stamp dirs=() i
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    BACKUP_DIR=$INSTALL_DIR/backups/$stamp-$CURRENT_VERSION
    install -d -m 0700 "$BACKUP_DIR"
    cp -p "$INSTALL_DIR/.env" "$INSTALL_DIR/docker-compose.yml" "$BACKUP_DIR/"
    if [[ -f $INSTALL_DIR/VERSION ]]; then cp -p "$INSTALL_DIR/VERSION" "$BACKUP_DIR/"; fi
    if [[ -d $INSTALL_DIR/config ]]; then cp -pR "$INSTALL_DIR/config" "$BACKUP_DIR/config"; fi
    pass "Current settings saved to $BACKUP_DIR"

    mapfile -t dirs < <(find "$INSTALL_DIR/backups" -mindepth 1 -maxdepth 1 -type d | sort)
    for ((i = 0; i < ${#dirs[@]} - KEEP_BACKUPS; i++)); do
        rm -rf -- "${dirs[i]}"
    done
}

# restore_files DIR: puts saved settings and Compose files back (no restart).
restore_files() {
    local backup=$1
    cp -p "$backup/.env" "$INSTALL_DIR/.env"
    cp -p "$backup/docker-compose.yml" "$INSTALL_DIR/docker-compose.yml"
    if [[ -f $backup/VERSION ]]; then cp -p "$backup/VERSION" "$INSTALL_DIR/VERSION"; fi
    if [[ -d $backup/config ]]; then
        rm -rf -- "$INSTALL_DIR/config"
        cp -pR "$backup/config" "$INSTALL_DIR/config"
    fi
}

# backup_images DIR: the web and server images a saved .env names.
backup_images() {
    local env=$1/.env version server
    version=$(kv_get "$env" MSCD_VERSION)
    echo "$(kv_get "$env" MSCD_IMAGE):$version"
    server=$(kv_get "$env" MSCD_SERVER_IMAGE)
    if [[ -n $server ]]; then echo "$server:$version"; fi
}

# restore_backup DIR: puts saved settings back and starts that version.
restore_backup() {
    local backup=$1 image
    while read -r image; do
        if ! docker image inspect "$image" >/dev/null 2>&1; then
            fail "Image $image is no longer on this host" "Load it from its bundle: docker load -i images/<file>"
            return 1
        fi
    done < <(backup_images "$backup")
    restore_files "$backup"
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
        -e MSCD_TRUSTED_PROXY_CIDRS="$(kv_get "$env" MSCD_TRUSTED_PROXY_CIDRS)" \
        -e MSCD_API_UPSTREAM=none \
        -v "$INSTALL_DIR/tls:/etc/nginx/tls:ro,z" \
        --label com.cyberlentera.mscd.component=canary \
        "$NEW_IMAGE" >/dev/null

    if wait_healthy "$MSCD_CANARY" 90; then
        pass "The new web image started with your settings and passed its health check"
        if [[ -f $INSTALL_DIR/tls/tls.crt ]]; then
            if docker exec "$MSCD_CANARY" curl -fsk -o /dev/null --max-time 5 https://127.0.0.1:8443/healthz; then
                pass "The new web image serves HTTPS with the installed certificate"
            else
                fail "The new web image does not serve HTTPS with the installed certificate"
                ok=false
            fi
        fi
    else
        fail "The new web image did not pass its health check"
        show_logs "$MSCD_CANARY" 20
        ok=false
    fi
    docker rm -f "$MSCD_CANARY" >/dev/null 2>&1 || true
    if [[ $ok == true ]]; then
        if docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
            "$NEW_SERVER_IMAGE" --version >/dev/null 2>&1; then
            pass "The new server image starts"
        else
            fail "The new server image does not start (mscd-server --version failed)"
            ok=false
        fi
    fi
    [[ $ok == true ]]
}

install_new_files() {
    install -m 0644 "$SCRIPT_DIR/compose/docker-compose.yml" "$INSTALL_DIR/docker-compose.yml"
    install -m 0644 "$SCRIPT_DIR/compose/.env.example" "$INSTALL_DIR/.env.example"
    install_config "$SCRIPT_DIR/compose/config" "$INSTALL_DIR/config"
    install -d -m 0755 "$INSTALL_DIR/lib"
    install -m 0644 "$SCRIPT_DIR/lib/common.sh" "$INSTALL_DIR/lib/common.sh"
    install -m 0755 "$SCRIPT_DIR/upgrade.sh" "$SCRIPT_DIR/uninstall.sh" "$INSTALL_DIR/"
    install -m 0644 "$SCRIPT_DIR/VERSION" "$INSTALL_DIR/"
    if [[ -f $SCRIPT_DIR/INSTALL-ONPREM.md ]]; then
        install -m 0644 "$SCRIPT_DIR/INSTALL-ONPREM.md" "$INSTALL_DIR/"
    fi
    env_merge_defaults "$SCRIPT_DIR/compose/.env.example" "$INSTALL_DIR/.env"
    env_set "$INSTALL_DIR/.env" MSCD_IMAGE "$BUNDLE_IMAGE"
    env_set "$INSTALL_DIR/.env" MSCD_SERVER_IMAGE "$BUNDLE_SERVER_IMAGE"
    env_set "$INSTALL_DIR/.env" MSCD_VERSION "$TARGET_VERSION"
    pass "Settings kept; version set to $TARGET_VERSION"
}

# run_migrations: the migrate service of the new version, alone. The running
# services are not touched. On failure the saved files are put back.
run_migrations() {
    local log=$INSTALL_DIR/backups/migrate-$TARGET_VERSION.log
    info "Running the database migrations of $TARGET_VERSION (the running services stay up)"
    if [[ $(service_state postgres) != healthy && -n $(project_containers postgres) ]]; then
        warn "The bundled PostgreSQL is not healthy ($(service_state postgres))"
    fi
    if compose_in "$INSTALL_DIR" run --rm --no-deps migrate >"$log" 2>&1; then
        pass "Database migrations applied (log: $log)"
        return 0
    fi
    fail "The database migrations of $TARGET_VERSION failed"
    printf '        Migrate log (%s):\n' "$log"
    tail -n 40 "$log" | sed 's/^/          /'
    restore_files "$BACKUP_DIR"
    rm -rf -- "$BACKUP_DIR"
    die "Nothing else was changed: MSCD $CURRENT_VERSION keeps running. Send the migrate log to CyberLentera support."
}

# running_text VERSION: what users have now, for messages that change nothing.
running_text() {
    local state
    state=$(service_state "$MSCD_WEB_SERVICE")
    if [[ $state == healthy ]]; then
        echo "MSCD $1 keeps running."
    else
        echo "The MSCD web container is $state."
    fi
}

rollback_main() {
    local backup target image missing=false
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
    if [[ $target != "$CURRENT_VERSION" ]]; then
        while read -r image; do
            if ! image_exists "$image"; then
                fail "Image $image is no longer on this host" \
                    "Load it from the $target bundle (docker load -i mscd-onprem-$target/images/<file>), then run --rollback again"
                missing=true
            fi
        done < <(backup_images "$backup")
        if [[ $missing == true ]]; then
            printf '\nNothing was changed. %s\n' "$(running_text "$CURRENT_VERSION")"
            exit 1
        fi
    fi
    if [[ $target == "$CURRENT_VERSION" && $(service_state "$MSCD_WEB_SERVICE") == healthy ]] &&
        cmp -s "$backup/.env" "$INSTALL_DIR/.env"; then
        rm -rf -- "$backup"
        pass "MSCD $target is already running with these settings. Nothing to do."
        return 0
    fi
    info "The database stays as it is: version $target runs on the schema of $CURRENT_VERSION (expand and contract)"
    confirm "Roll back MSCD from $CURRENT_VERSION to $target?" || die "Cancelled. Nothing was changed."
    lock_dir "$INSTALL_DIR"

    step "Rolling back"
    if restore_backup "$backup"; then
        # The restored settings are now current; the next --rollback goes one release further back.
        rm -rf -- "$backup"
        printf '\n%sMSCD is back on version %s and healthy.%s\n' "$C_GREEN$C_BOLD" "$target" "$C_RESET"
    else
        show_unhealthy_logs 30
        die "Rollback did not finish. See the troubleshooting table in INSTALL-ONPREM.md."
    fi
}

upgrade_main() {
    [[ -f $SCRIPT_DIR/BUNDLE-INFO ]] ||
        die "Run upgrade.sh from the extracted bundle of the new version. This copy only supports --rollback."

    TARGET_VERSION=$(tr -d '[:space:]' <"$SCRIPT_DIR/VERSION")
    BUNDLE_IMAGE=$(kv_get "$SCRIPT_DIR/BUNDLE-INFO" IMAGE)
    BUNDLE_IMAGE=${BUNDLE_IMAGE:-$MSCD_DEFAULT_IMAGE}
    BUNDLE_SERVER_IMAGE=$(kv_get "$SCRIPT_DIR/BUNDLE-INFO" SERVER_IMAGE)
    BUNDLE_SERVER_IMAGE=${BUNDLE_SERVER_IMAGE:-$MSCD_DEFAULT_SERVER_IMAGE}
    NEW_IMAGE=$BUNDLE_IMAGE:$TARGET_VERSION
    NEW_SERVER_IMAGE=$BUNDLE_SERVER_IMAGE:$TARGET_VERSION
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
    check_bundle_images "$SCRIPT_DIR"

    step "Checking the installation"
    check_installation
    abort_if_failed

    if [[ $CURRENT_VERSION == "$TARGET_VERSION" ]]; then
        if [[ $(service_state "$MSCD_WEB_SERVICE") == healthy && $(service_state api) == healthy ]]; then
            pass "MSCD $TARGET_VERSION is already installed and healthy. Nothing to do."
            return 0
        fi
        info "MSCD $TARGET_VERSION is installed but not healthy; starting it again"
        compose_in "$INSTALL_DIR" up -d --remove-orphans --force-recreate --wait --wait-timeout "$TIMEOUT" || {
            show_unhealthy_logs 30
            die "MSCD did not become healthy. See: cd $INSTALL_DIR && docker compose ps -a"
        }
        return 0
    fi
    if ! version_ge "$TARGET_VERSION" "$CURRENT_VERSION"; then
        die "This bundle ($TARGET_VERSION) is older than the installed version ($CURRENT_VERSION). Use --rollback instead."
    fi
    warn "Back up the database and the object store before you continue (INSTALL-ONPREM.md, Upgrades and backups)"
    confirm "Upgrade MSCD from $CURRENT_VERSION to $TARGET_VERSION?" || die "Cancelled. Nothing was changed."
    lock_dir "$INSTALL_DIR"

    step "Loading the new images"
    local had_image=false
    if image_exists "$NEW_IMAGE"; then had_image=true; fi
    load_bundle_images "$SCRIPT_DIR"

    if [[ $SKIP_CANARY == true ]]; then
        warn "Skipping the test run of the new images (--skip-canary)"
    else
        step "Testing the new images before switching"
        if ! run_canary; then
            if [[ $had_image == false ]] && [[ -z $(docker ps -aq --filter "ancestor=$NEW_IMAGE") ]] &&
                docker image rm "$NEW_IMAGE" >/dev/null 2>&1; then
                info "Removed the image $NEW_IMAGE that failed the test"
            else
                info "The image $NEW_IMAGE stays on this host. Remove it with: docker image rm $NEW_IMAGE"
            fi
            die "The new images failed their test run. Nothing was changed. $(running_text "$CURRENT_VERSION")"
        fi
    fi

    step "Secrets and certificates"
    ensure_secrets "$INSTALL_DIR/secrets" "$NEW_SERVER_IMAGE" || {
        abort_if_failed
        die "The secrets could not be checked. Nothing was changed. $(running_text "$CURRENT_VERSION")"
    }

    step "Migrating the database to $TARGET_VERSION"
    save_backup
    install_new_files
    run_migrations

    step "Switching to $TARGET_VERSION"
    local args=(up -d --remove-orphans --wait --wait-timeout "$TIMEOUT")
    if [[ $CERTS_CHANGED == true ]]; then args+=(--force-recreate); fi
    if compose_in "$INSTALL_DIR" "${args[@]}" && verify_endpoints "$INSTALL_DIR/.env"; then
        printf '\n%sMSCD is upgraded from %s to %s.%s\n' "$C_GREEN$C_BOLD" "$CURRENT_VERSION" "$TARGET_VERSION" "$C_RESET"
        printf '  Open %s\n' "$(public_url "$INSTALL_DIR/.env")"
        printf '  The previous images stay on this host for rollback: %s %s\n' "$CURRENT_IMAGE" "$CURRENT_SERVER_IMAGE"
        printf '  To roll back later: %s%s/upgrade.sh --rollback\n' "$(sudo_prefix)" "$INSTALL_DIR"
        return 0
    fi

    fail "MSCD $TARGET_VERSION did not become healthy"
    show_unhealthy_logs 30

    step "Rolling back to $CURRENT_VERSION"
    if restore_backup "$BACKUP_DIR"; then
        rm -rf -- "$BACKUP_DIR"
        printf '\n%sUpgrade failed and was rolled back. MSCD %s is running and healthy.%s\n' \
            "$C_YELLOW$C_BOLD" "$CURRENT_VERSION" "$C_RESET"
        printf '  The database keeps the %s migrations, which %s supports (expand and contract).\n' "$TARGET_VERSION" "$CURRENT_VERSION"
        printf '  Send the log lines above to CyberLentera support.\n'
        exit 1
    fi
    show_unhealthy_logs 30
    die "Rollback did not finish. Saved settings are in $BACKUP_DIR. See INSTALL-ONPREM.md, Upgrades and backups."
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
