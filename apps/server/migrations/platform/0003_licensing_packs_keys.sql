-- One row per installation, created on the first migrate. Licences may bind to it (D-15).
CREATE TABLE platform.installation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform.installation DEFAULT VALUES;

-- Highest wall-clock time the api or worker has seen (licence clock rollback check, D-15).
CREATE TABLE platform.clock_mark (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  high_water timestamptz NOT NULL
);
INSERT INTO platform.clock_mark (high_water) VALUES (now());

-- Signed licence documents. Validity, state and entitlements are derived from `document` on every evaluation.
CREATE TABLE platform.licence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES platform.organization(id),
  license_id varchar(60) NOT NULL,
  document jsonb NOT NULL,
  document_sha256 char(64) NOT NULL,
  key_id varchar(40) NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT now(),
  installed_by uuid REFERENCES platform.app_user(id),
  superseded_at timestamptz
);
CREATE UNIQUE INDEX licence_current_uq ON platform.licence (organization_id) WHERE superseded_at IS NULL;

CREATE TABLE platform.pack_install (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id varchar(40) NOT NULL,
  pack_version varchar(20) NOT NULL,
  framework_code varchar(20) NOT NULL,
  edition varchar(20) NOT NULL,
  framework_version_id uuid,
  status varchar(12) NOT NULL CHECK (status IN ('validating', 'installed', 'failed', 'superseded')),
  pre_release boolean NOT NULL DEFAULT false,
  manifest jsonb NOT NULL,
  archive_sha256 char(64) NOT NULL,
  signature_key_id varchar(40) NOT NULL,
  error text,
  installed_at timestamptz,
  installed_by uuid REFERENCES platform.app_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX pack_install_installed_uq ON platform.pack_install (pack_id, pack_version) WHERE status = 'installed';
CREATE INDEX pack_install_framework_idx ON platform.pack_install (framework_code, edition);

CREATE TABLE platform.pack_catalog (
  pack_id varchar(40) NOT NULL,
  pack_version varchar(20) NOT NULL,
  channel varchar(10) NOT NULL CHECK (channel IN ('managed', 'online', 'offline')),
  note_en text NOT NULL,
  note_id text NOT NULL,
  published_at date,
  retrieved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pack_id, pack_version)
);

-- Tenant data key, wrapped by the storage-gateway KEK. The api never sees it unwrapped.
CREATE TABLE platform.tenant_key (
  organization_id uuid PRIMARY KEY REFERENCES platform.organization(id),
  wrapped_dek text NOT NULL,
  kek_id varchar(40) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz
);
SELECT platform.secure_platform_schema();
