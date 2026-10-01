# shellcheck shell=bash
# MSCD on-premise: helpers shared by install.sh, upgrade.sh and uninstall.sh.
# This file is sourced, not executed.

readonly MSCD_CONTAINER=mscd-web
# shellcheck disable=SC2034  # used by the scripts that source this file
readonly MSCD_CANARY=mscd-web-canary
readonly MSCD_DEFAULT_DIR=/opt/mscd
# shellcheck disable=SC2034  # used by the scripts that source this file
readonly MSCD_DEFAULT_IMAGE=cyberlentera/mscd-web
readonly MSCD_MARKER=.mscd-install
readonly MSCD_PUBLIC_KEY=mscd-release.pub   # looked for next to the bundle directory
readonly MSCD_ACCOUNT=mscd         # host system account the container runs as
readonly MSCD_ACCOUNT_COMMENT="MSCD container user"
readonly MSCD_IMAGE_UID=101        # image default user
readonly MSCD_MIN_DOCKER=24.0
readonly MSCD_MIN_COMPOSE=2.20
readonly MSCD_MIN_RAM_MB=900       # a "1 GB" server reports a little less than 1024 MB
readonly MSCD_MIN_DOCKER_DISK_MB=2048
readonly MSCD_MIN_DIR_DISK_MB=100

FAILURES=0
ASSUME_YES=false

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
if [[ -t 1 && -z ${NO_COLOR:-} ]]; then
    C_RED=$'\033[31m' C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m' C_BLUE=$'\033[36m'
    C_BOLD=$'\033[1m' C_RESET=$'\033[0m'
else
    C_RED='' C_GREEN='' C_YELLOW='' C_BLUE='' C_BOLD='' C_RESET=''
fi

title() { printf '%s%s%s\n' "$C_BOLD" "$*" "$C_RESET"; }
step() { printf '\n%s==> %s%s\n' "$C_BOLD" "$*" "$C_RESET"; }
pass() { printf '  %sPASS%s  %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '  %sWARN%s  %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
info() { printf '  %sINFO%s  %s\n' "$C_BLUE" "$C_RESET" "$*"; }
detail() { printf '        %s\n' "$*"; }

# fail MESSAGE [FIX]
fail() {
    printf '  %sFAIL%s  %s\n' "$C_RED" "$C_RESET" "$1"
    if [[ -n ${2:-} ]]; then
        printf '        Fix: %s\n' "$2"
    fi
    FAILURES=$((FAILURES + 1))
}

die() {
    printf '\n%sERROR%s %s\n' "$C_RED" "$C_RESET" "$*" >&2
    exit 1
}

# Stop after a group of checks when any of them failed.
abort_if_failed() {
    if ((FAILURES > 0)); then
        printf '\n%s%d check(s) failed.%s Fix the items above and run %s again. Nothing was changed.\n' \
            "$C_RED" "$FAILURES" "$C_RESET" "$(basename "$0")"
        exit 1
    fi
}

# have_terminal: true when questions can be asked on a terminal.
have_terminal() {
    [[ -t 0 ]] && { : </dev/tty; } 2>/dev/null
}

# require_terminal_or_yes: without a terminal, every script needs --yes.
require_terminal_or_yes() {
    if [[ $ASSUME_YES == false ]] && ! have_terminal; then
        die "No terminal for the confirmation questions. Add --yes to run without them."
    fi
}

# confirm QUESTION: true when the user answers yes (always true with --yes).
confirm() {
    local answer
    if [[ $ASSUME_YES == true ]]; then
        return 0
    fi
    read -r -p "$1 [y/N] " answer </dev/tty || return 1
    [[ $answer =~ ^[Yy]([Ee][Ss])?$ ]]
}

# sudo_prefix: "sudo " when the script runs as root, for the commands it prints.
sudo_prefix() {
    if [[ $EUID -eq 0 ]]; then echo "sudo "; fi
}

# ---------------------------------------------------------------------------
# Small utilities
# ---------------------------------------------------------------------------

# version_ge A B: true when version A is B or later.
version_ge() {
    [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" == "$2" ]]
}

valid_port() {
    [[ $1 =~ ^[0-9]{1,5}$ ]] && (($1 >= 1 && $1 <= 65535))
}

valid_host() {
    [[ $1 =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$ ]]
}

is_ipv4() {
    [[ $1 =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]
}

# to_bool VALUE: prints true or false, or fails for anything else.
to_bool() {
    case "${1,,}" in
        true | on | yes | 1) echo true ;;
        false | off | no | 0) echo false ;;
        *) return 1 ;;
    esac
}

host_arch() {
    case "$(uname -m)" in
        x86_64 | amd64) echo amd64 ;;
        aarch64 | arm64) echo arm64 ;;
        *) uname -m ;;
    esac
}

# default_install_dir: the directory of the calling script when it lives in an
# MSCD install directory, otherwise /opt/mscd.
default_install_dir() {
    if [[ -f $SCRIPT_DIR/$MSCD_MARKER ]]; then
        echo "$SCRIPT_DIR"
    else
        echo "$MSCD_DEFAULT_DIR"
    fi
}

absolute_path() {
    realpath -m -- "$1"
}

# lock_dir DIR: one install, upgrade or uninstall at a time per directory.
lock_dir() {
    if command -v flock >/dev/null 2>&1 && [[ -d $1 ]]; then
        exec 9<"$1"
        flock -n 9 || die "Another MSCD install, upgrade or uninstall is running on $1."
    fi
}

# ---------------------------------------------------------------------------
# Settings files (.env and BUNDLE-INFO use KEY=value lines)
# ---------------------------------------------------------------------------

# kv_get FILE KEY: prints the value of KEY (empty when missing or unreadable).
kv_get() {
    if [[ -f $1 && -r $1 ]]; then
        sed -n "s/^$2=//p" "$1" | tail -n1
    fi
}

# env_set FILE KEY VALUE: replaces or appends KEY=VALUE, keeping comments.
env_set() {
    local file=$1 key=$2 value=$3 tmp
    tmp=$(mktemp "$file.XXXXXX")
    if grep -q "^$key=" "$file"; then
        KEY=$key VALUE=$value awk 'BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VALUE"] }
            index($0, k "=") == 1 { print k "=" v; next } { print }' "$file" >"$tmp"
    else
        cat "$file" >"$tmp"
        printf '%s=%s\n' "$key" "$value" >>"$tmp"
    fi
    chmod 0600 "$tmp"
    mv -f "$tmp" "$file"
}

# env_merge_defaults EXAMPLE ENV: adds settings that are new in EXAMPLE.
env_merge_defaults() {
    local example=$1 env=$2 line key
    while IFS= read -r line; do
        [[ $line =~ ^([A-Z0-9_]+)= ]] || continue
        key=${BASH_REMATCH[1]}
        if ! grep -q "^$key=" "$env"; then
            printf '%s\n' "$line" >>"$env"
            info "New setting $key added with its default value"
        fi
    done <"$example"
}

# ---------------------------------------------------------------------------
# Host checks
# ---------------------------------------------------------------------------
DOCKER_OK=false

check_privileges() {
    if [[ $EUID -eq 0 ]]; then
        pass "Running as root"
    elif id -nG 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
        pass "User $(id -un) is in the docker group"
    else
        fail "Not running as root or as a member of the docker group" \
            "Run the script with sudo, or add this user to the docker group"
    fi
}

check_docker() {
    local server compose
    if ! command -v docker >/dev/null 2>&1; then
        fail "Docker is not installed" "Install Docker Engine $MSCD_MIN_DOCKER or later with the Compose plugin"
        return 0
    fi
    if ! server=$(docker version --format '{{.Server.Version}}' 2>/dev/null) || [[ -z $server ]]; then
        fail "Cannot reach the Docker daemon" \
            "Start Docker (systemctl enable --now docker) and run as root or a docker group member"
        return 0
    fi
    server=${server%%[-+~]*}
    if version_ge "$server" "$MSCD_MIN_DOCKER"; then
        pass "Docker Engine $server ($MSCD_MIN_DOCKER or later)"
    else
        fail "Docker Engine $server is older than $MSCD_MIN_DOCKER" "Upgrade Docker Engine"
        return 0
    fi
    if ! compose=$(docker compose version --short 2>/dev/null) || [[ -z $compose ]]; then
        fail "Docker Compose plugin not found" "Install the docker-compose-plugin package"
        return 0
    fi
    compose=${compose#v}
    compose=${compose%%[-+]*}
    if version_ge "$compose" "$MSCD_MIN_COMPOSE"; then
        pass "Docker Compose $compose ($MSCD_MIN_COMPOSE or later)"
        DOCKER_OK=true
    else
        fail "Docker Compose $compose is older than $MSCD_MIN_COMPOSE" "Upgrade the docker-compose-plugin package"
    fi
}

docker_is_rootless() {
    [[ $DOCKER_OK == true ]] &&
        docker info --format '{{.SecurityOptions}}' 2>/dev/null | grep -q rootless
}

# check_disk PATH LABEL MIN_MB
check_disk() {
    local path=$1 label=$2 min=$3 free
    while [[ ! -d $path ]]; do path=$(dirname -- "$path"); done
    free=$(df -Pm -- "$path" 2>/dev/null | awk 'NR == 2 { print $4 }')
    if [[ -z $free ]]; then
        warn "Could not read free disk space for $label ($path)"
    elif ((free >= min)); then
        pass "Disk: $free MB free for $label (needs $min MB)"
    else
        fail "Disk: only $free MB free for $label ($path), needs $min MB" "Free up space or add a larger disk"
    fi
}

# check_resources INSTALL_DIR
check_resources() {
    local dir=$1 total_kb avail_kb total_mb avail_mb cpus docker_root
    total_kb=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo 2>/dev/null || true)
    avail_kb=$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo 2>/dev/null || true)
    total_mb=$((${total_kb:-0} / 1024))
    avail_mb=$((${avail_kb:-0} / 1024))
    if ((total_mb >= MSCD_MIN_RAM_MB)); then
        pass "Memory: $total_mb MB total, $avail_mb MB available (needs $MSCD_MIN_RAM_MB MB)"
    else
        fail "Memory: $total_mb MB total, needs $MSCD_MIN_RAM_MB MB" "Run on a host with more memory"
    fi

    docker_root=/var/lib/docker
    if [[ $DOCKER_OK == true ]]; then
        docker_root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)
    fi
    check_disk "$docker_root" "Docker data ($docker_root)" "$MSCD_MIN_DOCKER_DISK_MB"
    check_disk "$dir" "the install directory ($dir)" "$MSCD_MIN_DIR_DISK_MB"

    cpus=$(nproc 2>/dev/null || echo 1)
    info "This host: $cpus vCPU, $((total_mb / 1024)) GB RAM. The full MSCD platform (Small profile)"
    detail "will need 8 vCPU, 32 GB RAM and 500 GB SSD. See INSTALL-ONPREM.md, System requirements."
}

# check_install_dir DIR: this user can create DIR, or change the installation in it.
check_install_dir() {
    local dir=$1 parent=$1 who
    who=$(id -un 2>/dev/null || echo "uid $EUID")
    if [[ -e $dir && ! -d $dir ]]; then
        fail "$dir exists and is not a directory" "Choose another directory with --dir"
        return 0
    fi
    if [[ -d $dir ]]; then
        if [[ ! -w $dir ]] || [[ -e $dir/.env && (! -r $dir/.env || ! -w $dir/.env) ]] ||
            [[ -d $dir/tls && ! -w $dir/tls ]]; then
            if [[ -f $dir/$MSCD_MARKER ]]; then
                fail "User $who cannot change the MSCD installation in $dir (it was installed with sudo)" \
                    "Run the script with sudo"
            else
                fail "User $who cannot write to $dir" "Run the script with sudo, or pass --dir ~/mscd"
            fi
            return 0
        fi
        pass "Install directory $dir is writable"
        return 0
    fi
    while [[ ! -d $parent ]]; do parent=$(dirname -- "$parent"); done
    if [[ -w $parent ]]; then
        pass "Install directory $dir can be created"
    else
        fail "User $who cannot create $dir (no write access to $parent)" \
            "Run the script with sudo, or pass --dir ~/mscd"
    fi
}

# mscd_container_dir: install directory of the existing mscd-web container.
# Prints nothing when there is no such container, "unknown" when it was not
# created by Docker Compose.
mscd_container_dir() {
    local dir
    docker container inspect "$MSCD_CONTAINER" >/dev/null 2>&1 || return 0
    dir=$(docker container inspect \
        --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' \
        "$MSCD_CONTAINER" 2>/dev/null || true)
    if [[ -n $dir ]]; then
        absolute_path "$dir"
    else
        echo unknown
    fi
}

# check_container_owner DIR: the mscd-web container, if any, belongs to DIR.
# Only one MSCD installation can run on a Docker host.
check_container_owner() {
    local dir=$1 owner
    [[ $DOCKER_OK == true ]] || return 0
    owner=$(mscd_container_dir)
    if [[ -z $owner || $owner == "$dir" ]]; then
        return 0
    fi
    if [[ $owner == unknown ]]; then
        fail "A container named $MSCD_CONTAINER exists that install.sh did not create" \
            "Remove it (docker rm -f $MSCD_CONTAINER) and run the script again"
    elif [[ -f $owner/$MSCD_MARKER ]]; then
        fail "MSCD is already installed in $owner" \
            "Use --dir $owner, or remove that installation first: $(sudo_prefix)$owner/uninstall.sh"
    else
        fail "The $MSCD_CONTAINER container belongs to $owner, which is no longer an MSCD install directory" \
            "Remove the container (docker rm -f $MSCD_CONTAINER) and run the script again"
    fi
}

check_arch() {
    local want=$1 have
    have=$(host_arch)
    if [[ -z $want || $want == "$have" ]]; then
        pass "CPU architecture $have matches the image"
    else
        fail "This host is $have but the bundle image is $want" "Use the $have bundle"
    fi
}

check_tool() {
    local tool=$1 why=$2
    if command -v "$tool" >/dev/null 2>&1; then
        pass "$tool is available"
        return 0
    fi
    fail "$tool is not installed ($why)" "Install $tool with the package manager"
}

# ---------------------------------------------------------------------------
# Bundle integrity
# ---------------------------------------------------------------------------

# verify_checksums BUNDLE_DIR
verify_checksums() {
    local dir=$1 out count bad
    if [[ ! -f $dir/SHA256SUMS ]]; then
        fail "SHA256SUMS is missing from $dir" "Extract the complete bundle again"
        return 0
    fi
    count=$(grep -c . "$dir/SHA256SUMS" || true)
    if out=$(cd "$dir" && sha256sum --check --strict --quiet SHA256SUMS 2>&1); then
        pass "Checksums match for all $count files in the bundle"
    else
        bad=$(printf '%s\n' "$out" | sed -n 's/: FAILED.*$//p' | paste -sd ' ' -)
        fail "Checksum mismatch: ${bad:-see sha256sum output}" \
            "Copy the bundle again and compare it with the published .sha256 file"
    fi
}

# find_public_key BUNDLE_DIR: prints the path of mscd-release.pub next to the
# bundle directory (where it is delivered), or nothing.
find_public_key() {
    local key
    key=$(absolute_path "$1/../$MSCD_PUBLIC_KEY")
    if [[ -f $key ]]; then echo "$key"; fi
}

# valid_public_key FILE: a readable PEM public key.
valid_public_key() {
    [[ -f $1 && -r $1 ]] && openssl pkey -pubin -in "$1" -noout >/dev/null 2>&1
}

# ask_public_key BUNDLE_DIR: on a terminal, asks for the public key of a signed
# bundle when none was given or found. Prints the path, or nothing.
ask_public_key() {
    local dir=$1 answer
    [[ -f $dir/SHA256SUMS.sig ]] || return 0
    printf '  The bundle is signed. CyberLentera delivers the public key %s with it.\n' "$MSCD_PUBLIC_KEY" >&2
    while true; do
        read -r -p "  Path to $MSCD_PUBLIC_KEY (empty to stop): " answer </dev/tty || return 0
        [[ -n $answer ]] || return 0
        answer=$(absolute_path "$answer")
        if valid_public_key "$answer"; then
            echo "$answer"
            return 0
        fi
        printf '  Cannot read a public key from %s. Try again.\n' "$answer" >&2
    done
}

# verify_signature BUNDLE_DIR KEY SKIP
# KEY: public key from --verify-key, or empty to use mscd-release.pub next to
# the bundle directory. SKIP: true when --skip-signature-check was given.
verify_signature() {
    local dir=$1 key=${2:-} skip=${3:-false} found=false
    if [[ -z $key ]]; then
        key=$(find_public_key "$dir")
        if [[ -n $key ]]; then found=true; fi
    fi

    if [[ ! -f $dir/SHA256SUMS.sig ]]; then
        if [[ $found == true ]]; then
            fail "$key was found next to the bundle, but the bundle has no signature (SHA256SUMS.sig)" \
                "Use the signed bundle from CyberLentera. For an unsigned test bundle, move $MSCD_PUBLIC_KEY away."
        elif [[ -n $key ]]; then
            fail "--verify-key was given but the bundle has no signature (SHA256SUMS.sig)" \
                "Use the signed bundle from CyberLentera"
        else
            info "The bundle is not signed; only the checksums were checked"
        fi
        return 0
    fi

    if [[ -z $key ]]; then
        if [[ $skip == true ]]; then
            warn "Bundle signature not checked (--skip-signature-check)"
        else
            fail "The bundle is signed, but there is no public key to check it with" \
                "Put $MSCD_PUBLIC_KEY next to the bundle directory, or pass --verify-key FILE"
        fi
        return 0
    fi
    if ! command -v openssl >/dev/null 2>&1; then
        fail "openssl is needed to check the signature" "Install openssl"
        return 0
    fi
    if ! valid_public_key "$key"; then
        fail "Cannot read public key file $key" \
            "Check the path given to --verify-key. It must be the PEM file $MSCD_PUBLIC_KEY from CyberLentera."
        return 0
    fi
    if openssl dgst -sha256 -verify "$key" -signature "$dir/SHA256SUMS.sig" "$dir/SHA256SUMS" >/dev/null 2>&1; then
        pass "Bundle signature is valid ($key)"
    else
        fail "Bundle signature does not match $key" "Do not install this bundle. Contact CyberLentera support."
    fi
}

# ---------------------------------------------------------------------------
# Ports
# ---------------------------------------------------------------------------

host_port_listening() {
    local port=$1 hex files=()
    if command -v ss >/dev/null 2>&1; then
        [[ -n $(ss -Hltn "sport = :$port" 2>/dev/null) ]]
        return
    fi
    printf -v hex ':%04X' "$port"
    [[ -r /proc/net/tcp ]] && files+=(/proc/net/tcp)
    [[ -r /proc/net/tcp6 ]] && files+=(/proc/net/tcp6)
    ((${#files[@]} > 0)) || return 1
    awk -v p="$hex" 'FNR > 1 && $4 == "0A" && substr($2, length($2) - 4) == p { found = 1 }
        END { exit !found }' "${files[@]}"
}

# port_owner PORT: prints mscd, container:<name>, other, or nothing when free.
port_owner() {
    local port=$1 line
    if [[ $DOCKER_OK == true ]]; then
        while IFS= read -r line; do
            if [[ $line =~ :$port-\> ]]; then
                if [[ ${line%% *} == "$MSCD_CONTAINER" ]]; then
                    echo mscd
                else
                    echo "container:${line%% *}"
                fi
                return 0
            fi
        done < <(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null)
    fi
    if host_port_listening "$port"; then
        echo other
    fi
}

# check_port PORT LABEL FLAG
check_port() {
    local port=$1 label=$2 flag=$3 owner
    owner=$(port_owner "$port")
    case "$owner" in
        "") pass "Port $port ($label) is free" ;;
        mscd) pass "Port $port ($label) is used by the running MSCD container and will be reused" ;;
        container:*) fail "Port $port ($label) is published by container ${owner#container:}" \
            "Stop that container or choose another port with $flag" ;;
        *) fail "Port $port ($label) is already in use by another program" \
            "Stop that program or choose another port with $flag" ;;
    esac
    if ((port < 1024)) && docker_is_rootless; then
        local start
        start=$(cat /proc/sys/net/ipv4/ip_unprivileged_port_start 2>/dev/null || echo 1024)
        if ((port < start)); then
            fail "Rootless Docker cannot publish port $port" \
                "Choose a port of $start or higher with $flag, or lower net.ipv4.ip_unprivileged_port_start"
        fi
    fi
}

# ---------------------------------------------------------------------------
# TLS
# ---------------------------------------------------------------------------

# is_pem_cert FILE: a PEM certificate. OpenSSL 3 also reads DER on its own, but
# NGINX only loads PEM, so the format is checked explicitly.
is_pem_cert() {
    grep -q -- '-----BEGIN CERTIFICATE-----' "$1" 2>/dev/null &&
        openssl x509 -inform PEM -in "$1" -noout >/dev/null 2>&1
}

# is_pem_key FILE: a PEM private key without a passphrase.
is_pem_key() {
    grep -Eq -- '-----BEGIN ([A-Z]+ )?PRIVATE KEY-----' "$1" 2>/dev/null &&
        openssl pkey -inform PEM -in "$1" -noout -passin pass: >/dev/null 2>&1
}

# cert_matches_host CERT HOST: true when HOST is in the certificate.
cert_matches_host() {
    local check=-checkhost
    is_ipv4 "$2" && check=-checkip
    openssl x509 -in "$1" -noout "$check" "$2" 2>/dev/null | grep -q 'does match'
}

cert_fingerprint() {
    if [[ -f $1 ]]; then
        openssl x509 -in "$1" -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2
    fi
}

cert_end_date() {
    openssl x509 -in "$1" -noout -enddate 2>/dev/null | cut -d= -f2
}

# self_signed_is_current CERT HOST: certificate exists, matches HOST and is
# valid for at least 30 more days.
self_signed_is_current() {
    [[ -f $1 ]] &&
        openssl x509 -in "$1" -noout -checkend $((30 * 86400)) >/dev/null 2>&1 &&
        cert_matches_host "$1" "$2"
}

# validate_cert_pair CERT KEY HOST: PASS/FAIL lines for a provided certificate.
validate_cert_pair() {
    local crt=$1 key=$2 host=$3
    if [[ ! -f $crt || ! -r $crt ]]; then
        fail "Certificate file $crt cannot be read" "Check the path given to --tls-cert"
        return 0
    fi
    if [[ ! -f $key || ! -r $key ]]; then
        fail "Key file $key cannot be read" "Check the path given to --tls-key"
        return 0
    fi
    if ! is_pem_cert "$crt"; then
        fail "$crt is not a PEM certificate (it must start with -----BEGIN CERTIFICATE-----)" \
            "Convert it to PEM, for example: openssl x509 -inform DER -in $crt -out mscd.pem"
        return 0
    fi
    if grep -Eq -- '-----BEGIN ENCRYPTED PRIVATE KEY-----|Proc-Type: 4,ENCRYPTED' "$key" 2>/dev/null; then
        fail "$key is protected by a passphrase" \
            "Export the key without a passphrase, for example: openssl pkey -in $key -out mscd.key"
        return 0
    fi
    if ! is_pem_key "$key"; then
        fail "$key is not a PEM private key (it must start with -----BEGIN ... PRIVATE KEY-----)" \
            "Convert it to PEM, for example: openssl pkey -inform DER -in $key -out mscd.key"
        return 0
    fi
    if [[ "$(openssl x509 -in "$crt" -noout -pubkey 2>/dev/null)" != "$(openssl pkey -in "$key" -pubout 2>/dev/null)" ]]; then
        fail "The certificate and the key do not belong together" \
            "Use the key that was created with this certificate, and put the server certificate first in the file"
        return 0
    fi
    pass "Certificate and key are PEM files that belong together"
    if ! openssl x509 -in "$crt" -noout -checkend 0 >/dev/null 2>&1; then
        fail "The certificate expired on $(cert_end_date "$crt")" "Renew the certificate"
    elif ! openssl x509 -in "$crt" -noout -checkend $((30 * 86400)) >/dev/null 2>&1; then
        warn "The certificate expires soon ($(cert_end_date "$crt"))"
    else
        pass "Certificate valid until $(cert_end_date "$crt")"
    fi
    if cert_matches_host "$crt" "$host"; then
        pass "Certificate covers $host"
    else
        warn "Certificate does not list $host; browsers will warn unless users open a name it covers"
    fi
}

# docker_bridge_ips: gateway addresses of Docker bridge networks on this host.
# They are internal to Docker, so they stay out of the self-signed certificate.
docker_bridge_ips() {
    local nets=()
    mapfile -t nets < <(docker network ls -q --filter driver=bridge 2>/dev/null || true)
    ((${#nets[@]} > 0)) || return 0
    docker network inspect --format '{{range .IPAM.Config}}{{.Gateway}} {{end}}' "${nets[@]}" 2>/dev/null || true
}

# generate_self_signed DEST_CERT DEST_KEY HOST
generate_self_signed() {
    local crt=$1 key=$2 host=$3 san short ip skip
    if is_ipv4 "$host"; then san="IP:$host"; else san="DNS:$host"; fi
    short=$(hostname -s 2>/dev/null || true)
    if [[ -n $short && $short != "$host" ]] && valid_host "$short"; then san+=",DNS:$short"; fi
    san+=",DNS:localhost,IP:127.0.0.1"
    skip=" $(docker_bridge_ips | tr '\n' ' ') "
    for ip in $(hostname -I 2>/dev/null || true); do
        if is_ipv4 "$ip" && [[ $ip != "$host" && $ip != 127.* && $skip != *" $ip "* ]]; then
            san+=",IP:$ip"
        fi
    done
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 825 \
        -subj "/CN=$host/O=MSCD self-signed" \
        -addext "subjectAltName=$san" \
        -addext "basicConstraints=critical,CA:FALSE" \
        -addext "keyUsage=critical,digitalSignature" \
        -addext "extendedKeyUsage=serverAuth" \
        -keyout "$key" -out "$crt" >/dev/null 2>&1
}

# resolve_run_ids: sets RUN_UID and RUN_GID for the container.
#   root:                a dedicated "mscd" system account (created once), so the
#                        container never shares a user ID with another service.
#   docker group member: the invoking user, who owns the install directory.
#   rootless Docker:     the image user 101, which Docker maps to a subordinate ID.
# shellcheck disable=SC2034  # RUN_UID and RUN_GID are read by the calling script
resolve_run_ids() {
    local shell=/usr/sbin/nologin
    if [[ $EUID -eq 0 ]] && command -v useradd >/dev/null 2>&1; then
        if ! id -u "$MSCD_ACCOUNT" >/dev/null 2>&1; then
            [[ -x $shell ]] || shell=/sbin/nologin
            useradd --system --user-group --no-create-home --home-dir /nonexistent \
                --shell "$shell" --comment "$MSCD_ACCOUNT_COMMENT" "$MSCD_ACCOUNT"
            pass "Created system account $MSCD_ACCOUNT (uid $(id -u "$MSCD_ACCOUNT"))"
        fi
        RUN_UID=$(id -u "$MSCD_ACCOUNT")
        RUN_GID=$(id -g "$MSCD_ACCOUNT")
    elif docker_is_rootless; then
        RUN_UID=$MSCD_IMAGE_UID
        RUN_GID=$MSCD_IMAGE_UID
    else
        RUN_UID=$(id -u)
        RUN_GID=$(id -g)
    fi
}

# set_key_owner KEY_FILE IMAGE UID GID: the key becomes readable by the container user only.
# Without root, and for a file this user does not own, a short-lived container
# (from the MSCD image) changes the owner.
set_key_owner() {
    local file=$1 image=$2 uid=$3 gid=$4
    if [[ "$(stat -c '%u:%g:%a' "$file")" == "$uid:$gid:400" ]]; then
        return 0
    fi
    if [[ $EUID -eq 0 ]]; then
        chown "$uid:$gid" "$file"
        chmod 0400 "$file"
    elif [[ $uid == "$EUID" && "$(stat -c '%u' "$file")" == "$EUID" ]]; then
        chgrp "$gid" "$file"
        chmod 0400 "$file"
    else
        docker run --rm --user 0 --network none --entrypoint sh \
            -v "$(dirname -- "$file"):/tls:z" "$image" \
            -c 'chown "$1" "/tls/$2" && chmod 0400 "/tls/$2"' sh "$uid:$gid" "$(basename -- "$file")"
    fi
}

# tls_config_test DIR IMAGE UID GID: NGINX from IMAGE loads tls.crt and tls.key
# from DIR in a throwaway container without network, as the real container would.
tls_config_test() {
    local dir=$1 image=$2 uid=$3 gid=$4
    docker run --rm --network none --user "$uid:$gid" \
        --read-only --tmpfs /tmp:size=16m,mode=1777 \
        --cap-drop ALL --security-opt no-new-privileges:true \
        -v "$dir:/etc/nginx/tls:ro,z" --entrypoint sh "$image" \
        -c '/docker-entrypoint.d/40-mscd-runtime.sh >/dev/null && nginx -t -q' 2>&1
}

# ---------------------------------------------------------------------------
# Docker helpers
# ---------------------------------------------------------------------------

# compose_in DIR ARGS...: docker compose for the install in DIR (reads DIR/.env).
compose_in() {
    local dir=$1
    shift
    docker compose --project-directory "$dir" -f "$dir/docker-compose.yml" "$@"
}

# image_fingerprint IMAGE: hash of the image layers; stable across Docker image stores.
image_fingerprint() {
    docker image inspect --format '{{json .RootFS.Layers}}' "$1" 2>/dev/null | sha256sum | cut -c1-16
}

image_exists() {
    docker image inspect "$1" >/dev/null 2>&1
}

# load_image TARBALL IMAGE EXPECTED_FINGERPRINT
load_image() {
    local tarball=$1 image=$2 expected=${3:-} actual
    docker load -i "$tarball" >/dev/null || die "docker load failed for $tarball"
    if ! image_exists "$image"; then
        die "The bundle image did not load as $image"
    fi
    actual=$(image_fingerprint "$image")
    if [[ -n $expected && $actual != "$expected" ]]; then
        die "Image $image does not match the bundle (layers $actual, expected $expected)"
    fi
    pass "Image $image loaded (layers $actual)"
}

container_state() {
    docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
        "$1" 2>/dev/null || echo missing
}

# wait_healthy CONTAINER TIMEOUT_SECONDS
wait_healthy() {
    local name=$1 timeout=$2 start=$SECONDS state
    while ((SECONDS - start < timeout)); do
        state=$(container_state "$name")
        case "$state" in
            healthy) return 0 ;;
            unhealthy | exited | dead | missing) return 1 ;;
        esac
        sleep 2
    done
    return 1
}

show_logs() {
    local health
    printf '        Last log lines from %s:\n' "$1"
    docker logs --tail "${2:-30}" "$1" 2>&1 | sed 's/^/          /' || true
    health=$(docker inspect --format '{{with .State.Health}}{{range .Log}}{{.Output}}{{end}}{{end}}' "$1" 2>/dev/null |
        grep . | tail -n 2 || true)
    if [[ -n $health ]]; then
        printf '        Last health check output:\n'
        printf '%s\n' "$health" | sed 's/^/          /'
    fi
}

# http_status URL: prints the HTTP status code (000 when unreachable).
# --noproxy: checks must reach this host directly even when HTTPS_PROXY is set.
http_status() {
    curl -ks --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null || true
}

# check_url URL LABEL: waits up to 20 seconds for HTTP 200.
check_url() {
    local url=$1 label=$2 code=000 i
    for ((i = 0; i < 10; i++)); do
        code=$(http_status "$url")
        [[ $code == 200 ]] && break
        sleep 2
    done
    if [[ $code == 200 ]]; then
        pass "$label $url returned 200"
        return 0
    fi
    fail "$label $url returned ${code:-000}" "See the troubleshooting table in INSTALL-ONPREM.md"
    return 1
}

# verify_endpoints ENV_FILE: health and app checks through the published ports.
verify_endpoints() {
    local env=$1 host bind http_port https_port redirect ok=0
    if ! command -v curl >/dev/null 2>&1; then
        warn "curl is not installed; skipped the checks through the published ports"
        return 0
    fi
    bind=$(kv_get "$env" MSCD_BIND_ADDRESS)
    http_port=$(kv_get "$env" MSCD_HTTP_PORT)
    https_port=$(kv_get "$env" MSCD_HTTPS_PORT)
    redirect=$(kv_get "$env" MSCD_HTTP_REDIRECT)
    host=127.0.0.1
    if [[ -n $bind && $bind != 0.0.0.0 ]]; then host=$bind; fi

    check_url "http://$host:$http_port/healthz" "HTTP " || ok=1
    check_url "https://$host:$https_port/healthz" "HTTPS" || ok=1
    check_url "https://$host:$https_port/" "HTTPS" || ok=1
    if [[ $redirect == true ]]; then
        local code
        code=$(http_status "http://$host:$http_port/")
        if [[ $code == 301 ]]; then
            pass "HTTP  http://$host:$http_port/ redirects to HTTPS"
        else
            fail "HTTP  http://$host:$http_port/ returned $code, expected a redirect (301)"
            ok=1
        fi
    else
        check_url "http://$host:$http_port/" "HTTP " || ok=1
    fi
    return "$ok"
}

# public_url ENV_FILE
public_url() {
    local env=$1 domain port
    domain=$(kv_get "$env" MSCD_DOMAIN)
    port=$(kv_get "$env" MSCD_HTTPS_PORT)
    if [[ $port == 443 ]]; then
        echo "https://$domain/"
    else
        echo "https://$domain:$port/"
    fi
}
