CREATE SCHEMA IF NOT EXISTS platform;
CREATE SCHEMA IF NOT EXISTS ref;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mscd_app')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mscd_pack_installer') THEN
    RAISE EXCEPTION 'Roles mscd_app and mscd_pack_installer must exist. Run "mscd-server db bootstrap" first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
                 WHERE e.extname = 'pg_trgm' AND n.nspname = 'ext') THEN
    RAISE EXCEPTION 'Extension pg_trgm must exist in schema ext. Run "mscd-server db bootstrap" first.';
  END IF;
END $$;

REVOKE ALL ON SCHEMA platform FROM PUBLIC;
REVOKE ALL ON SCHEMA ref FROM PUBLIC;
GRANT USAGE ON SCHEMA platform TO mscd_app, mscd_pack_installer;
GRANT USAGE ON SCHEMA ref TO mscd_app, mscd_pack_installer;

CREATE FUNCTION platform.set_updated_at() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, platform AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE FUNCTION platform.forbid_change() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, platform AS $$
BEGIN
  RAISE EXCEPTION '% on %.% is not allowed: the table is append-only', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

-- Canonical text of one audit row: a JSON array, so no two different rows share one text.
-- Timestamps are rendered in UTC so the hash does not depend on the session time zone.
CREATE FUNCTION platform.audit_canonical_text(
  p_seq bigint, p_id uuid, p_occurred_at timestamptz, p_organization_id uuid, p_management_system_id uuid,
  p_actor_user_id uuid, p_actor_kind text, p_action text, p_entity_type text, p_entity_id uuid,
  p_entity_code text, p_before jsonb, p_after jsonb, p_edition text, p_request_id text, p_source_ip inet,
  p_user_agent text)
RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, platform AS $$
  SELECT jsonb_build_array(
    p_seq, p_id, to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    p_organization_id, p_management_system_id, p_actor_user_id, p_actor_kind, p_action, p_entity_type,
    p_entity_id, p_entity_code, p_before, p_after, p_edition, p_request_id, host(p_source_ip), p_user_agent)::text
$$;

-- Hash chain for platform.audit_log and every org_*.audit_trail (same columns). Serialised per table.
CREATE FUNCTION platform.chain_hash() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, platform AS $$
DECLARE
  last_seq bigint;
  last_hash bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, 42));
  EXECUTE format('SELECT seq, row_hash FROM %I.%I ORDER BY seq DESC LIMIT 1', TG_TABLE_SCHEMA, TG_TABLE_NAME)
    INTO last_seq, last_hash;
  NEW.seq := coalesce(last_seq, 0) + 1;
  NEW.prev_hash := coalesce(last_hash, '\x'::bytea);
  NEW.row_hash := sha256(NEW.prev_hash || convert_to(platform.audit_canonical_text(
    NEW.seq, NEW.id, NEW.occurred_at, NEW.organization_id, NEW.management_system_id, NEW.actor_user_id,
    NEW.actor_kind, NEW.action, NEW.entity_type, NEW.entity_id, NEW.entity_code, NEW.before_data,
    NEW.after_data, NEW.edition, NEW.request_id, NEW.source_ip, NEW.user_agent), 'UTF8'));
  RETURN NEW;
END $$;

-- A-29: every shared entity keeps exactly one primary management system.
CREATE FUNCTION platform.entity_link_has_primary() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, platform AS $$
DECLARE
  found_primary boolean;
BEGIN
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.entity_ms_link WHERE entity_type = $1 AND entity_id = $2 AND is_primary AND deleted_at IS NULL)', TG_TABLE_SCHEMA)
    INTO found_primary USING NEW.entity_type, NEW.entity_id;
  IF NOT found_primary THEN
    RAISE EXCEPTION 'Entity % % has no primary management system', NEW.entity_type, NEW.entity_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

-- BR-43: preparation tasks finish before the audit starts.
CREATE FUNCTION platform.prep_task_before_audit() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, platform AS $$
DECLARE
  event_date date;
BEGIN
  EXECUTE format('SELECT scheduled_at FROM %I.audit_event WHERE id = $1', TG_TABLE_SCHEMA)
    INTO event_date USING NEW.audit_event_id;
  IF event_date IS NOT NULL AND NEW.due_at >= event_date THEN
    RAISE EXCEPTION 'BR-43: preparation task due % is not before the audit on %', NEW.due_at, event_date
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- Person columns must name a member of the row's organisation (backstop for MembershipService, C.1).
-- Trigger arguments are the column names to check.
CREATE FUNCTION platform.assert_member() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, platform AS $$
DECLARE
  col text;
  uid uuid;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    EXECUTE format('SELECT ($1).%I', col) INTO uid USING NEW;
    IF uid IS NOT NULL AND uid <> '00000000-0000-0000-0000-000000000001'::uuid AND NOT EXISTS (
         SELECT 1 FROM platform.org_membership m
         WHERE m.organization_id = NEW.organization_id AND m.user_id = uid AND m.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'User % in column % is not a member of organisation %', uid, col, NEW.organization_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

-- Grants, RLS, policies and triggers for one tenant schema. Idempotent. Raises on a table it cannot secure.
CREATE FUNCTION platform.secure_tenant_schema(target_schema text) RETURNS void LANGUAGE plpgsql
  SET search_path = pg_catalog, platform AS $$
DECLARE
  t record;
  tbl text;
  schema_org uuid;
  member_cols text[];
  report_excluded text[] := ARRAY['storage_credential', 'auditor_access_grant', 'calendar_feed_token',
                                  'upload_intent', 'audit_trail'];
  person_cols text[] := ARRAY['user_id', 'owner_user_id', 'holder_user_id', 'pending_holder_user_id',
                              'approver_user_id', 'justification_holder_user_id', 'relationship_owner_user_id',
                              'recipient_user_id', 'accepted_by_user_id', 'auditee_user_id',
                              'implemented_by_user_id', 'verified_by_user_id', 'completed_by_user_id'];
BEGIN
  -- The policy binds the schema to its own organisation, so a session of organisation A can neither read nor
  -- write rows in the schema of organisation B, even with a schema-qualified statement.
  SELECT o.id INTO schema_org FROM platform.organization o WHERE o.schema_name = target_schema;
  IF schema_org IS NULL THEN
    RAISE EXCEPTION 'Schema % has no row in platform.organization', target_schema;
  END IF;
  EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', target_schema);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO mscd_app', target_schema);
  FOR t IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = target_schema AND c.relkind IN ('r', 'p') AND c.relname NOT LIKE 'kysely\_%'
  LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = target_schema AND table_name = t.relname AND column_name = 'organization_id') THEN
      RAISE EXCEPTION 'Tenant table %.% has no organization_id column', target_schema, t.relname;
    END IF;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I.%I TO mscd_app', target_schema, t.relname);
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', target_schema, t.relname);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', target_schema, t.relname);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I.%I', target_schema, t.relname);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I.%I '
      'USING (organization_id = %L::uuid AND organization_id = nullif(current_setting(''app.org_id'', true), '''')::uuid) '
      'WITH CHECK (organization_id = %L::uuid AND organization_id = nullif(current_setting(''app.org_id'', true), '''')::uuid)',
      target_schema, t.relname, schema_org, schema_org);
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = target_schema AND table_name = t.relname AND column_name = 'updated_at')
       AND NOT EXISTS (SELECT 1 FROM pg_trigger tg
                       JOIN pg_class c2 ON c2.oid = tg.tgrelid JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
                       WHERE n2.nspname = target_schema AND c2.relname = t.relname AND tg.tgname = 'set_updated_at') THEN
      EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I.%I FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at()',
        target_schema, t.relname);
    END IF;
    member_cols := ARRAY(SELECT column_name::text FROM information_schema.columns
                         WHERE table_schema = target_schema AND table_name = t.relname
                           AND column_name = ANY (person_cols) ORDER BY column_name);
    EXECUTE format('DROP TRIGGER IF EXISTS assert_member ON %I.%I', target_schema, t.relname);
    IF cardinality(member_cols) > 0 THEN
      EXECUTE format('CREATE TRIGGER assert_member BEFORE INSERT OR UPDATE OF %s ON %I.%I FOR EACH ROW EXECUTE FUNCTION platform.assert_member(%s)',
        (SELECT string_agg(quote_ident(c), ', ') FROM unnest(member_cols) AS c), target_schema, t.relname,
        (SELECT string_agg(quote_literal(c), ', ') FROM unnest(member_cols) AS c));
    END IF;
  END LOOP;
  FOREACH tbl IN ARRAY ARRAY['audit_trail', 'link_health_result', 'reminder'] LOOP
    IF to_regclass(format('%I.%I', target_schema, tbl)) IS NOT NULL THEN
      EXECUTE format('REVOKE UPDATE ON %I.%I FROM mscd_app', target_schema, tbl);
    END IF;
  END LOOP;
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO mscd_app', target_schema);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mscd_report') THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO mscd_report', target_schema);
    FOR t IN
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = target_schema AND c.relkind IN ('r', 'p') AND c.relname NOT LIKE 'kysely\_%'
        AND c.relname <> ALL (report_excluded)
    LOOP
      EXECUTE format('GRANT SELECT ON %I.%I TO mscd_report', target_schema, t.relname);
    END LOOP;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = target_schema AND c.relkind IN ('r', 'p') AND c.relname NOT LIKE 'kysely\_%'
               AND NOT (c.relrowsecurity AND c.relforcerowsecurity)) THEN
    RAISE EXCEPTION 'Schema % has a table without forced row-level security', target_schema;
  END IF;
END $$;

-- Narrow grants and RLS on platform tables (D-31). Called at the end of every platform migration. Idempotent.
CREATE FUNCTION platform.secure_platform_schema() RETURNS void LANGUAGE plpgsql
  SET search_path = pg_catalog, platform AS $$
DECLARE
  g record;
  org_expr text := 'nullif(current_setting(''app.org_id'', true), '''')::uuid';
  user_expr text := 'nullif(current_setting(''app.user_id'', true), '''')::uuid';
  scope_expr text := 'coalesce(current_setting(''app.platform_scope'', true), '''') = ''on''';
BEGIN
  EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA platform FROM mscd_app, mscd_pack_installer';
  FOR g IN SELECT * FROM (VALUES
      ('kysely_migration', 'SELECT'), ('organization', 'SELECT'), ('installation', 'SELECT'),
      ('app_user', 'SELECT, INSERT, UPDATE'), ('org_membership', 'SELECT, INSERT, UPDATE'),
      ('platform_role', 'SELECT'), ('verified_domain', 'SELECT'),
      ('identity_provider', 'SELECT, INSERT, UPDATE'), ('user_identity', 'SELECT, INSERT, UPDATE'),
      ('session', 'SELECT, INSERT, UPDATE'), ('mfa_factor', 'SELECT, INSERT, UPDATE'),
      ('mfa_recovery_code', 'SELECT, INSERT, UPDATE'), ('auth_transaction', 'SELECT, INSERT, UPDATE, DELETE'),
      ('saml_assertion_seen', 'SELECT, INSERT, DELETE'), ('password_reset_token', 'SELECT, INSERT, UPDATE'),
      ('invitation', 'SELECT, INSERT, UPDATE'), ('user_preference', 'SELECT, INSERT, UPDATE'),
      ('licence', 'SELECT, INSERT'), ('clock_mark', 'SELECT, UPDATE'),
      ('pack_install', 'SELECT'), ('pack_catalog', 'SELECT'), ('tenant_key', 'SELECT, INSERT'),
      ('audit_log', 'SELECT, INSERT'), ('audit_anchor', 'SELECT, INSERT'),
      ('rate_limit_bucket', 'SELECT, INSERT, UPDATE, DELETE'), ('idempotency_key', 'SELECT, INSERT, UPDATE, DELETE'),
      ('job_outbox', 'SELECT, INSERT, UPDATE, DELETE'), ('system_setting', 'SELECT')
    ) AS v(tbl, privs)
  LOOP
    IF to_regclass('platform.' || g.tbl) IS NOT NULL THEN
      EXECUTE format('GRANT %s ON platform.%I TO mscd_app', g.privs, g.tbl);
    END IF;
  END LOOP;
  IF to_regclass('platform.licence') IS NOT NULL THEN
    GRANT UPDATE (superseded_at) ON platform.licence TO mscd_app;
  END IF;
  IF to_regclass('platform.organization') IS NOT NULL THEN
    GRANT UPDATE (name, time_zone, site_count, local_login) ON platform.organization TO mscd_app;
  END IF;
  FOR g IN SELECT * FROM (VALUES
      ('pack_install', 'SELECT, INSERT, UPDATE'), ('pack_catalog', 'SELECT, INSERT, UPDATE'),
      ('audit_log', 'SELECT, INSERT'), ('installation', 'SELECT')
    ) AS v(tbl, privs)
  LOOP
    IF to_regclass('platform.' || g.tbl) IS NOT NULL THEN
      EXECUTE format('GRANT %s ON platform.%I TO mscd_pack_installer', g.privs, g.tbl);
    END IF;
  END LOOP;
  EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA platform TO mscd_app';
  -- Organisation-scoped platform tables: forced RLS with an explicit platform scope (F.10).
  FOR g IN SELECT * FROM (VALUES
      ('org_membership', format('organization_id = %s OR user_id = %s OR %s', org_expr, user_expr, scope_expr)),
      ('session', format('user_id = %s OR %s', user_expr, scope_expr)),
      ('identity_provider', format('organization_id = %s OR %s', org_expr, scope_expr)),
      ('verified_domain', format('organization_id = %s OR %s', org_expr, scope_expr)),
      ('invitation', format('organization_id = %s OR %s', org_expr, scope_expr)),
      ('licence', format('organization_id = %s OR %s', org_expr, scope_expr)),
      ('tenant_key', format('organization_id = %s OR %s', org_expr, scope_expr)),
      ('audit_log', format('organization_id = %s OR %s', org_expr, scope_expr)),
      ('idempotency_key', format('organization_id = %s', org_expr))
    ) AS v(tbl, expr)
  LOOP
    IF to_regclass('platform.' || g.tbl) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE platform.%I ENABLE ROW LEVEL SECURITY', g.tbl);
      EXECUTE format('ALTER TABLE platform.%I FORCE ROW LEVEL SECURITY', g.tbl);
      EXECUTE format('DROP POLICY IF EXISTS platform_isolation ON platform.%I', g.tbl);
      EXECUTE format('CREATE POLICY platform_isolation ON platform.%I USING (%s) WITH CHECK (%s)', g.tbl, g.expr, g.expr);
    END IF;
  END LOOP;
END $$;
