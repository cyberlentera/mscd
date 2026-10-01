#!/bin/sh
# MSCD database bootstrap for the bundled PostgreSQL (build plan C.2).
#
# The postgres image runs this file once, as the database superuser, when the
# data volume is empty. It creates the three login roles of MSCD with the
# passwords of /run/secrets/postgres-roles.env, the schema ext with pg_trgm,
# and the NOLOGIN reporting role, exactly as "mscd-server db bootstrap
# --with-report-role" does (apps/server/migrations/bootstrap/roles.sql and
# report-role.sql). Every statement can run again safely.
#
# postgres-roles.env holds three lines written by install.sh (or the demo
# overlay), with the same passwords as the db-*.url secret files:
#   MSCD_MIGRATOR_PASSWORD=...
#   MSCD_APP_PASSWORD=...
#   MSCD_PACK_INSTALLER_PASSWORD=...
set -eu

ROLES_FILE=${MSCD_ROLES_FILE:-/run/secrets/postgres-roles.env}

if [ ! -r "$ROLES_FILE" ]; then
    echo "10-mscd-bootstrap.sh: ERROR: $ROLES_FILE is missing or not readable by user $(id -u)" >&2
    exit 1
fi

# role_password NAME: the value of NAME in the roles file (never sourced as shell).
role_password() {
    value=$(sed -n "s/^$1=//p" "$ROLES_FILE" | tail -n 1 | tr -d '\r')
    if [ -z "$value" ]; then
        echo "10-mscd-bootstrap.sh: ERROR: $1 is missing in $ROLES_FILE" >&2
        exit 1
    fi
    printf '%s' "$value"
}

migrator_password=$(role_password MSCD_MIGRATOR_PASSWORD)
app_password=$(role_password MSCD_APP_PASSWORD)
pack_password=$(role_password MSCD_PACK_INSTALLER_PASSWORD)

# The passwords travel as psql variables and are quoted by format(%L), so no
# value can change the statements.
psql -v ON_ERROR_STOP=1 -X -q \
    --username "${POSTGRES_USER:-postgres}" --dbname "${POSTGRES_DB:-mscd}" \
    -v migrator_password="$migrator_password" \
    -v app_password="$app_password" \
    -v pack_password="$pack_password" <<'SQL'
SELECT format('CREATE ROLE mscd_migrator LOGIN PASSWORD %L', :'migrator_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mscd_migrator') \gexec
SELECT format('CREATE ROLE mscd_app LOGIN PASSWORD %L', :'app_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mscd_app') \gexec
SELECT format('CREATE ROLE mscd_pack_installer LOGIN PASSWORD %L', :'pack_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mscd_pack_installer') \gexec

SELECT format('GRANT CONNECT, CREATE ON DATABASE %I TO mscd_migrator', current_database()) \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO mscd_app, mscd_pack_installer', current_database()) \gexec
-- CVE-2018-1058: databases created before PostgreSQL 15 still let PUBLIC create objects in public.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA IF NOT EXISTS ext AUTHORIZATION mscd_migrator;
REVOKE ALL ON SCHEMA ext FROM PUBLIC;
GRANT USAGE ON SCHEMA ext TO mscd_app, mscd_pack_installer;
DO $ext$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
             WHERE e.extname = 'pg_trgm' AND n.nspname <> 'ext') THEN
    ALTER EXTENSION pg_trgm SET SCHEMA ext;
  END IF;
END
$ext$;
CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA ext;
ALTER ROLE mscd_app SET statement_timeout = '30s';
ALTER ROLE mscd_app SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE mscd_app SET search_path = '';
ALTER ROLE mscd_pack_installer SET search_path = '';

-- Reporting role (tenancy.mode single, D-31): created NOLOGIN, without a password.
DO $report$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mscd_report') THEN
    CREATE ROLE mscd_report NOLOGIN;
  END IF;
END
$report$;
SELECT format('GRANT CONNECT ON DATABASE %I TO mscd_report', current_database()) \gexec
GRANT USAGE ON SCHEMA ext TO mscd_report;
ALTER ROLE mscd_report SET search_path = '';
SQL

echo "10-mscd-bootstrap.sh: roles mscd_migrator, mscd_app, mscd_pack_installer and mscd_report (NOLOGIN), schema ext with pg_trgm ready in database ${POSTGRES_DB:-mscd}"
