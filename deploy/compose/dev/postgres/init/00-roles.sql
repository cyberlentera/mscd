-- MSCD developer stack: database bootstrap (BUILD-PLAN C.2).
--
-- The postgres image runs this file once, as the superuser, in database mscd
-- (POSTGRES_DB), when the data volume is empty. It is the C.2 bootstrap
-- (apps/server/migrations/bootstrap/roles.sql and report-role.sql) with the
-- development passwords filled in. Running it again is safe.
--
-- Development passwords only. Never reuse them outside this stack.

DO $bootstrap$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mscd_migrator') THEN
    CREATE ROLE mscd_migrator LOGIN PASSWORD 'migrator-dev';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mscd_app') THEN
    CREATE ROLE mscd_app LOGIN PASSWORD 'app-dev';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mscd_pack_installer') THEN
    CREATE ROLE mscd_pack_installer LOGIN PASSWORD 'pack-dev';
  END IF;
END
$bootstrap$;

GRANT CONNECT, CREATE ON DATABASE "mscd" TO mscd_migrator;
GRANT CONNECT ON DATABASE "mscd" TO mscd_app, mscd_pack_installer;
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

-- Reporting role (C.2 report-role.sql, what "db bootstrap --with-report-role" runs).
-- It stays NOLOGIN as in production; the password is preset so a developer can
-- enable it with: ALTER ROLE mscd_report LOGIN;
DO $report$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mscd_report') THEN
    CREATE ROLE mscd_report NOLOGIN PASSWORD 'report-dev';
  END IF;
END
$report$;
GRANT CONNECT ON DATABASE "mscd" TO mscd_report;
GRANT USAGE ON SCHEMA ext TO mscd_report;
ALTER ROLE mscd_report SET search_path = '';
