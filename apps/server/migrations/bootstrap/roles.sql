DO $bootstrap$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mscd_migrator') THEN
    CREATE ROLE mscd_migrator LOGIN PASSWORD '{{migrator_password}}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mscd_app') THEN
    CREATE ROLE mscd_app LOGIN PASSWORD '{{app_password}}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mscd_pack_installer') THEN
    CREATE ROLE mscd_pack_installer LOGIN PASSWORD '{{pack_installer_password}}';
  END IF;
END
$bootstrap$;

GRANT CONNECT, CREATE ON DATABASE "{{database}}" TO mscd_migrator;
GRANT CONNECT ON DATABASE "{{database}}" TO mscd_app, mscd_pack_installer;
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
