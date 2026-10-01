DO $report$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mscd_report') THEN
    CREATE ROLE mscd_report NOLOGIN;
  END IF;
END
$report$;
GRANT CONNECT ON DATABASE "{{database}}" TO mscd_report;
GRANT USAGE ON SCHEMA ext TO mscd_report;
ALTER ROLE mscd_report SET search_path = '';
