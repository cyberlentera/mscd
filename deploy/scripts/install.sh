#!/usr/bin/env bash
# MSCD on-premise installer (Docker Compose).
#
# Run it from the extracted bundle directory:
#   sudo ./install.sh                      (asks a few questions)
#   sudo ./install.sh --yes --self-signed  (no questions)
#
# Safe to run again: existing settings are kept unless you pass new values.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

usage() {
    cat <<'EOF'
Usage: sudo ./install.sh [options]

Installs MSCD with Docker Compose from this offline bundle, or changes the
settings of an existing installation. Without options it asks a few questions.

Options:
  --dir DIR                Install directory (default: /opt/mscd; use a directory
                           you own, such as ~/mscd, when running without sudo)
  --domain NAME            Host name users open in the browser (default: this host's name)
  --http-port PORT         HTTP port on this host (default: 80)
  --https-port PORT        HTTPS port on this host (default: 443)
  --bind-address IP        Host address to listen on (default: 0.0.0.0, all IPv4 addresses)
  --self-signed            Generate a self-signed certificate (default for a new install)
  --tls-cert FILE          Your certificate, PEM format, full chain
  --tls-key FILE           The private key for --tls-cert, PEM format, no passphrase
  --http-redirect on|off   Redirect HTTP to HTTPS (default: on)
  --hsts on|off            Send Strict-Transport-Security (default: off; needs a trusted certificate)
  --external-fonts on|off  Allow the optional Google Fonts (default: off)
  --verify-key FILE        Public key for the bundle signature
                           (default: mscd-release.pub next to the bundle directory)
  --skip-signature-check   Install a signed bundle without checking its signature (not recommended)
  --timeout SECONDS        How long to wait for the health check (default: 180)
  -y, --yes                Ask no questions; use flags, saved settings, then defaults.
                           Required when there is no terminal.
  -h, --help               Show this help
EOF
}

# Values from flags (empty means "not given").
OPT_DIR='' OPT_DOMAIN='' OPT_HTTP_PORT='' OPT_HTTPS_PORT='' OPT_BIND=''
OPT_SELF_SIGNED=false OPT_TLS_CERT='' OPT_TLS_KEY=''
OPT_REDIRECT='' OPT_HSTS='' OPT_FONTS='' VERIFY_KEY='' SKIP_SIGNATURE=false TIMEOUT=180

need_value() {
    if [[ $# -lt 2 || -z $2 || $2 == --* ]]; then
        die "Option $1 needs a value. See ./install.sh --help"
    fi
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dir) need_value "$@"; OPT_DIR=$2; shift 2 ;;
            --domain) need_value "$@"; OPT_DOMAIN=$2; shift 2 ;;
            --http-port) need_value "$@"; OPT_HTTP_PORT=$2; shift 2 ;;
            --https-port) need_value "$@"; OPT_HTTPS_PORT=$2; shift 2 ;;
            --bind-address) need_value "$@"; OPT_BIND=$2; shift 2 ;;
            --self-signed) OPT_SELF_SIGNED=true; shift ;;
            --tls-cert) need_value "$@"; OPT_TLS_CERT=$2; shift 2 ;;
            --tls-key) need_value "$@"; OPT_TLS_KEY=$2; shift 2 ;;
            --http-redirect) need_value "$@"; OPT_REDIRECT=$(to_bool "$2") || die "--http-redirect takes on or off"; shift 2 ;;
            --hsts) need_value "$@"; OPT_HSTS=$(to_bool "$2") || die "--hsts takes on or off"; shift 2 ;;
            --external-fonts) need_value "$@"; OPT_FONTS=$(to_bool "$2") || die "--external-fonts takes on or off"; shift 2 ;;
            --verify-key) need_value "$@"; VERIFY_KEY=$2; shift 2 ;;
            --skip-signature-check) SKIP_SIGNATURE=true; shift ;;
            --timeout) need_value "$@"; TIMEOUT=$2; shift 2 ;;
            -y | --yes) ASSUME_YES=true; shift ;;
            -h | --help) usage; exit 0 ;;
            *) die "Unknown option: $1. See ./install.sh --help" ;;
        esac
    done

    if [[ -n $OPT_TLS_CERT || -n $OPT_TLS_KEY ]]; then
        [[ -n $OPT_TLS_CERT && -n $OPT_TLS_KEY ]] || die "--tls-cert and --tls-key must be given together"
        [[ $OPT_SELF_SIGNED == false ]] || die "Choose either --self-signed or --tls-cert/--tls-key"
        OPT_TLS_CERT=$(absolute_path "$OPT_TLS_CERT")
        OPT_TLS_KEY=$(absolute_path "$OPT_TLS_KEY")
    fi
    [[ $TIMEOUT =~ ^[0-9]+$ ]] || die "--timeout takes a number of seconds"
    if [[ -n $VERIFY_KEY ]]; then VERIFY_KEY=$(absolute_path "$VERIFY_KEY"); fi
}

# ask PROMPT DEFAULT [CHECK ERROR]: prints the answer, or DEFAULT when empty.
# With CHECK, the question repeats until "CHECK answer" succeeds.
ask() {
    local prompt=$1 default=$2 check=${3:-} error=${4:-} answer
    if [[ -n $default ]]; then prompt+=" [$default]"; fi
    while true; do
        read -r -p "  $prompt: " answer </dev/tty || die "No answer was given."
        answer=${answer:-$default}
        if [[ -z $check ]] || "$check" "$answer"; then
            printf '%s\n' "$answer"
            return 0
        fi
        printf '  %s\n' "${error:-That answer is not valid.} Try again." >&2
    done
}

# Answer checks for ask(), which calls them by name.
# shellcheck disable=SC2329
https_port_ok() { valid_port "$1" && [[ $1 != "$HTTP_PORT" ]]; }
# shellcheck disable=SC2329
cert_choice_ok() { [[ $1 == 1 || $1 == 2 ]]; }
# shellcheck disable=SC2329
readable_file() { [[ -n $1 && -f $1 && -r $1 ]]; }

# ---------------------------------------------------------------------------
# Settings: flag > saved .env value > question > default
# ---------------------------------------------------------------------------
resolve_settings() {
    local saved_version
    ENV_FILE=$INSTALL_DIR/.env
    if [[ -f $ENV_FILE ]]; then
        info "Existing installation found in $INSTALL_DIR; its settings are the defaults"
        saved_version=$(kv_get "$ENV_FILE" MSCD_VERSION)
        if [[ -n $saved_version && $saved_version != "$BUNDLE_VERSION" ]]; then
            if version_ge "$saved_version" "$BUNDLE_VERSION"; then
                die "MSCD $saved_version is installed, which is newer than this bundle ($BUNDLE_VERSION). To go back, run: $INSTALL_DIR/upgrade.sh --rollback"
            fi
            die "MSCD $saved_version is installed. Use ./upgrade.sh from this bundle to move to $BUNDLE_VERSION with automatic rollback."
        fi
    fi

    local default_domain
    default_domain=$(kv_get "$ENV_FILE" MSCD_DOMAIN)
    if [[ -z $default_domain ]]; then
        default_domain=$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo localhost)
        default_domain=${default_domain%.}
    fi
    DOMAIN=${OPT_DOMAIN:-}
    HTTP_PORT=${OPT_HTTP_PORT:-$(kv_get "$ENV_FILE" MSCD_HTTP_PORT)}
    HTTPS_PORT=${OPT_HTTPS_PORT:-$(kv_get "$ENV_FILE" MSCD_HTTPS_PORT)}
    BIND=${OPT_BIND:-$(kv_get "$ENV_FILE" MSCD_BIND_ADDRESS)}
    REDIRECT=${OPT_REDIRECT:-$(kv_get "$ENV_FILE" MSCD_HTTP_REDIRECT)}
    HSTS=${OPT_HSTS:-$(kv_get "$ENV_FILE" MSCD_HSTS)}
    FONTS=${OPT_FONTS:-$(kv_get "$ENV_FILE" MSCD_EXTERNAL_FONTS)}

    local have_cert=false
    SAVED_TLS_MODE=$(kv_get "$ENV_FILE" MSCD_TLS_MODE)
    [[ -f $INSTALL_DIR/tls/tls.crt && -f $INSTALL_DIR/tls/tls.key ]] && have_cert=true
    if [[ -n $OPT_TLS_CERT ]]; then
        TLS_MODE=provided
    elif [[ $OPT_SELF_SIGNED == true ]]; then
        TLS_MODE=self-signed
    elif [[ $have_cert == true && -n $SAVED_TLS_MODE ]]; then
        TLS_MODE=$SAVED_TLS_MODE
    else
        TLS_MODE=''
    fi

    if [[ $INTERACTIVE == true ]]; then
        echo "  Press Enter to accept the value in brackets."
        [[ -n $DOMAIN ]] || DOMAIN=$(ask "Host name users will open" "$default_domain" valid_host \
            "Use a host name such as mscd.example.co.id, or an IPv4 address.")
        [[ -n $HTTP_PORT ]] || HTTP_PORT=$(ask "HTTP port" 80 valid_port "Use a port number from 1 to 65535.")
        [[ -n $HTTPS_PORT ]] || HTTPS_PORT=$(ask "HTTPS port" 443 https_port_ok \
            "Use a port number from 1 to 65535, different from the HTTP port.")
        if [[ -z $TLS_MODE ]]; then
            echo "  TLS certificate:"
            echo "    1) Generate a self-signed certificate (good for a pilot; browsers will warn)"
            echo "    2) Use certificate and key files from your certificate authority"
            if [[ "$(ask "Choose 1 or 2" 1 cert_choice_ok "Answer 1 or 2.")" == 2 ]]; then
                local crt key
                TLS_MODE=provided
                crt=$(ask "Certificate file (PEM, full chain)" "" readable_file "Cannot read that file.")
                key=$(ask "Private key file (PEM)" "" readable_file "Cannot read that file.")
                OPT_TLS_CERT=$(absolute_path "$crt")
                OPT_TLS_KEY=$(absolute_path "$key")
            else
                TLS_MODE=self-signed
            fi
        fi
    fi

    DOMAIN=${DOMAIN:-$default_domain}
    HTTP_PORT=${HTTP_PORT:-80}
    HTTPS_PORT=${HTTPS_PORT:-443}
    BIND=${BIND:-0.0.0.0}
    REDIRECT=${REDIRECT:-true}
    HSTS=${HSTS:-false}
    FONTS=${FONTS:-false}
    TLS_MODE=${TLS_MODE:-self-signed}
    IMAGE=$BUNDLE_IMAGE:$BUNDLE_VERSION

    valid_host "$DOMAIN" || die "Host name '$DOMAIN' is not valid. Use --domain, for example --domain mscd.example.co.id"
    valid_port "$HTTP_PORT" || die "HTTP port '$HTTP_PORT' is not a valid port"
    valid_port "$HTTPS_PORT" || die "HTTPS port '$HTTPS_PORT' is not a valid port"
    [[ $HTTP_PORT != "$HTTPS_PORT" ]] || die "HTTP and HTTPS need different ports"
    is_ipv4 "$BIND" || die "Bind address '$BIND' must be an IPv4 address such as 0.0.0.0"
    if [[ $TLS_MODE == self-signed && $HSTS == true ]]; then
        warn "HSTS is turned off: browsers would lock users out of a site with a self-signed certificate"
        HSTS=false
    fi
}

show_settings() {
    local redirect_text="serves the app"
    if [[ $INTERACTIVE == true ]]; then echo; fi
    [[ $REDIRECT == true ]] && redirect_text="redirects to HTTPS"
    printf '  %-20s %s\n' \
        "Install directory" "$INSTALL_DIR" \
        "Version" "$BUNDLE_VERSION ($IMAGE)" \
        "Host name" "$DOMAIN" \
        "Listen address" "$BIND" \
        "HTTP port" "$HTTP_PORT ($redirect_text)" \
        "HTTPS port" "$HTTPS_PORT" \
        "Certificate" "$TLS_MODE${OPT_TLS_CERT:+ ($OPT_TLS_CERT)}" \
        "HSTS" "$HSTS" \
        "External fonts" "$FONTS"
}

check_settings() {
    check_port "$HTTP_PORT" HTTP --http-port
    check_port "$HTTPS_PORT" HTTPS --https-port
    if [[ $TLS_MODE == provided && -n $OPT_TLS_CERT ]]; then
        validate_cert_pair "$OPT_TLS_CERT" "$OPT_TLS_KEY" "$DOMAIN"
    elif [[ $TLS_MODE == provided ]]; then
        if [[ ! -f $INSTALL_DIR/tls/tls.crt ]]; then
            fail "No certificate installed" "Pass --tls-cert and --tls-key, or --self-signed"
        elif ! is_pem_cert "$INSTALL_DIR/tls/tls.crt"; then
            fail "The installed certificate $INSTALL_DIR/tls/tls.crt is not in PEM format" \
                "Install a PEM certificate with --tls-cert and --tls-key"
        else
            pass "Keeping the installed certificate (valid until $(cert_end_date "$INSTALL_DIR/tls/tls.crt"))"
        fi
    fi
}

# ---------------------------------------------------------------------------
# Install steps
# ---------------------------------------------------------------------------
prepare_dir() {
    install -d -m 0755 "$INSTALL_DIR" "$INSTALL_DIR/lib" "$INSTALL_DIR/tls" "$INSTALL_DIR/backups"
    lock_dir "$INSTALL_DIR"
}

install_files() {
    install -m 0644 "$SCRIPT_DIR/compose/docker-compose.yml" "$INSTALL_DIR/docker-compose.yml"
    install -m 0644 "$SCRIPT_DIR/compose/.env.example" "$INSTALL_DIR/.env.example"
    install -m 0644 "$SCRIPT_DIR/lib/common.sh" "$INSTALL_DIR/lib/common.sh"
    install -m 0755 "$SCRIPT_DIR/upgrade.sh" "$SCRIPT_DIR/uninstall.sh" "$INSTALL_DIR/"
    install -m 0644 "$SCRIPT_DIR/VERSION" "$SCRIPT_DIR/INSTALL-ONPREM.md" "$INSTALL_DIR/"
    printf 'MSCD on-premise install directory. Do not delete this file.\n' >"$INSTALL_DIR/$MSCD_MARKER"
    pass "Files copied to $INSTALL_DIR"
}

# snapshot_config: keeps the current settings until the new ones are running.
snapshot_config() {
    SNAPSHOT=$INSTALL_DIR/.install-backup
    rm -rf -- "$SNAPSHOT"
    if [[ -f $INSTALL_DIR/.env ]]; then
        install -d -m 0700 "$SNAPSHOT"
        cp -p "$INSTALL_DIR/.env" "$SNAPSHOT/.env"
        if [[ -f $INSTALL_DIR/docker-compose.yml ]]; then
            cp -p "$INSTALL_DIR/docker-compose.yml" "$SNAPSHOT/docker-compose.yml"
        fi
    fi
}

write_env() {
    if [[ ! -f $ENV_FILE ]]; then
        install -m 0600 "$SCRIPT_DIR/compose/.env.example" "$ENV_FILE"
    else
        env_merge_defaults "$SCRIPT_DIR/compose/.env.example" "$ENV_FILE"
    fi
    env_set "$ENV_FILE" MSCD_VERSION "$BUNDLE_VERSION"
    env_set "$ENV_FILE" MSCD_IMAGE "$BUNDLE_IMAGE"
    env_set "$ENV_FILE" MSCD_DOMAIN "$DOMAIN"
    env_set "$ENV_FILE" MSCD_BIND_ADDRESS "$BIND"
    env_set "$ENV_FILE" MSCD_HTTP_PORT "$HTTP_PORT"
    env_set "$ENV_FILE" MSCD_HTTPS_PORT "$HTTPS_PORT"
    env_set "$ENV_FILE" MSCD_TLS_MODE "$TLS_MODE"
    env_set "$ENV_FILE" MSCD_HTTP_REDIRECT "$REDIRECT"
    env_set "$ENV_FILE" MSCD_HSTS "$HSTS"
    env_set "$ENV_FILE" MSCD_EXTERNAL_FONTS "$FONTS"
    env_set "$ENV_FILE" MSCD_RUN_UID "$RUN_UID"
    env_set "$ENV_FILE" MSCD_RUN_GID "$RUN_GID"
    pass "Settings saved to $ENV_FILE"
}

# prepare_tls: puts a new certificate and key (provided or self-signed) in
# tls.new and checks that NGINX loads them. The installed files are not touched.
prepare_tls() {
    local dir=$INSTALL_DIR/tls out
    TLS_STAGE=$INSTALL_DIR/tls.new
    TLS_CHANGED=false
    rm -rf -- "$TLS_STAGE"
    if [[ $TLS_MODE == provided && -n $OPT_TLS_CERT ]]; then
        if [[ -f $dir/tls.crt && -f $dir/tls.key ]] && cmp -s "$OPT_TLS_CERT" "$dir/tls.crt"; then
            pass "The installed certificate is the same as $OPT_TLS_CERT; kept"
            return 0
        fi
        install -d -m 0755 "$TLS_STAGE"
        install -m 0444 "$OPT_TLS_CERT" "$TLS_STAGE/tls.crt"
        install -m 0600 "$OPT_TLS_KEY" "$TLS_STAGE/tls.key"
    elif [[ $TLS_MODE == self-signed ]]; then
        if [[ $SAVED_TLS_MODE == self-signed && -f $dir/tls.key ]] &&
            self_signed_is_current "$dir/tls.crt" "$DOMAIN"; then
            pass "Keeping the self-signed certificate for $DOMAIN (valid until $(cert_end_date "$dir/tls.crt"))"
            return 0
        fi
        install -d -m 0755 "$TLS_STAGE"
        generate_self_signed "$TLS_STAGE/tls.crt" "$TLS_STAGE/tls.key" "$DOMAIN" ||
            die "openssl could not create the self-signed certificate"
        chmod 0444 "$TLS_STAGE/tls.crt"
        pass "Self-signed certificate created for $DOMAIN (valid until $(cert_end_date "$TLS_STAGE/tls.crt"))"
    else
        return 0
    fi

    set_key_owner "$TLS_STAGE/tls.key" "$IMAGE" "$RUN_UID" "$RUN_GID"
    if ! out=$(tls_config_test "$TLS_STAGE" "$IMAGE" "$RUN_UID" "$RUN_GID"); then
        printf '%s\n' "$out" | sed 's/^/        /'
        rm -rf -- "$TLS_STAGE" "$SNAPSHOT"
        fail "NGINX cannot load the new certificate and key" \
            "Check that both files are PEM and belong together, then run ./install.sh again"
        if [[ $PREVIOUS_STATE == missing ]]; then
            die "MSCD was not started."
        fi
        die "The certificate and settings were not changed; MSCD keeps its current configuration."
    fi
    pass "NGINX loads the new certificate and key (test run without network)"
    TLS_CHANGED=true
}

# activate_tls: moves the tested files in place. The previous pair is kept as
# tls.crt.bak and tls.key.bak.
activate_tls() {
    local dir=$INSTALL_DIR/tls
    if [[ $TLS_CHANGED == true ]]; then
        if [[ -f $dir/tls.crt && -f $dir/tls.key ]]; then
            mv -f "$dir/tls.crt" "$dir/tls.crt.bak"
            mv -f "$dir/tls.key" "$dir/tls.key.bak"
            TLS_BACKUP=true
        fi
        mv -f "$TLS_STAGE/tls.key" "$dir/tls.key"
        mv -f "$TLS_STAGE/tls.crt" "$dir/tls.crt"
        rmdir "$TLS_STAGE"
        if [[ $TLS_MODE == provided ]]; then pass "Certificate installed"; fi
    fi
    # The container user may have changed (for example after the mscd account was created).
    if [[ -f $dir/tls.key ]]; then
        set_key_owner "$dir/tls.key" "$IMAGE" "$RUN_UID" "$RUN_GID"
    fi
}

# restore_previous: puts back the settings and certificate that ran before this
# run, and starts that configuration again.
restore_previous() {
    local dir=$INSTALL_DIR/tls
    if [[ -f $SNAPSHOT/.env ]]; then
        cp -p "$SNAPSHOT/.env" "$INSTALL_DIR/.env"
    fi
    if [[ -f $SNAPSHOT/docker-compose.yml ]]; then
        cp -p "$SNAPSHOT/docker-compose.yml" "$INSTALL_DIR/docker-compose.yml"
    fi
    if [[ $TLS_BACKUP == true ]]; then
        mv -f "$dir/tls.crt.bak" "$dir/tls.crt"
        mv -f "$dir/tls.key.bak" "$dir/tls.key"
    fi
    compose_in "$INSTALL_DIR" up -d --remove-orphans --force-recreate --wait --wait-timeout "$TIMEOUT"
}

start_stack() {
    local args=(up -d --remove-orphans --wait --wait-timeout "$TIMEOUT")
    # A new certificate, or a container that is not healthy (for example stuck
    # restarting after a fix), gets a fresh container with a clean health state.
    if [[ $TLS_CHANGED == true ]] || [[ $PREVIOUS_STATE != healthy && $PREVIOUS_STATE != missing ]]; then
        args+=(--force-recreate)
    fi
    if compose_in "$INSTALL_DIR" "${args[@]}"; then
        pass "Container $MSCD_CONTAINER is running and healthy"
        return 0
    fi

    fail "MSCD did not become healthy with the new settings"
    show_logs "$MSCD_CONTAINER" 40
    if [[ $PREVIOUS_STATE == healthy && -f $SNAPSHOT/.env ]]; then
        step "Restoring the previous settings and certificate"
        if restore_previous; then
            pass "MSCD is running again with the previous settings"
            rm -rf -- "$SNAPSHOT"
            die "The new settings did not work and were not kept. Fix the problem shown above and run ./install.sh again."
        fi
        rm -rf -- "$SNAPSHOT"
        die "The previous settings did not start either. They are in $INSTALL_DIR/.env; see the troubleshooting table in INSTALL-ONPREM.md."
    fi
    rm -rf -- "$SNAPSHOT"
    die "Installation did not finish. Fix the problem shown above and run ./install.sh again (see: docker logs $MSCD_CONTAINER)."
}

print_done() {
    local url sudo
    url=$(public_url "$ENV_FILE")
    sudo=$(sudo_prefix)
    printf '\n%sMSCD %s is running.%s\n\n' "$C_GREEN$C_BOLD" "$BUNDLE_VERSION" "$C_RESET"
    printf '  %-13s %s\n' \
        "Open" "$url" \
        "Install dir" "$INSTALL_DIR" \
        "Status" "cd $INSTALL_DIR && docker compose ps" \
        "Logs" "docker logs $MSCD_CONTAINER" \
        "Uninstall" "$sudo$INSTALL_DIR/uninstall.sh"
    if [[ $TLS_MODE == self-signed ]]; then
        printf '\n  The certificate is self-signed, so browsers show a warning. Its SHA-256 fingerprint is\n'
        printf '  %s\n' "$(cert_fingerprint "$INSTALL_DIR/tls/tls.crt")"
        printf '  To use a certificate from your CA, run this again with --tls-cert and --tls-key.\n'
    fi
}

main() {
    parse_args "$@"
    BUNDLE_VERSION=$(tr -d '[:space:]' <"$SCRIPT_DIR/VERSION")
    BUNDLE_IMAGE=$(kv_get "$SCRIPT_DIR/BUNDLE-INFO" IMAGE)
    BUNDLE_IMAGE=${BUNDLE_IMAGE:-$MSCD_DEFAULT_IMAGE}
    INSTALL_DIR=$(absolute_path "${OPT_DIR:-$MSCD_DEFAULT_DIR}")
    [[ $INSTALL_DIR != / ]] || die "The install directory cannot be /"
    [[ $INSTALL_DIR != "$SCRIPT_DIR" ]] || die "Install into a directory other than the bundle directory"

    INTERACTIVE=false
    if [[ $ASSUME_YES == false ]]; then
        have_terminal ||
            die "No terminal for the installer questions. Add --yes to install with flags, saved settings and defaults."
        INTERACTIVE=true
    fi

    title "MSCD on-premise installer, version $BUNDLE_VERSION"

    step "Checking this host"
    check_privileges
    check_docker
    check_resources "$INSTALL_DIR"
    check_install_dir "$INSTALL_DIR"
    check_container_owner "$INSTALL_DIR"
    check_tool openssl "needed for certificates"
    if ! command -v curl >/dev/null 2>&1; then
        warn "curl is not installed; the final checks through the published ports will be skipped"
    fi
    abort_if_failed

    step "Checking the bundle"
    verify_checksums "$SCRIPT_DIR"
    if [[ $INTERACTIVE == true && -z $VERIFY_KEY && $SKIP_SIGNATURE == false && -z $(find_public_key "$SCRIPT_DIR") ]]; then
        VERIFY_KEY=$(ask_public_key "$SCRIPT_DIR")
    fi
    verify_signature "$SCRIPT_DIR" "$VERIFY_KEY" "$SKIP_SIGNATURE"
    check_arch "$(kv_get "$SCRIPT_DIR/BUNDLE-INFO" IMAGE_ARCH)"
    abort_if_failed

    step "Settings"
    resolve_settings
    show_settings

    step "Checking settings"
    check_settings
    abort_if_failed

    if [[ $INTERACTIVE == true ]] && ! confirm "Install MSCD $BUNDLE_VERSION with these settings?"; then
        echo "Cancelled. Nothing was changed."
        exit 0
    fi

    PREVIOUS_STATE=$(container_state "$MSCD_CONTAINER")
    TLS_BACKUP=false

    step "Installing"
    load_image "$SCRIPT_DIR/$(kv_get "$SCRIPT_DIR/BUNDLE-INFO" IMAGE_FILE)" "$IMAGE" \
        "$(kv_get "$SCRIPT_DIR/BUNDLE-INFO" IMAGE_LAYERS)"
    resolve_run_ids
    prepare_dir
    snapshot_config
    install_files
    prepare_tls
    write_env
    activate_tls
    start_stack

    step "Verifying"
    rm -rf -- "$SNAPSHOT"
    if ! verify_endpoints "$ENV_FILE"; then
        show_logs "$MSCD_CONTAINER" 20
        die "MSCD is running but not reachable as expected. See the troubleshooting table in INSTALL-ONPREM.md."
    fi

    print_done
}

main "$@"
exit 0
