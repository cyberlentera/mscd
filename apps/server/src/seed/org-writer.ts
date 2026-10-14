// Tenant rows of one demo organisation (build plan G.3 to G.7, mapping table G.6). Everything is written in one
// transaction on the migrator connection with platform scope and the organisation's `app.org_id`, so RLS, the
// `assert_member` trigger and the deferred constraint triggers (primary system links, default repositories, current
// document versions) check the result exactly as they check the application's writes.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql, type Insertable, type Kysely, type Transaction } from 'kysely';
import { addDays, startOfLocalDay } from '../common/dates';
import { SYSTEM_USER_ID } from '../common/tokens';
import type { DB } from '../db/types';
import type { DemoOrg, DemoUser } from './people';
import { KEYCLOAK_ORGS, KEYCLOAK_SUBJECTS } from './people';
import { planChainRecords, type ChainTable, type PlannedRecord, type SystemChainPlan } from './plan';
import { SYSTEM_PACKS, type VersionContent } from './ref-data';
import { textEn, type Pair, type SampleOrgSnapshot, type SampleSnapshotFile, type SampleStorageObject } from './snapshot';

/** A repository of the organisation as the seed prepares it before the transaction (credentials sealed). */
export interface PreparedRepository {
  id: string;
  slug: string;
  name: string;
  adapter: 'managed_vault' | 'm365' | 'google_drive';
  modes: ('stored' | 'pass_through' | 'link' | 'zero_transit')[];
  config: Record<string, unknown>;
  ownershipType: 'organizational' | 'personal';
  connectionStatus: 'ok' | 'degraded' | 'failed' | 'revoked';
  connectionStatusSince: Date;
  messages: Pair | null;
  display: Record<string, unknown>;
  lastCheckedAt: Date;
  position: number;
  /** True for the Managed Vault created by the tenant provisioning (updated, not inserted). */
  existing: boolean;
  credential: {
    ref: string;
    kind: 'm365_certificate' | 'oauth_refresh_token';
    sealedBlob: string;
    keyId: string;
    configSha256: string;
    externalAccount: string | null;
    expiresAt: Date | null;
  } | null;
}

export interface OrgSeedInput {
  org: DemoOrg;
  schema: string;
  timeZone: string;
  /** The sample organisation snapshot whose data this organisation gets (tst reuses rmn's ISMS data). */
  snapshot: SampleOrgSnapshot;
  sample: SampleSnapshotFile;
  users: ReadonlyMap<string, string>;
  demoUsers: readonly DemoUser[];
  /** The organisation each user gets as default membership (the first in G.3 order). */
  defaultOrgOf: ReadonlyMap<string, string>;
  versions: ReadonlyMap<string, VersionContent>;
  licence: { document: unknown; sha256: string; keyId: string; licenseId: string; maxUsers: number; validFrom: string; validUntil: string };
  repositories: readonly PreparedRepository[];
  /** Demo `today` (D-07: `demo.fixed_today`, else the organisation's local date). */
  today: string;
  now: Date;
  /** The seeded external auditor grant of tst (F.14): expiry of the grant and of the role. */
  grantExpiresAt: Date;
  keycloak: { issuer: string; clientId: string; providers: ReadonlyMap<string, { id: string; slug: string; clientSecretSealed: string }> } | null;
}

export interface OrgSeedSummary {
  slug: string;
  systems: number;
  members: number;
  applicabilityEntries: number;
  evidence: number;
  documents: number;
  chainRecords: number;
  activities: number;
}

type Trx = Transaction<DB>;
type Tenant = ReturnType<Trx['withSchema']>;

const CHUNK = 400;

async function insertRows<T extends keyof DB & string>(tenant: Tenant | Trx, table: T, rows: Insertable<DB[T]>[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    // Kysely's insert builder is generic over the table; the rows were built for exactly this table.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (tenant as Kysely<DB>).insertInto(table).values(rows.slice(i, i + CHUNK) as any).execute();
  }
}

const REQ_STATUS: Record<string, 'not_started' | 'planned' | 'partially_implemented' | 'complete' | 'implemented' | 'not_applicable'> = {
  ns: 'not_started',
  planned: 'planned',
  partial: 'partially_implemented',
  complete: 'complete',
  implemented: 'implemented',
  na: 'not_applicable',
  blocked: 'not_started',
};
const DOC_STATUS = { approved: 'approved', review: 'in_review', draft: 'draft', expired: 'expired' } as const;
const DOC_VERSION_STATUS = { approved: 'approved', review: 'in_review', draft: 'draft', expired: 'approved' } as const;
const ACTIVITY_STATUS = {
  verified: 'verified',
  complete: 'complete',
  progress: 'in_progress',
  ns: 'not_started',
  blocked: 'blocked',
  locked: 'not_started',
} as const;
const TUPLE_STATUS = { done: 'done', progress: 'in_progress', open: 'not_started' } as const;
const FINDING_CLASS: Record<string, 'major' | 'minor' | 'ofi'> = { Major: 'major', Minor: 'minor', OFI: 'ofi' };
const MODE_OF_LABEL: Record<string, 'stored' | 'link' | 'pass_through' | 'zero_transit'> = {
  Upload: 'stored',
  Link: 'link',
  'Pass-through': 'pass_through',
  'Zero-transit': 'zero_transit',
};
/** Shareable record types reach their systems through `entity_ms_link` (C.6). */
const SHAREABLE: ReadonlySet<ChainTable> = new Set(['context_issue', 'risk', 'metric']);
/** Titles of the internal audit findings that bring the open and major counts to the sample's `MS.findings` (G.6). */
const INTERNAL_FINDINGS: readonly { title: string; clause: Record<string, string> }[] = [
  { title: 'Risk treatment plan not approved by every risk owner', clause: { isms: '6.1.3', qms: '6.1', bcms: '8.2.3', abms: '4.5' } },
  { title: 'Access review records incomplete for two in-scope systems', clause: { isms: 'A.5.18', qms: '7.5', bcms: '7.5', abms: '7.5' } },
  { title: 'Competence records missing for new hires', clause: { isms: '7.2', qms: '7.2', bcms: '7.2', abms: '7.2' } },
  { title: 'Monitoring results not analysed this quarter', clause: { isms: '9.1', qms: '9.1', bcms: '9.1', abms: '9.1' } },
];

/** The digits of a version label (`v2.0` gives 20, `rev 3` gives 3), as the sample's next upload counts them. */
function fileSequence(ver: string): number {
  const digits = ver.replace(/\D/g, '');
  return digits === '' ? 0 : Number(digits);
}

export async function writeOrganisation(trx: Trx, input: OrgSeedInput): Promise<OrgSeedSummary> {
  const { org, snapshot, sample, today, now } = input;
  const tenant = trx.withSchema(input.schema);
  await sql`select set_config('app.org_id', ${org.id}, true), set_config('app.platform_scope', 'on', true)`.execute(trx);

  const localInstant = (date: string, time = '09:00'): Date => {
    const [h, m] = time.split(':').map(Number);
    return new Date(startOfLocalDay(date, input.timeZone).getTime() + (h! * 60 + m!) * 60_000);
  };
  const userId = (handle: string | null | undefined): string | null => {
    if (!handle || handle === 'none') return null;
    const id = input.users.get(handle);
    if (!id) throw new Error(`Organisation ${org.slug}: unknown person ${handle}`);
    return id;
  };
  const requireUser = (handle: string): string => userId(handle) ?? (() => {
    throw new Error(`Organisation ${org.slug}: a person is required`);
  })();
  const systemsOf = org.systems.map((id) => {
    const ms = snapshot.MS.find((m) => m.id === id);
    const bundle = snapshot.bundles[id];
    if (!ms || !bundle) throw new Error(`The snapshot of ${org.source} has no system ${id}`);
    const packs = SYSTEM_PACKS[id];
    if (!packs) throw new Error(`No pack is defined for system ${id}`);
    const active = input.versions.get(packs.active)!;
    const target = packs.target ? input.versions.get(packs.target)! : null;
    return { id, ms, bundle, active, target };
  });

  // ------------------------------------------------------------------------------------------------------------
  // Memberships and the licence (G.3, D-15)
  // ------------------------------------------------------------------------------------------------------------
  const members = input.demoUsers.filter((u) => u.memberships.some((m) => m.org === org.slug));
  await insertRows(
    trx,
    'platform.org_membership',
    members.map((user) => ({
      organization_id: org.id,
      user_id: requireUser(user.handle),
      admin_roles: user.memberships.find((m) => m.org === org.slug)!.adminRoles,
      status: 'active' as const,
      is_default: input.defaultOrgOf.get(user.handle) === org.slug,
      accepted_at: now,
    })),
  );
  const licenceRow = await trx
    .insertInto('platform.licence')
    .values({
      organization_id: org.id,
      license_id: input.licence.licenseId,
      document: JSON.stringify(input.licence.document),
      document_sha256: input.licence.sha256,
      key_id: input.licence.keyId,
      installed_at: localInstant(input.licence.validFrom, '08:00'),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('platform.audit_log')
    .values({
      organization_id: org.id,
      actor_user_id: SYSTEM_USER_ID,
      actor_kind: 'system',
      action: 'licence.installed',
      entity_type: 'licence',
      entity_id: licenceRow.id,
      entity_code: input.licence.licenseId,
      after_data: JSON.stringify({
        license_id: input.licence.licenseId,
        key_id: input.licence.keyId,
        valid_from: input.licence.validFrom,
        valid_until: input.licence.validUntil,
        binding: 'organization',
        source: 'seed demo',
      }),
    })
    .execute();
  // LIC-USERS (D-15): active, non-guest, non-system members within max_users, checked in this transaction.
  const active = await sql<{ count: string }>`
    select count(*)::text as count from platform.org_membership m join platform.app_user u on u.id = m.user_id
    where m.organization_id = ${org.id} and m.status = 'active' and m.deleted_at is null
      and u.kind = 'person' and u.status = 'active' and u.deleted_at is null`.execute(trx);
  const activeMembers = Number(active.rows[0]?.count ?? 0);
  if (activeMembers > input.licence.maxUsers) {
    throw new Error(`LIC-USERS: organisation ${org.slug} would have ${activeMembers} active users, more than the licence allows (${input.licence.maxUsers})`);
  }

  // ------------------------------------------------------------------------------------------------------------
  // Repositories and credentials (G.6 REPOS, LOC; D-08)
  // ------------------------------------------------------------------------------------------------------------
  const repoIds = new Map<string, string>();
  for (const repo of input.repositories) {
    repoIds.set(repo.slug, repo.id);
    const values = {
      name: repo.name,
      modes: repo.modes,
      config: JSON.stringify(repo.config),
      credential_ref: repo.credential?.ref ?? null,
      ownership_type: repo.ownershipType,
      retention_confirmed: true,
      connection_status: repo.connectionStatus,
      connection_message_en: repo.messages?.[0] ?? null,
      connection_message_id: repo.messages?.[1] ?? null,
      connection_status_since: repo.connectionStatusSince,
      last_checked_at: repo.lastCheckedAt,
      display: JSON.stringify(repo.display),
      position: repo.position,
    };
    if (repo.existing) {
      await tenant.updateTable('storage_repository').set(values).where('id', '=', repo.id).execute();
    } else {
      await tenant
        .insertInto('storage_repository')
        .values({ id: repo.id, slug: repo.slug, adapter: repo.adapter, ...values })
        .execute();
    }
    if (repo.credential) {
      await tenant
        .insertInto('storage_credential')
        .values({
          storage_repository_id: repo.id,
          credential_ref: repo.credential.ref,
          kind: repo.credential.kind,
          sealed_blob: repo.credential.sealedBlob,
          key_id: repo.credential.keyId,
          config_sha256: repo.credential.configSha256,
          external_account: repo.credential.externalAccount,
          expires_at: repo.credential.expiresAt,
        })
        .execute();
    }
  }
  const vault = input.repositories.find((r) => r.adapter === 'managed_vault');
  if (!vault) throw new Error(`Organisation ${org.slug} has no Managed Vault repository`);
  const vaultPrefix = String(vault.config.prefix);

  // ------------------------------------------------------------------------------------------------------------
  // Management systems (G.4, G.6 MS[i])
  // ------------------------------------------------------------------------------------------------------------
  const msIds = new Map<string, string>();
  const cycleIds = new Map<string, string>();
  const routingNotes = new Map<string, Pair>();
  for (const [short, , , note] of snapshot.ROUTING) {
    if (Array.isArray(note)) routingNotes.set(short, note);
  }
  for (const [position, { id, ms, active: content, target }] of systemsOf.entries()) {
    const msId = randomUUID();
    msIds.set(id, msId);
    const defaultRepository = repoIds.get(ms.loc);
    if (!defaultRepository) throw new Error(`System ${id} of ${org.slug}: no repository ${ms.loc}`);
    const certified = /^Certified\b/.test(ms.cert[0]);
    const events = snapshot.EVENTS[id] ?? [];
    const display: Record<string, unknown> = {
      certLabel: ms.cert,
      stage: ms.stage,
      phase: ms.phase,
      packLabel: ms.pack,
      gtSuggestions: sample.literals.gtSuggestions[id] ?? [],
      // Bilingual values that have no column of their own (D-06): the lead auditor when the sample names nobody,
      // the note of the default routing rule, and the event labels (`t`, `short`, `result`) by event date.
      ...(Array.isArray(ms.lead) ? { lead: ms.lead } : {}),
      ...(routingNotes.has(ms.short) ? { routingNote: routingNotes.get(ms.short) } : {}),
      eventLabels: Object.fromEntries(
        events.map((e) => [e.d, { t: e.t, ...(e.short ? { short: e.short } : {}), ...(e.result ? { result: e.result } : {}) }]),
      ),
    };
    await tenant
      .insertInto('management_system')
      .values({
        id: msId,
        slug: id,
        code: ms.short,
        name: ms.name[0],
        framework_version_id: content.version.id,
        transition_target_version_id: target?.version.id ?? null,
        scope_statement: ms.scope,
        status: certified ? 'certified' : 'implementing',
        default_storage_repository_id: defaultRepository,
        certification_body: ms.certifier,
        color: ms.color,
        display: JSON.stringify(display),
        position,
      })
      .execute();

    const certMatch = /^Certified (\d{2} [A-Z][a-z]{2} \d{4}), cycle (\d{4})\D(\d{4})/.exec(ms.cert[0]);
    const certifiedAt = certMatch ? isoOfDisplayDate(certMatch[1]!) : null;
    const cycleId = randomUUID();
    cycleIds.set(id, cycleId);
    await tenant
      .insertInto('certification_cycle')
      .values(
        certMatch && certifiedAt
          ? {
              id: cycleId,
              management_system_id: msId,
              cycle_start: certifiedAt,
              cycle_end: `${certMatch[3]}${certifiedAt.slice(4)}`,
              status: 'certified',
              certified_at: certifiedAt,
            }
          : { id: cycleId, management_system_id: msId, cycle_start: '2026-01-01', cycle_end: '2029-12-31', status: 'planned' },
      )
      .execute();
    await insertRows(tenant, 'management_system_version', [
      { management_system_id: msId, framework_version_id: content.version.id, role: 'active', activated_at: certifiedAt ?? '2026-01-01' },
      ...(target ? [{ management_system_id: msId, framework_version_id: target.version.id, role: 'transition_target' as const, activated_at: isoOfDisplayDate(snapshot.PACKS[id]!.installed) }] : []),
    ]);
    await insertRows(
      tenant,
      'clause_readiness',
      ms.clauses.map((pct, i) => ({ management_system_id: msId, clause_group: 4 + i, readiness_pct: pct, source: 'seeded' as const })),
    );
    if (ms.banner) {
      const raised = { transition: localInstant(isoOfDisplayDate(snapshot.PACKS[id]!.installed)), connector: localInstant('2026-09-27', '06:00'), beta: localInstant(isoOfDisplayDate(snapshot.PACKS[id]!.installed)) }[ms.banner.kind];
      await tenant
        .insertInto('ms_alert')
        .values({
          management_system_id: msId,
          kind: ms.banner.kind,
          tone: ms.banner.tone,
          text_en: ms.banner.text[0],
          text_id: ms.banner.text[1],
          source_ref: ms.banner.kind === 'connector' ? JSON.stringify({ repository: ms.loc }) : null,
          raised_at: raised,
        })
        .execute();
    }
    const roleRows = members.flatMap((user) =>
      user.roles(org.slug, id).map(({ role, primary }) => ({ user_id: requireUser(user.handle), management_system_id: msId, role, is_primary: primary })),
    );
    await insertRows(tenant, 'user_ms_role', roleRows);
  }

  // Default routing rule per system (G.6 ROUTING).
  for (const [short, repoName, modeLabel, note] of snapshot.ROUTING) {
    const system = systemsOf.find((s) => s.ms.short === short);
    if (!system) continue;
    const repo = input.repositories.find((r) => r.name === repoName);
    const mode = MODE_OF_LABEL[modeLabel];
    if (!repo || !mode) throw new Error(`Routing rule of ${short}: unknown repository ${repoName} or mode ${modeLabel}`);
    await tenant
      .insertInto('storage_routing_rule')
      .values({
        management_system_id: msIds.get(system.id)!,
        storage_repository_id: repo.id,
        mode,
        priority: 100,
        note: note === '-' ? null : textEn(note),
        approval_status: 'active',
      })
      .execute();
  }

  // ------------------------------------------------------------------------------------------------------------
  // Storage objects (G.6 bundles[ms].evs and .docs; the export computed them so they match the mock fixture)
  // ------------------------------------------------------------------------------------------------------------
  const insertStorageObject = async (key: string): Promise<string> => {
    const object: SampleStorageObject | undefined = sample.storage.objects[key];
    if (!object) throw new Error(`The snapshot has no storage object ${key}`);
    const repositoryId = repoIds.get(object.repo);
    if (!repositoryId) throw new Error(`Storage object ${key}: organisation ${org.slug} has no repository ${object.repo}`);
    const id = randomUUID();
    await tenant
      .insertInto('storage_object')
      .values({
        id,
        storage_repository_id: repositoryId,
        external_item_id: object.externalItemId ?? `${vaultPrefix}demo-vault-${object.code}`,
        external_version_id: object.externalVersionId,
        version_label: object.versionLabel,
        display_name: object.displayName,
        mime_type: object.mimeType,
        size_bytes: object.sizeBytes === null ? null : String(object.sizeBytes),
        hash_algorithm: object.hashAlgorithm,
        hash_value: object.hashValue,
        hash_source: object.hashSource,
        provider_created_at: new Date(object.providerCreatedAt),
        provider_modified_at: new Date(object.providerModifiedAt),
        provider_modified_by: object.providerModifiedBy,
        folder_path: object.folderPath,
        link_status: object.linkStatus,
        link_status_since: new Date(object.linkStatusSince),
        link_status_reason: object.linkStatusReason,
        last_verified_at: new Date(object.lastVerifiedAt),
        last_good_check_at: object.lastGoodCheckAt ? new Date(object.lastGoodCheckAt) : null,
      })
      .execute();
    return id;
  };

  // ------------------------------------------------------------------------------------------------------------
  // Documents (G.6 bundles[ms].docs): once per code; the shared IMS documents once per organisation
  // ------------------------------------------------------------------------------------------------------------
  const docIds = new Map<string, string>();
  const links: Insertable<DB['entity_ms_link']>[] = [];
  let documentCount = 0;
  for (const { id: system, bundle, active: content } of systemsOf) {
    const msId = msIds.get(system)!;
    const own = bundle.docs.filter((d) => !d.shared);
    const shared = bundle.docs.filter((d) => d.shared);
    for (const [group, docs] of [['own', own], ['shared', shared]] as const) {
      for (const [position, doc] of docs.entries()) {
        let docId = docIds.get(doc.id);
        const primary = !docId;
        if (!docId) {
          docId = randomUUID();
          docIds.set(doc.id, docId);
          documentCount += 1;
          const docType = content.docTypes.get(doc.tier);
          if (!docType) throw new Error(`Document ${doc.id}: no doc_type lookup for tier ${doc.tier} in ${content.version.packId}`);
          const approver = sample.literals.docApprover[system] ?? null;
          await tenant
            .insertInto('document')
            .values({
              id: docId,
              doc_code: doc.id,
              title: doc.title,
              doc_type: docType,
              status: DOC_STATUS[doc.st],
              classification: 'internal',
              owner_user_id: userId(doc.owner),
              approver_user_id: userId(approver),
              approved_at: doc.appr || null,
              next_review_at: doc.rev || null,
              is_org_wide: group === 'shared',
              position,
            })
            .execute();
          if (doc.ver !== '-') {
            const objectId = await insertStorageObject(`doc:${doc.id}`);
            const versionId = randomUUID();
            const versionStatus = DOC_VERSION_STATUS[doc.st];
            await tenant
              .insertInto('document_version')
              .values({
                id: versionId,
                document_id: docId,
                version_label: doc.ver,
                storage_object_id: objectId,
                status: versionStatus,
                approved_by: versionStatus === 'approved' ? userId(approver) : null,
                approved_at: versionStatus === 'approved' ? doc.appr || null : null,
              })
              .execute();
            await tenant.updateTable('document').set({ current_version_id: versionId }).where('id', '=', docId).execute();
          }
        }
        links.push({ entity_type: 'document', entity_id: docId, management_system_id: msId, is_primary: primary });
      }
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  // Chain records (G.6 X[ms][stage], G.7 fillers, C.10)
  // ------------------------------------------------------------------------------------------------------------
  const plans: SystemChainPlan[] = planChainRecords({
    snapshot,
    systems: org.systems,
    stageDefs: Object.fromEntries(systemsOf.map((s) => [s.id, s.active.stages])),
    driftDefs: Object.fromEntries(systemsOf.map((s) => [s.id, s.active.drift])),
    allChains: sample.snapshots[sample.orgs[0]!.id]!.CHAINS,
    primaryManager: Object.fromEntries(systemsOf.map((s) => [s.id, s.ms.mgr])),
  });
  const recordIds = new Map<string, { table: ChainTable; id: string }>(); // `<table>:<code>`, and `<code>` for lookups
  const recordByCode = new Map<string, { table: ChainTable; id: string }>();
  const references: Insertable<DB['record_reference']>[] = [];
  let chainRecordCount = 0;
  const assessedRecent = addDays(today, -30);
  const assessedStale = addDays(today, -400);
  for (const plan of plans) {
    const system = systemsOf.find((s) => s.id === plan.system)!;
    const msId = msIds.get(plan.system)!;
    const firstTarget = firstTargetOf(system.active);
    const chains = snapshot.CHAINS[plan.system] ?? [];
    for (const stage of plan.stages) {
      for (const record of stage.records) {
        const id = randomUUID();
        recordIds.set(`${record.table}:${record.code}`, { table: record.table, id });
        recordByCode.set(record.code, { table: record.table, id });
        chainRecordCount += 1;
        const common = {
          id,
          code: record.code,
          title: record.title,
          owner_user_id: userId(record.holder),
          pending_action: record.action,
          action_due_at: record.due,
          is_gate_item: record.gate,
          position: record.position,
        };
        switch (record.table) {
          case 'context_issue':
          case 'metric':
            await tenant.insertInto(record.table).values(common).execute();
            break;
          case 'risk':
            await tenant
              .insertInto('risk')
              .values({
                ...common,
                risk_profile_code: record.riskProfileCode ?? 'information_security',
                assessed_at: record.staleRisk ? assessedStale : assessedRecent,
              })
              .execute();
            break;
          case 'risk_treatment': {
            const ready = record.action === null;
            const target = ready || record.holder ? targetOf(system.active, record.down) ?? firstTarget : null;
            const riskCode = record.up.find((code) => recordIds.has(`risk:${code}`)) ?? chainRiskOf(chains, record.code);
            const riskId = riskCode ? recordIds.get(`risk:${riskCode}`)?.id ?? null : null;
            await tenant
              .insertInto('risk_treatment')
              .values({
                ...common,
                management_system_id: msId,
                risk_id: riskId,
                status: ready ? 'implemented' : record.holder ? 'in_progress' : 'proposed',
                target_type: target?.type ?? null,
                catalogue_item_id: target?.type === 'catalogue_item' ? target.id : null,
                requirement_id: target?.type === 'requirement' ? target.id : null,
                target_date: record.due,
                implemented_at: ready ? addDays(today, -60) : null,
                implemented_by_user_id: ready ? userId(record.holder) : null,
              })
              .execute();
            break;
          }
          case 'quality_objective':
          case 'prioritized_activity':
          case 'business_impact_analysis':
          case 'exercise':
          case 'business_associate':
            await tenant
              .insertInto(record.table)
              .values({ ...common, management_system_id: msId })
              .execute();
            break;
          case 'chain_record':
            await tenant
              .insertInto('chain_record')
              .values({ ...common, management_system_id: msId, stage_key: record.stage })
              .execute();
            break;
        }
        if (SHAREABLE.has(record.table)) {
          links.push({ entity_type: record.table as 'context_issue' | 'risk' | 'metric', entity_id: id, management_system_id: msId, is_primary: true });
        }
        references.push(...referencesOf(record, msId, id));
      }
    }
    for (const record of plan.justification) {
      const id = randomUUID();
      chainRecordCount += 1;
      const docId = docIds.get(record.code) ?? null;
      await tenant
        .insertInto('chain_record')
        .values({
          id,
          management_system_id: msId,
          stage_key: record.stage,
          code: record.code,
          title: record.title,
          owner_user_id: userId(record.holder),
          pending_action: record.action,
          action_due_at: record.due,
          is_gate_item: record.gate,
          position: record.position,
          related_entity_type: docId ? 'document' : null,
          related_entity_id: docId,
        })
        .execute();
      recordByCode.set(record.code, { table: 'chain_record', id });
      references.push(...referencesOf(record, msId, id));
    }
  }
  await insertRows(tenant, 'record_reference', references);

  // ------------------------------------------------------------------------------------------------------------
  // Applicability entries and evidence (G.6 bundles[ms].reqs and .evs)
  // ------------------------------------------------------------------------------------------------------------
  let entryCount = 0;
  let evidenceCount = 0;
  for (const { id: system, bundle, active: content } of systemsOf) {
    const msId = msIds.get(system)!;
    const catalogue = content.version.applicabilityTarget === 'catalogue_item';
    const entryIds = new Map<string, { id: string; type: 'catalogue_item' | 'requirement'; targetId: string }>();
    const entries: Insertable<DB['applicability_entry']>[] = [];
    const entryRisks: Insertable<DB['applicability_entry_risk']>[] = [];
    const entryDocs: Insertable<DB['applicability_entry_document']>[] = [];
    const criteria: Insertable<DB['operating_criteria']>[] = [];
    for (const [position, req] of bundle.reqs.entries()) {
      const targetId = catalogue ? content.catalogue.get(req.id) : content.requirements.get(req.key);
      if (!targetId) throw new Error(`${system} ${req.id}: not in pack ${content.version.packId}`);
      if (!content.frequencies.has(req.freq)) throw new Error(`${system} ${req.id}: frequency ${req.freq} is not in pack ${content.version.packId}`);
      const id = randomUUID();
      const type = catalogue ? ('catalogue_item' as const) : ('requirement' as const);
      entryIds.set(req.key, { id, type, targetId });
      const notApplicable = req.st === 'na';
      const chainItem = bundle.chain.items.find((item) => item.kind === 'req' && item.id === req.id);
      entries.push({
        id,
        management_system_id: msId,
        target_type: type,
        catalogue_item_id: catalogue ? targetId : null,
        requirement_id: catalogue ? null : targetId,
        is_applicable: !notApplicable,
        inclusion_justification: notApplicable ? null : req.just || null,
        exclusion_justification: notApplicable ? req.just : null,
        implementation_status: REQ_STATUS[req.st]!,
        owner_user_id: userId(req.owner),
        status_note: req.note || null,
        holds_gate: req.st === 'blocked',
        gate_reason: req.st === 'blocked' ? req.note || null : null,
        action_due_at: req.st === 'blocked' ? null : chainItem?.due ?? null,
        position,
      });
      req.risks.forEach((code, i) => {
        const risk = recordIds.get(`risk:${code}`);
        if (!risk) throw new Error(`${system} ${req.id}: risk ${code} was not seeded`);
        entryRisks.push({ applicability_entry_id: id, risk_id: risk.id, position: i });
      });
      const docId = docIds.get(req.doc);
      if (!docId) throw new Error(`${system} ${req.id}: document ${req.doc} was not seeded`);
      entryDocs.push({ applicability_entry_id: id, document_id: docId, position: 0 });
      criteria.push({ management_system_id: msId, applicability_entry_id: id, frequency_code: req.freq });
    }
    await insertRows(tenant, 'applicability_entry', entries);
    await insertRows(tenant, 'applicability_entry_risk', entryRisks);
    await insertRows(tenant, 'applicability_entry_document', entryDocs);
    await insertRows(tenant, 'operating_criteria', criteria);
    entryCount += entries.length;

    for (const [position, e] of bundle.evs.entries()) {
      const entry = entryIds.get(e.ctrlKey);
      if (!entry) throw new Error(`${system} evidence ${e.code}: no applicability entry ${e.ctrl}`);
      const objectId = await insertStorageObject(`ev:${e.code}`);
      const evidenceId = randomUUID();
      const computedNext = e.p > 0 ? addDays(e.prod, e.p) : null;
      await tenant
        .insertInto('evidence')
        .values({
          id: evidenceId,
          evidence_code: e.code,
          title: e.title,
          owner_user_id: userId(e.owner),
          produced_at: e.prod,
          storage_object_id: objectId,
          frequency_code: e.freq,
          classification: 'internal',
          next_due_override: e.next !== computedNext ? e.next : null,
          file_sequence: fileSequence(e.ver),
          position,
        })
        .execute();
      await tenant
        .insertInto('evidence_target')
        .values({
          evidence_id: evidenceId,
          management_system_id: msId,
          applicability_entry_id: entry.id,
          target_type: entry.type,
          catalogue_item_id: entry.type === 'catalogue_item' ? entry.targetId : null,
          requirement_id: entry.type === 'requirement' ? entry.targetId : null,
          position: 0,
        })
        .execute();
      links.push({ entity_type: 'evidence', entity_id: evidenceId, management_system_id: msId, is_primary: true });
      evidenceCount += 1;
    }
  }
  await insertRows(tenant, 'entity_ms_link', links);

  // ------------------------------------------------------------------------------------------------------------
  // Phases and activities (G.6 bundles[ms].phases, D-13, D-30)
  // ------------------------------------------------------------------------------------------------------------
  let activityCount = 0;
  for (const { id: system, bundle, active: content } of systemsOf) {
    const msId = msIds.get(system)!;
    const rows: Insertable<DB['implementation_activity_progress']>[] = [];
    for (const phase of bundle.phases) {
      for (const act of phase.acts) {
        const template = content.activities.get(act.no);
        if (!template) throw new Error(`${system} activity ${act.no}: no template in pack ${content.version.packId}`);
        const verified = act.st === 'verified';
        const outputCode = template.outputDocumentCode ?? act.out;
        rows.push({
          management_system_id: msId,
          activity_template_id: template.id,
          phase_no: template.phaseNo,
          activity_no: template.activityNo,
          title: template.title,
          clause_ref: template.clauseRef,
          output_document_code: template.outputDocumentCode,
          expected_outcome: template.expectedOutcome,
          is_gate_phase: template.isGatePhase,
          template_pack_version: content.version.packVersion,
          owner_user_id: userId(act.owner),
          status: ACTIVITY_STATUS[act.st],
          output_document_id: outputCode ? docIds.get(outputCode) ?? null : null,
          blocker_gate_item_ref: act.blocker,
          blocker_reason: act.blocker ? `Blocked by gate item ${act.blocker}` : null,
          due_at: verified || act.st === 'locked' ? null : act.date,
          verified_at: verified ? act.date : null,
          completed_at: verified ? act.date : null,
        });
      }
    }
    await insertRows(tenant, 'implementation_activity_progress', rows);
    activityCount += rows.length;
  }

  // ------------------------------------------------------------------------------------------------------------
  // Certification cycle: events, preparation, findings, cycle items, drift results, chains (G.6)
  // ------------------------------------------------------------------------------------------------------------
  let findingNumber = 0;
  for (const { id: system, ms, active: content } of systemsOf) {
    const msId = msIds.get(system)!;
    const cycleId = cycleIds.get(system)!;
    const events = snapshot.EVENTS[system] ?? [];
    const eventIds: { id: string; date: string; next: boolean }[] = [];
    for (const event of events) {
      const id = randomUUID();
      const next = event.next === true;
      const names: Pair = next && ms.audit ? ms.audit.name : event.t;
      const focus = snapshot.FOCUS[system];
      await tenant
        .insertInto('audit_event')
        .values({
          id,
          management_system_id: msId,
          certification_cycle_id: cycleId,
          event_type: event.type ?? eventTypeOf(event.t[0]),
          name_en: names[0],
          name_id: names[1],
          short_label: event.t[0],
          scheduled_at: event.d,
          audit_days: event.days,
          lead_auditor_name: next && typeof ms.lead === 'string' && ms.lead !== '-' ? ms.lead : null,
          expected_focus: next && focus && focus !== '-' ? focus : null,
          prep_window_days: next ? ms.audit?.prepWindowDays ?? 60 : 60,
          outcome: event.outcome ?? null,
          outcome_summary: event.result ? event.result[0] : null,
        })
        .execute();
      eventIds.push({ id, date: event.d, next });
    }
    const nextEvent = eventIds.find((e) => e.next);
    const prep = snapshot.PREP[system] ?? [];
    if (prep.length > 0) {
      if (!nextEvent) throw new Error(`${system}: preparation tasks without a next audit event`);
      await insertRows(
        tenant,
        'audit_prep_task',
        prep.map(([title, owner, due, status], position) => ({
          audit_event_id: nextEvent.id,
          management_system_id: msId,
          template_code: content.prepTemplates.find((t) => t.title === title)?.code ?? null,
          title,
          owner_user_id: userId(owner),
          due_at: due,
          status: TUPLE_STATUS[status],
          position,
        })),
      );
    }

    // Certification audit findings, then internal audit findings up to the sample's open and major counts.
    const latestPast = [...eventIds].filter((e) => e.date < today).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    const past = snapshot.PAST[system] ?? [];
    const findingRows: Insertable<DB['finding']>[] = past.map(([code, label, clause, title, state, note], position) => {
      const classification = FINDING_CLASS[label];
      if (!classification) throw new Error(`${system} finding ${code}: unknown classification ${label}`);
      const closedNote = /^Closed (\d{2} [A-Z][a-z]{2} \d{4})/.exec(note);
      const raised = latestPast?.date ?? today;
      return {
        management_system_id: msId,
        framework_version_id: content.version.id,
        audit_event_id: latestPast?.id ?? null,
        code,
        title,
        classification,
        clause_ref: clause,
        source: 'certification_audit',
        status: state === 'closed' ? 'closed' : 'open',
        status_note: note || null,
        owner_user_id: userId(ms.mgr),
        raised_at: raised,
        closed_at: state === 'closed' ? (closedNote ? isoOfDisplayDate(closedNote[1]!) : addDays(raised, 90)) : null,
        position,
      };
    });
    const openPast = findingRows.filter((f) => f.status !== 'closed');
    const needMajor = ms.findings.major - openPast.filter((f) => f.classification === 'major').length;
    const needOpen = ms.findings.open - openPast.length;
    if (needMajor < 0 || needOpen < needMajor) {
      throw new Error(`${system}: the certification findings exceed MS.findings (${JSON.stringify(ms.findings)})`);
    }
    for (let i = 0; i < needOpen; i++) {
      findingNumber += 1;
      const text = INTERNAL_FINDINGS[(findingNumber - 1) % INTERNAL_FINDINGS.length]!;
      findingRows.push({
        management_system_id: msId,
        framework_version_id: content.version.id,
        audit_event_id: null,
        code: `IA-2026-${String(findingNumber).padStart(2, '0')}`,
        title: text.title,
        classification: i < needMajor ? 'major' : 'minor',
        clause_ref: text.clause[system] ?? null,
        source: 'internal_audit',
        status: 'open',
        owner_user_id: userId(ms.mgr),
        raised_at: addDays(today, -14),
        position: findingRows.length,
      });
    }
    await insertRows(tenant, 'finding', findingRows);

    const cycleItems = snapshot.CYCLE_ITEMS[system] ?? [];
    await insertRows(
      tenant,
      'cycle_requirement_status',
      cycleItems.map(([code, title, owner, due, status, note], position) => ({
        management_system_id: msId,
        certification_cycle_id: cycleId,
        cycle_requirement_def_id: content.cycleDefs.find((d) => d.title === title)?.id ?? null,
        requirement_code: code,
        title,
        owner_user_id: userId(owner),
        status: TUPLE_STATUS[status],
        due_at: due,
        condition_note: note || null,
        position,
      })),
    );

    const driftRows: Insertable<DB['drift_result']>[] = [];
    for (const rule of snapshot.DRIFT[system] ?? []) {
      if (!rule.rows || rule.rows.length === 0) continue;
      const def = content.drift.find((d) => d.code === rule.id);
      if (!def) throw new Error(`${system} drift rule ${rule.id}: not in pack ${content.version.packId}`);
      rule.rows.forEach(([code, title, holder, due], position) => {
        const record = def.sourceStage ? recordByCode.get(code) : undefined;
        driftRows.push({
          management_system_id: msId,
          drift_rule_def_id: def.id,
          rule_code: rule.id,
          entity_type: record?.table ?? null,
          entity_id: record?.id ?? null,
          entity_code: code,
          title,
          holder_user_id: userId(holder),
          due_at: due,
          detected_at: now,
          position,
        });
      });
    }
    await insertRows(tenant, 'drift_result', driftRows);

    for (const [position, chain] of (snapshot.CHAINS[system] ?? []).entries()) {
      const instanceId = randomUUID();
      await tenant
        .insertInto('trace_chain_instance')
        .values({ id: instanceId, management_system_id: msId, anchor_code: chain.id, position })
        .execute();
      await insertRows(
        tenant,
        'trace_chain_node',
        chain.nodes.map(([stage, code], i) => ({ trace_chain_instance_id: instanceId, position: i, stage_key: stage, record_code: code })),
      );
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  // External auditor grant of tst (G.3, F.14) and the Keycloak provider (G.3)
  // ------------------------------------------------------------------------------------------------------------
  const guest = input.demoUsers.find((u) => u.kind === 'guest' && u.memberships.some((m) => m.org === org.slug));
  if (guest && msIds.has('isms')) {
    const roleId = randomUUID();
    await tenant
      .insertInto('user_ms_role')
      .values({ id: roleId, user_id: requireUser(guest.handle), management_system_id: msIds.get('isms')!, role: 'external_auditor', valid_until: input.grantExpiresAt })
      .execute();
    const issuer = systemsOf.find((s) => s.id === 'isms')!.ms.mgr;
    await tenant
      .insertInto('auditor_access_grant')
      .values({
        management_system_id: msIds.get('isms')!,
        email: guest.email,
        user_id: requireUser(guest.handle),
        user_ms_role_id: roleId,
        // The link was used already (G.3): the token is random and never shown; the guest signs in with a code and TOTP.
        token_hash: createHash('sha256').update(randomBytes(32)).digest(),
        link_used_at: now,
        expires_at: input.grantExpiresAt,
        created_by: userId(issuer),
        updated_by: userId(issuer),
      })
      .execute();
  }
  if (input.keycloak && KEYCLOAK_ORGS.includes(org.slug)) {
    const provider = input.keycloak.providers.get(org.slug);
    if (!provider) throw new Error(`No Keycloak provider prepared for ${org.slug}`);
    await trx
      .insertInto('platform.identity_provider')
      .values({
        id: provider.id,
        organization_id: org.id,
        slug: provider.slug,
        kind: 'oidc',
        display_name: 'Sign in with Keycloak',
        icon: 'generic',
        enabled: true,
        oidc_issuer: input.keycloak.issuer,
        oidc_client_id: input.keycloak.clientId,
        oidc_client_secret_sealed: provider.clientSecretSealed,
        require_mfa_claim: true,
        mfa_fallback: 'local_totp',
      })
      .execute();
    const subjects = Object.entries(KEYCLOAK_SUBJECTS).filter(([handle]) => members.some((m) => m.handle === handle));
    await insertRows(
      trx,
      'platform.user_identity',
      subjects.map(([handle, subject]) => ({
        identity_provider_id: provider.id,
        subject,
        user_id: requireUser(handle),
        email_at_link: input.demoUsers.find((u) => u.handle === handle)!.email,
        link_method: 'admin' as const,
      })),
    );
  }

  return {
    slug: org.slug,
    systems: systemsOf.length,
    members: activeMembers,
    applicabilityEntries: entryCount,
    evidence: evidenceCount,
    documents: documentCount,
    chainRecords: chainRecordCount,
    activities: activityCount,
  };
}

/** Record references of an explicit record (`up` and `down`, D-11). */
function referencesOf(record: PlannedRecord, msId: string, entityId: string): Insertable<DB['record_reference']>[] {
  return [
    ...record.up.map((code, position) => ({ management_system_id: msId, entity_type: record.table, entity_id: entityId, direction: 'up' as const, target_code: code, position })),
    ...record.down.map((code, position) => ({ management_system_id: msId, entity_type: record.table, entity_id: entityId, direction: 'down' as const, target_code: code, position })),
  ];
}

/** The first catalogue item or requirement of a framework version (target of ready treatments, G.7). */
function firstTargetOf(content: VersionContent): { type: 'catalogue_item' | 'requirement'; id: string } {
  if (content.version.applicabilityTarget === 'catalogue_item') {
    const first = content.catalogue.values().next().value;
    if (first) return { type: 'catalogue_item', id: first };
  }
  const first = content.requirements.values().next().value;
  if (!first) throw new Error(`Pack ${content.version.packId} has no requirement`);
  return { type: 'requirement', id: first };
}

/** The first `down` code that names a catalogue item (`A.8.2`) or requirement (`Cl. 8.3`) of the version. */
function targetOf(content: VersionContent, codes: readonly string[]): { type: 'catalogue_item' | 'requirement'; id: string } | null {
  for (const code of codes) {
    const item = content.catalogue.get(code);
    if (item) return { type: 'catalogue_item', id: item };
    const requirement = content.requirements.get(code.replace(/^Cl\. /, ''));
    if (requirement) return { type: 'requirement', id: requirement };
  }
  return null;
}

/** The risk of the chain a treatment code belongs to (chains name risk and treatment of one thread, D-11). */
function chainRiskOf(chains: SampleOrgSnapshot['CHAINS'][string], code: string): string | null {
  for (const chain of chains) {
    if (chain.nodes.some(([, c]) => c === code)) return chain.nodes.find(([stage]) => stage === 'risk')?.[1] ?? null;
  }
  return null;
}

/** Audit event type from its sample label (G.6). */
function eventTypeOf(label: string): 'stage1' | 'stage2' | 'surveillance' | 'recertification' | 'special' {
  if (/^Stage 1\b/.test(label)) return 'stage1';
  if (/^Stage 2\b/.test(label)) return 'stage2';
  if (/^Surveillance\b/.test(label)) return 'surveillance';
  if (/^Recert/.test(label)) return 'recertification';
  return 'special';
}

const MONTHS: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

/** `14 Mar 2025` (sample display date) to `2025-03-14`. */
export function isoOfDisplayDate(text: string): string {
  const match = /^(\d{2}) ([A-Z][a-z]{2}) (\d{4})$/.exec(text.trim());
  const month = match ? MONTHS[match[2]!] : undefined;
  if (!match || !month) throw new Error(`Not a sample display date: ${text}`);
  return `${match[3]}-${month}-${match[1]}`;
}

/** `29 Sep 2026 06:00` (sample display date and time) in a time zone, as an instant. */
export function instantOfDisplayDateTime(text: string, timeZone: string): Date {
  const match = /^(\d{2} [A-Z][a-z]{2} \d{4}) (\d{2}):(\d{2})$/.exec(text.trim());
  if (!match) throw new Error(`Not a sample display date and time: ${text}`);
  return new Date(startOfLocalDay(isoOfDisplayDate(match[1]!), timeZone).getTime() + (Number(match[2]) * 60 + Number(match[3])) * 60_000);
}

