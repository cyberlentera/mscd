#!/usr/bin/env bash
# MSCD on-premise uninstaller (Docker Compose).
#
#   sudo /opt/mscd/uninstall.sh           stop and remove the MSCD container and network;
#                                         keep settings, certificates and images
#   sudo /opt/mscd/uninstall.sh --purge   also delete the install directory and the MSCD images
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

usage() {
    cat <<'EOF'
Usage: sudo ./uninstall.sh [options]

Stops and removes the MSCD container and its network. Settings, certificates
and images are kept, so "docker compose up -d" in the install directory, or
install.sh, brings MSCD back.

Options:
  --dir DIR    Install directory (default: the directory of this script, or /opt/mscd)
  --purge      Also delete the install directory (settings, certificates,
               backups) and all MSCD images. This cannot be undone.
  -y, --yes    Do not ask for confirmation. Required when there is no terminal.
  -h, --help   Show this help
EOF
}

OPT_DIR='' PURGE=false

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dir) [[ $# -ge 2 ]] || die "--dir needs a value"; OPT_DIR=$2; shift 2 ;;
            --purge) PURGE=true; shift ;;
            -y | --yes) ASSUME_YES=true; shift ;;
            -h | --help) usage; exit 0 ;;
            *) die "Unknown option: $1. See ./uninstall.sh --help" ;;
        esac
    done
    require_terminal_or_yes
}

main() {
    local installed=false container=false other_owner='' owner images=() image_repo
    parse_args "$@"
    INSTALL_DIR=$(absolute_path "${OPT_DIR:-$(default_install_dir)}")
    [[ $INSTALL_DIR != / ]] || die "The install directory cannot be /"

    title "MSCD uninstall"
    step "Checking"
    check_privileges
    check_docker
    abort_if_failed

    [[ -f $INSTALL_DIR/$MSCD_MARKER ]] && installed=true
    if [[ $installed == true ]] && [[ ! -w $INSTALL_DIR || (-e $INSTALL_DIR/.env && ! -r $INSTALL_DIR/.env) ]]; then
        fail "User $(id -un) cannot change the MSCD installation in $INSTALL_DIR (it was installed with sudo)" \
            "Run the script with sudo"
        abort_if_failed
    fi
    # The container is removed only when it belongs to this directory, or to no
    # MSCD installation at all. Another installation's container is left alone.
    owner=$(mscd_container_dir)
    if [[ -n $owner ]]; then
        if [[ $owner == "$INSTALL_DIR" || $owner == unknown || ! -f $owner/$MSCD_MARKER ]]; then
            container=true
        else
            other_owner=$owner
            info "The running $MSCD_CONTAINER container belongs to the installation in $other_owner; it is left alone"
        fi
    fi
    image_repo=$(kv_get "$INSTALL_DIR/.env" MSCD_IMAGE)
    image_repo=${image_repo:-$MSCD_DEFAULT_IMAGE}
    mapfile -t images < <(docker image ls --format '{{.Repository}}:{{.Tag}}' "$image_repo" 2>/dev/null | grep -v ':<none>$' || true)

    if [[ $installed == false && $container == false ]] && { [[ $PURGE == false ]] || ((${#images[@]} == 0)); }; then
        pass "MSCD is not installed in $INSTALL_DIR and no MSCD container exists. Nothing to remove."
        return 0
    fi

    echo
    echo "  This will:"
    if [[ $container == true ]]; then
        echo "    - stop and remove the $MSCD_CONTAINER container and its network"
    fi
    if [[ $PURGE == true ]]; then
        if [[ $installed == true ]]; then
            echo "    - delete $INSTALL_DIR (settings, certificates, backups)"
        fi
        if [[ -z $other_owner ]]; then
            if [[ $EUID -eq 0 ]] && [[ "$(getent passwd "$MSCD_ACCOUNT" | cut -d: -f5)" == "$MSCD_ACCOUNT_COMMENT" ]]; then
                echo "    - remove the $MSCD_ACCOUNT system account created by install.sh"
            fi
            if ((${#images[@]} > 0)); then
                echo "    - delete the images: ${images[*]}"
            fi
        else
            echo "    - keep the MSCD images and the $MSCD_ACCOUNT account (used by $other_owner)"
        fi
    else
        echo "    - keep $INSTALL_DIR and the MSCD images (use --purge to delete them)"
    fi
    echo
    confirm "Continue?" || die "Cancelled. Nothing was changed."
    if [[ $installed == true ]]; then lock_dir "$INSTALL_DIR"; fi

    step "Removing"
    if [[ $container == true && $installed == true && -f $INSTALL_DIR/docker-compose.yml && -r $INSTALL_DIR/.env ]]; then
        compose_in "$INSTALL_DIR" down --remove-orphans
    elif [[ $container == true ]]; then
        docker rm -f "$MSCD_CONTAINER" >/dev/null
        docker network rm mscd_default >/dev/null 2>&1 || true
    fi
    docker rm -f "$MSCD_CANARY" >/dev/null 2>&1 || true
    if [[ $container == true ]]; then
        pass "Container and network removed"
    fi

    if [[ $PURGE == true ]]; then
        if [[ -n $other_owner ]]; then
            images=()
        fi
        if ((${#images[@]} > 0)); then
            docker image rm "${images[@]}" >/dev/null
            pass "Images removed: ${images[*]}"
        fi
        if [[ $installed == true ]]; then
            rm -rf -- "$INSTALL_DIR"
            pass "Deleted $INSTALL_DIR"
        fi
        if [[ -z $other_owner && $EUID -eq 0 ]] &&
            [[ "$(getent passwd "$MSCD_ACCOUNT" | cut -d: -f5)" == "$MSCD_ACCOUNT_COMMENT" ]]; then
            userdel "$MSCD_ACCOUNT" >/dev/null 2>&1 || true
            groupdel "$MSCD_ACCOUNT" >/dev/null 2>&1 || true
            pass "Removed system account $MSCD_ACCOUNT"
        fi
        printf '\n%sMSCD is removed from this host.%s\n' "$C_GREEN$C_BOLD" "$C_RESET"
    else
        printf '\n%sMSCD is stopped and its container removed.%s\n' "$C_GREEN$C_BOLD" "$C_RESET"
        printf '  Start it again: cd %s && docker compose up -d\n' "$INSTALL_DIR"
        printf '  Remove everything: %s%s/uninstall.sh --purge\n' "$(sudo_prefix)" "$INSTALL_DIR"
    fi
}

main "$@"
exit 0
