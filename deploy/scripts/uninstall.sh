#!/usr/bin/env bash
# MSCD on-premise uninstaller (Docker Compose).
#
#   sudo /opt/mscd/uninstall.sh           stop and remove the MSCD containers and networks;
#                                         keep the data volumes, settings, secrets,
#                                         certificates and images
#   sudo /opt/mscd/uninstall.sh --purge   also delete the data volumes (database, object
#                                         store, queue), the install directory with its
#                                         secrets, and the MSCD images
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh disable=SC1091  # followed with shellcheck -x
. "$SCRIPT_DIR/lib/common.sh"

usage() {
    cat <<'EOF'
Usage: sudo ./uninstall.sh [options]

Stops and removes the MSCD containers and their networks. The data volumes
(database, object store, queue), settings, secrets, certificates and images are
kept, so "docker compose up -d" in the install directory, or install.sh, brings
MSCD back with its data.

Options:
  --dir DIR    Install directory (default: the directory of this script, or /opt/mscd)
  --purge      Also delete the data volumes (all MSCD data), the install directory
               (settings, secrets, certificates, backups) and the MSCD images.
               This cannot be undone.
  -y, --yes    Do not ask for confirmation. Required when there is no terminal.
  -h, --help   Show this help
EOF
}

OPT_DIR='' PURGE=false

# shellcheck disable=SC2034  # ASSUME_YES is read by confirm() in lib/common.sh
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

# project_volumes: data volumes of the MSCD Compose project.
project_volumes() {
    docker volume ls -q --filter "label=com.docker.compose.project=$MSCD_PROJECT" 2>/dev/null || true
}

# project_networks: networks of the MSCD Compose project.
project_networks() {
    docker network ls -q --filter "label=com.docker.compose.project=$MSCD_PROJECT" 2>/dev/null || true
}

main() {
    local installed=false containers=false other_owner="" owner images=() volumes=() repo ids=() nets=()
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
    # The containers are removed only when they belong to this directory, or to
    # no MSCD installation at all. Another installation's containers are left alone.
    owner=$(mscd_container_dir)
    if [[ -n $owner ]]; then
        if [[ $owner == "$INSTALL_DIR" || $owner == unknown || ! -f $owner/$MSCD_MARKER ]]; then
            containers=true
        else
            other_owner=$owner
            info "The running MSCD containers belong to the installation in $other_owner; they are left alone"
        fi
    fi
    if [[ -z $other_owner ]]; then
        mapfile -t volumes < <(project_volumes)
        for repo in "$(kv_get "$INSTALL_DIR/.env" MSCD_IMAGE)" "$(kv_get "$INSTALL_DIR/.env" MSCD_SERVER_IMAGE)" \
            "$MSCD_DEFAULT_IMAGE" "$MSCD_DEFAULT_SERVER_IMAGE"; do
            [[ -n $repo ]] || continue
            mapfile -t -O "${#images[@]}" images < <(docker image ls --format '{{.Repository}}:{{.Tag}}' "$repo" 2>/dev/null |
                grep -v ':<none>$' || true)
        done
        if ((${#images[@]} > 0)); then
            mapfile -t images < <(printf '%s\n' "${images[@]}" | sort -u)
        fi
    fi

    if [[ $installed == false && $containers == false ]] &&
        { [[ $PURGE == false ]] || ((${#images[@]} == 0 && ${#volumes[@]} == 0)); }; then
        pass "MSCD is not installed in $INSTALL_DIR and no MSCD container exists. Nothing to remove."
        return 0
    fi

    echo
    echo "  This will:"
    if [[ $containers == true ]]; then
        echo "    - stop and remove the MSCD containers and their networks"
    fi
    if [[ $PURGE == true ]]; then
        if ((${#volumes[@]} > 0)); then
            printf '    - %sDELETE ALL MSCD DATA%s: the volumes %s\n' "$C_RED$C_BOLD" "$C_RESET" "${volumes[*]}"
        fi
        if [[ $installed == true ]]; then
            echo "    - delete $INSTALL_DIR (settings, secrets, certificates, backups)"
        fi
        if [[ -z $other_owner ]]; then
            if [[ $EUID -eq 0 ]] && [[ "$(getent passwd "$MSCD_ACCOUNT" | cut -d: -f5)" == "$MSCD_ACCOUNT_COMMENT" ]]; then
                echo "    - remove the $MSCD_ACCOUNT system account created by install.sh"
            fi
            if ((${#images[@]} > 0)); then
                echo "    - delete the images: ${images[*]}"
            fi
        else
            echo "    - keep the MSCD images, volumes and the $MSCD_ACCOUNT account (used by $other_owner)"
        fi
    else
        echo "    - keep the data volumes, $INSTALL_DIR and the MSCD images (use --purge to delete them)"
    fi
    echo
    confirm "Continue?" || die "Cancelled. Nothing was changed."
    if [[ $installed == true ]]; then lock_dir "$INSTALL_DIR"; fi

    step "Removing"
    if [[ $containers == true ]]; then
        if [[ $installed == true && -f $INSTALL_DIR/docker-compose.yml && -r $INSTALL_DIR/.env ]] &&
            compose_in "$INSTALL_DIR" --profile '*' down --remove-orphans; then
            :
        else
            mapfile -t ids < <(project_containers)
            if ((${#ids[@]} > 0)); then docker rm -f "${ids[@]}" >/dev/null; fi
            docker rm -f "$MSCD_CONTAINER" >/dev/null 2>&1 || true
        fi
        mapfile -t nets < <(project_networks)
        if ((${#nets[@]} > 0)); then docker network rm "${nets[@]}" >/dev/null 2>&1 || true; fi
    fi
    docker rm -f "$MSCD_CANARY" >/dev/null 2>&1 || true
    if [[ $containers == true ]]; then
        pass "Containers and networks removed"
    fi

    if [[ $PURGE == true ]]; then
        if [[ -n $other_owner ]]; then
            images=()
            volumes=()
        fi
        if ((${#volumes[@]} > 0)); then
            docker volume rm "${volumes[@]}" >/dev/null
            pass "Data volumes removed: ${volumes[*]}"
        fi
        if ((${#images[@]} > 0)); then
            docker image rm "${images[@]}" >/dev/null
            pass "Images removed: ${images[*]}"
        fi
        if [[ $installed == true ]]; then
            rm -rf -- "$INSTALL_DIR"
            pass "Deleted $INSTALL_DIR (settings and secrets)"
        fi
        if [[ -z $other_owner && $EUID -eq 0 ]] &&
            [[ "$(getent passwd "$MSCD_ACCOUNT" | cut -d: -f5)" == "$MSCD_ACCOUNT_COMMENT" ]]; then
            userdel "$MSCD_ACCOUNT" >/dev/null 2>&1 || true
            groupdel "$MSCD_ACCOUNT" >/dev/null 2>&1 || true
            pass "Removed system account $MSCD_ACCOUNT"
        fi
        printf '\n%sMSCD is removed from this host.%s\n' "$C_GREEN$C_BOLD" "$C_RESET"
        printf '  The third-party images (postgres, chrislusf/seaweedfs, valkey/valkey) are kept;\n'
        printf '  remove them with docker image rm when nothing else uses them.\n'
    else
        printf '\n%sMSCD is stopped and its containers removed. The data is kept.%s\n' "$C_GREEN$C_BOLD" "$C_RESET"
        printf '  Start it again: cd %s && docker compose up -d\n' "$INSTALL_DIR"
        printf '  Remove everything, data included: %s%s/uninstall.sh --purge\n' "$(sudo_prefix)" "$INSTALL_DIR"
    fi
}

main "$@"
exit 0
