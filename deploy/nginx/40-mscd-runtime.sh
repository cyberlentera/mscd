#!/bin/sh
# MSCD web: start-up settings (installed as /docker-entrypoint.d/40-mscd-runtime.sh).
#
# Runs from /docker-entrypoint.sh before NGINX starts and writes small include
# files to /tmp/mscd. The root filesystem stays read-only.
#
# Environment variables:
#   MSCD_HTTP_REDIRECT      true|false  Redirect HTTP to HTTPS when TLS is on (default true)
#   MSCD_HTTPS_PUBLIC_PORT  port        HTTPS port users reach, used in the redirect (default 443)
#   MSCD_DOMAIN             host name   Host name users open, used in the redirect
#                                       (default: the Host header of the request)
#   MSCD_HSTS               true|false  Send Strict-Transport-Security on HTTPS (default false)
#   MSCD_HSTS_MAX_AGE       seconds     HSTS max-age (default 31536000)
#   MSCD_EXTERNAL_FONTS     true|false  Load the optional Google Fonts and allow them in the
#                                       CSP (default false)
#   MSCD_API_UPSTREAM       host:port   Address of the MSCD api that /api/ is proxied to
#                                       (default api:3000); none turns the proxy off and
#                                       /api/ answers 404 (web-only use). A host name is
#                                       looked up again while NGINX runs (every 10 s at
#                                       most), so a recreated api with a new address is
#                                       reached without restarting this container
#   MSCD_API_RESOLVER       list        DNS servers used for those lookups, separated by
#                                       commas or spaces (default: the nameserver lines
#                                       of /etc/resolv.conf). Accepted forms of an entry:
#                                         IPv4 address           1.1.1.1
#                                         IPv4 address and port  1.1.1.1:5353
#                                         IPv6 address           fd00::53 or [fd00::53]
#                                         IPv6 address and port  [fd00::53]:5353
#                                       Without a port, port 53 is used. Host names,
#                                       zones (fe80::1%eth0) and anything else stop the
#                                       start with an error
#   MSCD_TRUSTED_PROXY_CIDRS  list      Addresses or CIDR ranges of trusted proxies in front of
#                                       this server (for example the ingress controller),
#                                       separated by commas or spaces. Their X-Forwarded-For
#                                       header names the client. Default: none, the socket
#                                       address is the client
#
# TLS turns on when /etc/nginx/tls/tls.crt and /etc/nginx/tls/tls.key exist.
set -eu

RUNTIME_DIR=/tmp/mscd
TLS_DIR=/etc/nginx/tls
FONT_LINKS=/etc/nginx/mscd/external-fonts.html

log() { echo "40-mscd-runtime.sh: $*"; }

is_true() {
    case "$1" in
        true | TRUE | True | yes | on | 1) return 0 ;;
        *) return 1 ;;
    esac
}

is_port() {
    case "$1" in
        '' | *[!0-9]*) return 1 ;;
    esac
    [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

# is_ipv4 ADDR: four decimal numbers from 0 to 255 separated by dots.
is_ipv4() {
    case "$1" in
        *[!0-9.]* | .* | *. | *..*) return 1 ;;
    esac
    old_ifs=$IFS
    IFS=.
    # shellcheck disable=SC2086
    set -- $1
    IFS=$old_ifs
    [ "$#" -eq 4 ] || return 1
    for octet in "$@"; do
        [ "${#octet}" -le 3 ] && [ "$octet" -le 255 ] || return 1
    done
}

# is_ipv6 ADDR: groups of one to four hex digits separated by colons, at most
# one "::", optionally ending in an IPv4 address (::ffff:192.0.2.1). No port,
# no brackets, no zone.
is_ipv6() {
    addr=$1
    case "$addr" in
        *:*) ;;
        *) return 1 ;;
    esac
    case "$addr" in
        *[!0-9A-Fa-f:.]* | *:::* | *::*::*) return 1 ;;
    esac
    groups_max=8
    case "$addr" in
        *.*)
            is_ipv4 "${addr##*:}" || return 1
            addr="${addr%:*}:0"
            groups_max=7
            ;;
    esac
    case "$addr" in
        :[!:]* | *[!:]:) return 1 ;;
    esac
    count=0
    old_ifs=$IFS
    IFS=:
    # shellcheck disable=SC2086
    set -- $addr
    IFS=$old_ifs
    for group in "$@"; do
        [ -z "$group" ] && continue
        [ "${#group}" -le 4 ] || return 1
        count=$((count + 1))
    done
    case "$addr" in
        *::*) [ "$count" -lt "$groups_max" ] ;;
        *) [ "$count" -eq "$groups_max" ] ;;
    esac
}

redirect=${MSCD_HTTP_REDIRECT:-true}
public_port=${MSCD_HTTPS_PUBLIC_PORT:-443}
domain=${MSCD_DOMAIN:-}
hsts=${MSCD_HSTS:-false}
hsts_max_age=${MSCD_HSTS_MAX_AGE:-31536000}
external_fonts=${MSCD_EXTERNAL_FONTS:-false}
api_upstream=${MSCD_API_UPSTREAM:-api:3000}
trusted_proxies=${MSCD_TRUSTED_PROXY_CIDRS:-}
api_resolver=${MSCD_API_RESOLVER:-}

if ! is_port "$public_port"; then
    log "ERROR: MSCD_HTTPS_PUBLIC_PORT must be a port number, got '$public_port'"
    exit 1
fi
case "$domain" in
    *[!A-Za-z0-9.-]* | -* | .*)
        log "ERROR: MSCD_DOMAIN must be a host name such as mscd.example.co.id, got '$domain'"
        exit 1
        ;;
esac
case "$hsts_max_age" in
    '' | *[!0-9]*)
        log "ERROR: MSCD_HSTS_MAX_AGE must be a number of seconds, got '$hsts_max_age'"
        exit 1
        ;;
esac

# MSCD_API_UPSTREAM: host:port, [IPv6 address]:port, or none. The host is a DNS
# name or an IPv4 address; the port is required so a typo never silently
# reaches port 80. api_host and api_port keep the parts; api_literal is true
# for an address, which needs no DNS lookup.
api_host=""
api_port=""
api_literal=false
case "$api_upstream" in
    none) ;;
    \[*\]:*)
        v6=${api_upstream#\[}
        v6=${v6%%\]*}
        port=${api_upstream##*\]:}
        case "$v6" in
            '' | *[!0-9A-Fa-f:.]*)
                log "ERROR: MSCD_API_UPSTREAM must be host:port, [IPv6]:port or none, got '$api_upstream'"
                exit 1
                ;;
        esac
        if ! is_port "$port"; then
            log "ERROR: MSCD_API_UPSTREAM must end with a port number, got '$api_upstream'"
            exit 1
        fi
        api_host="[$v6]"
        api_port=$port
        api_literal=true
        ;;
    *:*)
        host=${api_upstream%:*}
        port=${api_upstream##*:}
        case "$host" in
            '' | *[!A-Za-z0-9.-]* | -* | .*)
                log "ERROR: MSCD_API_UPSTREAM must be host:port, [IPv6]:port or none, got '$api_upstream'"
                exit 1
                ;;
        esac
        if ! is_port "$port"; then
            log "ERROR: MSCD_API_UPSTREAM must end with a port number, got '$api_upstream'"
            exit 1
        fi
        api_host=$host
        api_port=$port
        case "$host" in
            *[!0-9.]*) ;;
            *) api_literal=true ;;
        esac
        ;;
    *)
        log "ERROR: MSCD_API_UPSTREAM must be host:port, [IPv6]:port or none, got '$api_upstream'"
        exit 1
        ;;
esac

# MSCD_TRUSTED_PROXY_CIDRS: IPv4 or IPv6 addresses or CIDR ranges, separated by
# commas or white space. Globbing is off while the list is split.
proxies=""
set -f
for cidr in $(printf '%s' "$trusted_proxies" | tr ',' ' '); do
    case "$cidr" in
        *[!0-9A-Fa-f:./]* | */*/* | /* | */)
            log "ERROR: MSCD_TRUSTED_PROXY_CIDRS must list addresses or CIDR ranges such as 10.0.0.0/8, got '$cidr'"
            exit 1
            ;;
    esac
    case "$cidr" in
        */*)
            bits=${cidr#*/}
            case "$bits" in
                '' | *[!0-9]*)
                    log "ERROR: invalid prefix length in MSCD_TRUSTED_PROXY_CIDRS entry '$cidr'"
                    exit 1
                    ;;
            esac
            if [ "$bits" -gt 128 ]; then
                log "ERROR: invalid prefix length in MSCD_TRUSTED_PROXY_CIDRS entry '$cidr'"
                exit 1
            fi
            ;;
    esac
    proxies="${proxies:+$proxies }$cidr"
done
set +f

# DNS servers for the run-time lookups of the api host name: MSCD_API_RESOLVER,
# else the nameserver lines of /etc/resolv.conf. IPv6 servers are written in
# brackets; link-local servers with a zone (fe80::1%eth0) are skipped, NGINX
# cannot use them.
resolvers=""
if [ -n "$api_resolver" ]; then
    resolver_list=$(printf '%s' "$api_resolver" | tr ',' ' ')
else
    resolver_list=$(awk '$1 == "nameserver" { print $2 }' /etc/resolv.conf 2>/dev/null || true)
fi
# resolver_entry ENTRY: prints ENTRY in the form of the NGINX "resolver"
# directive (address, address:port, [IPv6] or [IPv6]:port), or fails.
resolver_entry() {
    entry=$1
    case "$entry" in
        \[*\]:*)
            inner=${entry#\[}
            inner=${inner%%\]*}
            rport=${entry##*\]:}
            is_ipv6 "$inner" && is_port "$rport" || return 1
            echo "[$inner]:$rport"
            ;;
        \[*\])
            inner=${entry#\[}
            inner=${inner%\]}
            is_ipv6 "$inner" || return 1
            echo "[$inner]"
            ;;
        *:*:*)
            is_ipv6 "$entry" || return 1
            echo "[$entry]"
            ;;
        *:*)
            # Exactly one colon: an IPv4 address and a port (no IPv6 address has
            # a single colon).
            is_ipv4 "${entry%:*}" && is_port "${entry##*:}" || return 1
            echo "$entry"
            ;;
        *)
            is_ipv4 "$entry" || return 1
            echo "$entry"
            ;;
    esac
}

set -f
for ns in $resolver_list; do
    case "$ns" in
        *%*)
            [ -z "$api_resolver" ] && continue
            log "ERROR: MSCD_API_RESOLVER entries cannot carry a zone (link-local addresses such as fe80::1%eth0 are not usable by NGINX), got '$ns'"
            exit 1
            ;;
    esac
    if ! entry=$(resolver_entry "$ns"); then
        if [ -n "$api_resolver" ]; then
            log "ERROR: MSCD_API_RESOLVER entries must be an IPv4 address (1.1.1.1), an IPv4 address and port (1.1.1.1:5353), an IPv6 address (fd00::53 or [fd00::53]) or an IPv6 address and port ([fd00::53]:5353), got '$ns'"
        else
            log "ERROR: the nameserver line '$ns' of /etc/resolv.conf is not an IP address; set MSCD_API_RESOLVER to the DNS servers to use"
        fi
        exit 1
    fi
    resolvers="${resolvers:+$resolvers }$entry"
done
set +f

# A short host name such as "api" is completed with the search domains of
# /etc/resolv.conf when NGINX starts (in Kubernetes the Service name becomes
# api.<namespace>.svc.cluster.local), because the NGINX resolver does not use
# them. As with the C library, a name with at least "options ndots" dots (1 by
# default) is tried as given first, then with each search domain; a name with
# fewer dots tries the search domains first. The first name that resolves now
# is kept; when none does (the api is not started yet), the name stays as given.
qualify_host() {
    name=$1
    case "$name" in *.) echo "$name"; return 0 ;; esac
    ndots=$(awk '$1 == "options" { for (i = 2; i <= NF; i++) if ($i ~ /^ndots:[0-9]+$/) { sub(/^ndots:/, "", $i); n = $i } } END { print (n == "" ? 1 : n) }' /etc/resolv.conf 2>/dev/null || echo 1)
    dots=$(printf '%s' "$name" | tr -cd '.' | wc -c)
    search=$(awk '$1 == "search" || $1 == "domain" { for (i = 2; i <= NF; i++) printf "%s ", $i }' /etc/resolv.conf 2>/dev/null || true)
    if [ "$dots" -ge "$ndots" ] && getent hosts "$name" >/dev/null 2>&1; then
        echo "$name"
        return 0
    fi
    set -f
    for d in $search; do
        case "$d" in *[!A-Za-z0-9.-]* | .*) continue ;; esac
        if getent hosts "$name.${d%.}" >/dev/null 2>&1; then
            set +f
            echo "$name.${d%.}"
            return 0
        fi
    done
    set +f
    echo "$name"
}

rm -rf "$RUNTIME_DIR"
mkdir -p "$RUNTIME_DIR/conf.d" "$RUNTIME_DIR/http.d" "$RUNTIME_DIR/https.d" \
    "$RUNTIME_DIR/hsts.d" "$RUNTIME_DIR/site.d" "$RUNTIME_DIR/index.d" "$RUNTIME_DIR/redirect.d" \
    "$RUNTIME_DIR/realip.d" "$RUNTIME_DIR/upstream.d"

if [ "$api_upstream" = none ]; then
    echo 'return 404;' >"$RUNTIME_DIR/api-upstream.conf"
    log "API proxy off (MSCD_API_UPSTREAM=none): /api/ answers 404"
else
    # The upstream lives in shared memory (zone) so that "resolve" can update
    # its addresses while NGINX runs: a recreated api container with a new
    # address is used within the resolver's valid time. Idle connections to the
    # api are kept open (keepalive) for reuse.
    if [ "$api_literal" = true ]; then
        server_line="server $api_host:$api_port;"
        resolver_lines=""
        how="fixed address"
    elif [ -n "$resolvers" ]; then
        api_host=$(qualify_host "$api_host")
        server_line="server $api_host:$api_port resolve;"
        ipv6=" ipv6=off"
        if [ -f /proc/net/if_inet6 ]; then ipv6=""; fi
        resolver_lines="    resolver $resolvers valid=10s$ipv6;
    resolver_timeout 5s;"
        how="looked up again while running through $resolvers"
    else
        log "WARNING: no DNS server in /etc/resolv.conf and MSCD_API_RESOLVER is empty; $api_host is resolved only once, at start"
        server_line="server $api_host:$api_port;"
        resolver_lines=""
        how="resolved once at start"
    fi
    {
        echo 'upstream mscd_api {'
        echo '    zone mscd_api 64k;'
        if [ -n "$resolver_lines" ]; then echo "$resolver_lines"; fi
        echo "    $server_line"
        echo '    keepalive 16;'
        echo '}'
    } >"$RUNTIME_DIR/upstream.d/api.conf"
    echo 'proxy_pass http://mscd_api;' >"$RUNTIME_DIR/api-upstream.conf"
    log "API proxy: /api/ to http://$api_host:$api_port ($how)"
fi

if [ -n "$proxies" ]; then
    {
        printf '%s\n' "$proxies" | tr ' ' '\n' | while IFS= read -r cidr; do
            echo "set_real_ip_from $cidr;"
        done
        echo 'real_ip_header X-Forwarded-For;'
        echo 'real_ip_recursive on;'
    } >"$RUNTIME_DIR/realip.d/realip.conf"
    log "client address taken from X-Forwarded-For of the trusted proxies: $proxies"
fi

if [ -f /proc/net/if_inet6 ]; then
    echo 'listen [::]:8080 default_server;' >"$RUNTIME_DIR/http.d/listen-ipv6.conf"
    echo 'listen [::]:8443 ssl default_server;' >"$RUNTIME_DIR/https.d/listen-ipv6.conf"
fi

if is_true "$external_fonts"; then
    # The image ships index.html without the Google Fonts links. Put them back
    # into the page and allow the two font hosts in the Content-Security-Policy.
    links=$(cat "$FONT_LINKS" 2>/dev/null || true)
    case "$links" in
        '' | *"'"* | *'$'* | *\\*)
            log "WARNING: $FONT_LINKS is missing or not usable; external fonts stay off"
            ;;
        *)
            cat >"$RUNTIME_DIR/site.d/external-fonts.conf" <<'EOF'
set $mscd_csp_style " https://fonts.googleapis.com";
set $mscd_csp_font  " https://fonts.gstatic.com";
EOF
            cat >"$RUNTIME_DIR/index.d/external-fonts.conf" <<EOF
gzip_static off;
sub_filter_once on;
sub_filter '</head>' '$links</head>';
EOF
            log "external fonts allowed (Google Fonts)"
            ;;
    esac
fi

if [ -f "$TLS_DIR/tls.crt" ] && [ -f "$TLS_DIR/tls.key" ]; then
    for f in "$TLS_DIR/tls.crt" "$TLS_DIR/tls.key"; do
        if [ ! -r "$f" ]; then
            log "ERROR: $f is not readable by user $(id -u). Make it readable by that user, for example: chown $(id -u):$(id -g) tls.key && chmod 0400 tls.key (install.sh does this for you)."
            exit 1
        fi
    done
    cp /etc/nginx/mscd/https.conf "$RUNTIME_DIR/conf.d/https.conf"

    if is_true "$redirect"; then
        port_suffix=":$public_port"
        [ "$public_port" = 443 ] && port_suffix=""
        # Redirect to the configured host name, so the Location header never
        # repeats the Host header a client sent.
        target_host=${domain:-\$host}
        cat >"$RUNTIME_DIR/redirect.d/redirect.conf" <<EOF
if (\$request_uri !~ "^/healthz") {
    return 301 "https://$target_host$port_suffix\$request_uri";
}
EOF
    fi

    if is_true "$hsts"; then
        echo "set \$mscd_hsts \"max-age=$hsts_max_age\";" >"$RUNTIME_DIR/hsts.d/hsts.conf"
    fi

    log "HTTPS on 8443 enabled (redirect=$redirect, hsts=$hsts${domain:+, host=$domain})"
elif [ -e "$TLS_DIR/tls.crt" ] || [ -e "$TLS_DIR/tls.key" ]; then
    log "ERROR: found only one of tls.crt and tls.key in $TLS_DIR; both are required"
    exit 1
else
    log "no certificate in $TLS_DIR; serving HTTP on 8080 only"
fi
