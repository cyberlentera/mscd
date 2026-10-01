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

redirect=${MSCD_HTTP_REDIRECT:-true}
public_port=${MSCD_HTTPS_PUBLIC_PORT:-443}
domain=${MSCD_DOMAIN:-}
hsts=${MSCD_HSTS:-false}
hsts_max_age=${MSCD_HSTS_MAX_AGE:-31536000}
external_fonts=${MSCD_EXTERNAL_FONTS:-false}

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

rm -rf "$RUNTIME_DIR"
mkdir -p "$RUNTIME_DIR/conf.d" "$RUNTIME_DIR/http.d" "$RUNTIME_DIR/https.d" \
    "$RUNTIME_DIR/hsts.d" "$RUNTIME_DIR/site.d" "$RUNTIME_DIR/index.d" "$RUNTIME_DIR/redirect.d"

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
