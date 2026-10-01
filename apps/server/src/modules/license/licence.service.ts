// Licence verification, installation and evaluation (D-15, D-16, D-32). A licence is verified with the licence keys
// compiled into the build (refusing development keys in a release build), must bind to this installation or to the
// organisation (an unbound licence only as a trial of at most 90 days), and is stored as the signed document. The
// state and the entitlements are derived on every evaluation from the verified document and the clock; the
// verification itself is cached in memory by the hash of the canonical document.
import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import {
  LicenceDocument,
  canonicalJson,
  type LicenceFeature,
  type LicenceInstallRequest,
  type LicenceState,
  type LicenceView,
  type Messages,
  type StorageAdapter,
} from '@mscd/shared';
import { LicenceError, verifyLicence } from '@mscd/pack-tools';
import { sql } from 'kysely';
import { Clock, DEFAULT_TIME_ZONE } from '../../common/clock';
import { fmtDay } from '../../common/dates';
import { JOB_QUEUE, type JobQueue } from '../../common/jobs/job-queue';
import { BusinessRuleError, NotFoundError, ValidationError } from '../../common/problems';
import {
  AUDIT_WRITER,
  NOTIFICATION_WRITER,
  SYSTEM_USER_ID,
  type AuditWriter,
  type NotificationWriter,
  type Principal,
  type TenantInfo,
  type Trx,
} from '../../common/tokens';
import { acceptsAfterCommit, afterCommit } from '../../common/transaction-hooks';
import { MscdConfig } from '../../config/mscd-config';
import { TenantResolver } from '../tenancy/tenant-resolver';
import { TenantScope, systemContextOf } from '../tenancy/tenant-scope';
import {
  LICENCE_EXPIRY_WARNING_DAYS,
  evaluateLicenceState,
  type LicenceStateResult,
} from './licence-state';
import { TRUST_ANCHORS, type TrustAnchors } from './trust-anchors';

/** A licence row of `platform.licence` (the current one of an organisation). */
export interface LicenceRecord {
  id: string;
  organizationId: string;
  licenseId: string;
  document: Record<string, unknown>;
  documentSha256: string;
  keyId: string;
  installedAt: Date;
}

/** What a binding names (`LicenceView.binding`). */
export interface LicenceBindingView {
  installationId?: string;
  organizationId?: string;
  trial: boolean;
}

/** The current licence of an organisation with its derived state (nothing of this is stored, D-15). */
export interface EvaluatedLicence extends LicenceStateResult {
  record: LicenceRecord;
  /** The document as the licence schema reads it; null when it no longer matches the schema. */
  document: LicenceDocument | null;
  /** Signature, key and binding checked against this build and this installation. */
  verified: boolean;
  /** Why the stored licence does not verify (then the state is `read_only` and nothing is licensed). */
  problem: string | null;
  binding: LicenceBindingView;
}

/** Display labels of the licence features (G.5 `LICENCE.features`). */
export const FEATURE_LABELS: Readonly<Record<LicenceFeature, Messages>> = {
  integrated_mode: { en: 'Integrated Management System', id: 'Sistem Manajemen Terintegrasi' },
  edition_transition: { en: 'Edition Transition Assistant', id: 'Asisten Transisi Edisi' },
  link_health_monitor: { en: 'Link Health Monitor', id: 'Pemantau Kesehatan Tautan' },
  auditor_guest_access: { en: 'Auditor guest access', id: 'Akses tamu auditor' },
};

/** Most verification results kept in memory (one per distinct licence document). */
const VERIFIED_CACHE_SIZE = 512;
/** A clock rollback is audited at most once per organisation and hour from request paths. */
const ROLLBACK_AUDIT_INTERVAL_MS = 60 * 60 * 1000;

interface VerifiedDocument {
  document: LicenceDocument;
  keyId: string;
  binding: { kind: 'installation' | 'organization'; id: string } | { kind: 'trial' };
}

/** SHA-256 of the canonical form of a licence document (cache key and `platform.licence.document_sha256`). */
export function licenceDocumentSha256(document: unknown): string {
  return createHash('sha256').update(canonicalJson(document), 'utf8').digest('hex');
}

/** The `LicenceDocument` members of a stored document, or null when it no longer parses. */
function parseDocument(document: unknown): LicenceDocument | null {
  const parsed = LicenceDocument.safeParse(document);
  return parsed.success ? parsed.data : null;
}

function bindingView(document: Record<string, unknown>): LicenceBindingView {
  const view: LicenceBindingView = { trial: document.trial === true };
  if (typeof document.installation_id === 'string') view.installationId = document.installation_id;
  if (typeof document.organization_id === 'string') view.organizationId = document.organization_id;
  return view;
}

@Injectable()
export class LicenceService implements OnModuleInit {
  private readonly logger = new Logger('Licence');
  private readonly verified = new Map<string, VerifiedDocument>();
  private readonly throttle = new Map<string, number>();
  private installationId: string | null = null;
  private readonly clock: Clock;

  constructor(
    private readonly config: MscdConfig,
    @Inject(TRUST_ANCHORS) private readonly trust: TrustAnchors,
    @Optional() private readonly scope?: TenantScope,
    @Optional() private readonly tenants?: TenantResolver,
    @Optional() clock?: Clock,
    @Optional() @Inject(AUDIT_WRITER) private readonly audit?: AuditWriter,
    @Optional() @Inject(NOTIFICATION_WRITER) private readonly notifications?: NotificationWriter,
    @Optional() @Inject(JOB_QUEUE) private readonly jobs?: JobQueue,
  ) {
    this.clock = clock ?? new Clock(config);
  }

  /**
   * The api and worker always load the tenancy and database modules. Only request-pipeline unit tests on the test
   * profile compose the licence module without them; there the gate has no licence to read and nothing is licensed
   * except plain writes. Any other profile without them is a wiring error.
   */
  onModuleInit(): void {
    if (this.scope && this.tenants) return;
    if (this.config.profile.test === undefined) {
      throw new Error('LicenseModule needs TenancyModule and DatabaseModule: the licence cannot be evaluated without them (D-15)');
    }
    this.logger.warn('LicenseModule runs without a database (test profile): no licence can be read in this application');
  }

  // -------------------------------------------------------------------------------------------------------------
  // Verification
  // -------------------------------------------------------------------------------------------------------------

  /**
   * Verifies a licence document with the compiled licence keys (D-16): schema, key id (development keys refused in a
   * release build), Ed25519 signature and the binding rule. Throws `LicenceError`. Cached by document hash.
   */
  verifyDocument(document: unknown): VerifiedDocument {
    const sha = licenceDocumentSha256(document);
    const cached = this.verified.get(sha);
    if (cached) return cached;
    const result = verifyLicence(document, this.trust.keys, { rejectKeyIds: this.trust.rejectKeyIds });
    const entry: VerifiedDocument = { document: result.document, keyId: result.keyId, binding: result.binding };
    if (this.verified.size >= VERIFIED_CACHE_SIZE) this.verified.delete(this.verified.keys().next().value as string);
    this.verified.set(sha, entry);
    return entry;
  }

  /** `platform.installation.id` (read once). */
  async installationIdOf(trx: Trx): Promise<string> {
    if (this.installationId) return this.installationId;
    const row = await trx.selectFrom('platform.installation').select('id').executeTakeFirstOrThrow();
    this.installationId = row.id;
    return row.id;
  }

  /** Null when the binding fits this installation and organisation, else why it does not (D-15, LIC-BINDING). */
  private async bindingProblem(trx: Trx, verified: VerifiedDocument, orgId: string): Promise<string | null> {
    const binding = verified.binding;
    if (binding.kind === 'trial') return null;
    if (binding.kind === 'organization') {
      return binding.id === orgId ? null : `the licence is bound to organisation ${binding.id}, not to this organisation`;
    }
    const installationId = await this.installationIdOf(trx);
    return binding.id === installationId ? null : `the licence is bound to installation ${binding.id}, not to this installation`;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Evaluation
  // -------------------------------------------------------------------------------------------------------------

  /** The current licence row of an organisation (RLS: the transaction's organisation or platform scope). */
  async currentRecord(trx: Trx, orgId: string): Promise<LicenceRecord | null> {
    const row = await trx
      .selectFrom('platform.licence')
      .select(['id', 'organization_id', 'license_id', 'document', 'document_sha256', 'key_id', 'installed_at'])
      .where('organization_id', '=', orgId)
      .where('superseded_at', 'is', null)
      .executeTakeFirst();
    if (!row) return null;
    return {
      id: row.id,
      organizationId: row.organization_id,
      licenseId: row.license_id,
      document: row.document as Record<string, unknown>,
      documentSha256: row.document_sha256,
      keyId: row.key_id,
      installedAt: row.installed_at,
    };
  }

  /** The time zone of an organisation (the C.4 default when unknown). */
  private async timeZoneOf(orgId: string): Promise<string> {
    return (await this.tenants?.resolveById(orgId))?.timeZone ?? DEFAULT_TIME_ZONE;
  }

  /**
   * Evaluates the current licence of an organisation in the caller's transaction: verification (cached), binding,
   * and the state at today's date with the clock high-water rule (D-15). Null when no licence is installed. A clock
   * rollback is logged and audited after the transaction commits (at most once per organisation and hour), unless
   * `reportRollback` is false because the caller records it itself.
   */
  async evaluate(trx: Trx, orgId: string, options: { reportRollback?: boolean } = {}): Promise<EvaluatedLicence | null> {
    const record = await this.currentRecord(trx, orgId);
    if (!record) return null;
    const timeZone = await this.timeZoneOf(orgId);
    const mark = await trx.selectFrom('platform.clock_mark').select('high_water').executeTakeFirst();
    const highWater = mark?.high_water ?? null;
    const now = this.clock.now();
    const today = this.clock.todayIn(timeZone);
    const document = parseDocument(record.document);

    let problem: string | null = null;
    try {
      const verified = this.verifyDocument(record.document);
      problem = await this.bindingProblem(trx, verified, orgId);
    } catch (error) {
      problem = error instanceof LicenceError ? firstLine(error.message) : `the licence cannot be verified (${(error as Error).message})`;
    }
    const validity = document ?? { valid_from: today, valid_until: today, grace_days: 0 };
    const result = evaluateLicenceState(validity, { today, now, highWater, timeZone });
    const verifiedOk = problem === null && document !== null;
    const evaluated: EvaluatedLicence = {
      ...result,
      state: verifiedOk ? result.state : 'read_only',
      record,
      document,
      verified: verifiedOk,
      problem: verifiedOk ? null : (problem ?? 'the stored licence does not match the licence schema'),
      binding: bindingView(record.document),
    };
    if (!verifiedOk && this.due(`${orgId}:unverified`)) {
      this.logger.error({ orgId, licenseId: record.licenseId, problem: evaluated.problem }, 'The installed licence does not verify: the organisation is read-only');
    }
    if (result.clockRollback && options.reportRollback !== false && this.due(`${orgId}:rollback`)) {
      const report = () => this.reportRollback(orgId, highWater, now);
      // Never write the platform audit log from inside the caller's transaction here: it may hold the chain lock.
      if (acceptsAfterCommit(trx)) afterCommit(trx, report);
      else void report();
    }
    return evaluated;
  }

  /** `evaluate` in a transaction of its own (the guard's read-only check). Null without a licence or a database. */
  async evaluateOrg(orgId: string): Promise<EvaluatedLicence | null> {
    if (!this.scope || !this.tenants) return null;
    const org = await this.tenants.resolveById(orgId);
    if (!org) return null;
    return this.scope.withTenant(systemContextOf(org), (trx) => this.evaluate(trx, orgId));
  }

  /** True at most once per key and hour (log and audit throttle of request paths). */
  private due(key: string): boolean {
    const last = this.throttle.get(key) ?? 0;
    if (Date.now() - last < ROLLBACK_AUDIT_INTERVAL_MS) return false;
    if (this.throttle.size > 10_000) this.throttle.clear();
    this.throttle.set(key, Date.now());
    return true;
  }

  /** D-15 clock rollback: an operator warning in the log and `licence.clock_rollback` in the platform audit log. */
  private async reportRollback(orgId: string, highWater: Date | null, now: Date): Promise<void> {
    this.logger.warn(
      { orgId, highWater: highWater?.toISOString() ?? null, now: now.toISOString() },
      'The system clock is more than 24 hours behind the licence clock high-water mark: the licence is evaluated at the high-water mark and is in grace at least (D-15)',
    );
    try {
      await this.audit?.recordDetached({
        action: 'licence.clock_rollback',
        actor: { userId: SYSTEM_USER_ID, kind: 'system' },
        organizationId: orgId,
        entityType: 'licence',
        after: { highWater: highWater?.toISOString() ?? null, now: now.toISOString() },
      });
    } catch (error) {
      this.logger.error(`Could not audit the clock rollback of organisation ${orgId}: ${(error as Error).message}`);
    }
  }

  /** Active, non-guest, non-system members of the organisation (D-15 `max_users`). */
  async countActiveUsers(trx: Trx, orgId: string): Promise<number> {
    const row = await trx
      .selectFrom('platform.org_membership as m')
      .innerJoin('platform.app_user as u', 'u.id', 'm.user_id')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('m.organization_id', '=', orgId)
      .where('m.status', '=', 'active')
      .where('m.deleted_at', 'is', null)
      .where('u.kind', '=', 'person')
      .where('u.status', '=', 'active')
      .where('u.deleted_at', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /** Management systems that count against `max_management_systems`: not deleted and not archived. */
  async countManagementSystems(trx: Trx): Promise<number> {
    const row = await trx
      .selectFrom('management_system')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('deleted_at', 'is', null)
      .where('status', '<>', 'archived')
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /** Serialises licence-limited additions of one organisation for the rest of the transaction. */
  async lockLimit(trx: Trx, orgId: string, limit: 'users' | 'management_systems'): Promise<void> {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`licence-${limit}:${orgId}`}, 0))`.execute(trx);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Views and installation
  // -------------------------------------------------------------------------------------------------------------

  /** `LicenceView` of an evaluated licence; the transaction must be a tenant transaction of the organisation. */
  async viewOf(trx: Trx, orgId: string, evaluated: EvaluatedLicence): Promise<LicenceView> {
    const doc = evaluated.document;
    if (!doc) throw new Error(`The stored licence ${evaluated.record.licenseId} does not match the licence schema`);
    const [activeUsers, managementSystems] = await Promise.all([this.countActiveUsers(trx, orgId), this.countManagementSystems(trx)]);
    return {
      licenseId: doc.license_id,
      organization: doc.organization,
      binding: evaluated.binding,
      validFrom: doc.valid_from,
      validUntil: doc.valid_until,
      graceDays: doc.grace_days,
      state: evaluated.state,
      clockRollback: evaluated.clockRollback,
      frameworks: [...doc.frameworks],
      maxManagementSystems: doc.max_management_systems,
      maxUsers: doc.max_users,
      activeUsers,
      managementSystems,
      storageAdapters: [...doc.storage_adapters],
      features: [...doc.features],
      signature: { alg: 'Ed25519', keyId: evaluated.record.keyId, verified: evaluated.verified, offline: this.config.profile.license.validation === 'offline' },
    };
  }

  /** `GET /license`: the licence of the caller's organisation (404 when none is installed). */
  async viewForPrincipal(principal: Principal): Promise<LicenceView> {
    const org = principal.org;
    if (!org) throw new NotFoundError('No organisation is selected');
    return this.requireScope().withTenant({ orgId: org.id, schema: org.schema, userId: principal.user.id }, async (trx) => {
      const evaluated = await this.evaluate(trx, org.id);
      if (!evaluated) throw new NotFoundError('No licence is installed for this organisation');
      return this.viewOf(trx, org.id, evaluated);
    });
  }

  /**
   * `PUT /admin/license` (D-15, D-32): verifies and installs a signed licence for the caller's organisation (single
   * tenancy) or, for the platform operator with multi tenancy, for the organisation named in the body. The previous
   * licence is superseded; installing the same document again changes nothing.
   */
  async install(principal: Principal, body: LicenceInstallRequest): Promise<LicenceView> {
    const target = await this.targetOrganisation(principal, body);
    const document: unknown = isWrapped(body) ? body.licence : body;
    const scope = this.requireScope();

    let verified: VerifiedDocument;
    try {
      verified = this.verifyDocument(document);
    } catch (error) {
      if (!(error instanceof LicenceError)) throw error;
      await this.auditRejected(target, document, error.code, error.message);
      throw licenceProblem(error);
    }
    const bindingProblem = await scope.withTenant(systemContextOf(target), (trx) => this.bindingProblem(trx, verified, target.id));
    if (bindingProblem) {
      await this.auditRejected(target, document, 'binding', bindingProblem);
      throw bindingRuleError(bindingProblem);
    }

    const sha = licenceDocumentSha256(document);
    return scope.withTenant({ orgId: target.id, schema: target.schema, userId: principal.user.id }, async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`licence-install:${target.id}`}, 0))`.execute(trx);
      const current = await this.currentRecord(trx, target.id);
      if (current?.documentSha256 !== sha) {
        if (current) {
          await trx.updateTable('platform.licence').set({ superseded_at: new Date() }).where('id', '=', current.id).execute();
        }
        const row = await trx
          .insertInto('platform.licence')
          .values({
            organization_id: target.id,
            license_id: verified.document.license_id,
            document: JSON.stringify(document),
            document_sha256: sha,
            key_id: verified.keyId,
            installed_by: principal.user.id,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await this.audit?.record(trx, {
          action: 'licence.installed',
          actor: { userId: principal.user.id, kind: this.config.profile.tenancy.mode === 'multi' && !principal.org ? 'operator' : 'user' },
          organizationId: target.id,
          entityType: 'licence',
          entityId: row.id,
          entityCode: verified.document.license_id,
          before: current ? { license_id: current.licenseId, key_id: current.keyId } : null,
          after: {
            license_id: verified.document.license_id,
            key_id: verified.keyId,
            valid_from: verified.document.valid_from,
            valid_until: verified.document.valid_until,
            binding: verified.binding.kind,
          },
        });
        // Alerts, read-only repositories and notifications follow the new licence right away (E.2 license.check).
        const jobs = this.jobs;
        if (jobs) {
          afterCommit(trx, async () => {
            await jobs.send('license.check', { orgId: target.id, requestedBy: principal.user.id, payload: {} }, { singletonKey: `lc:${target.id}:${row.id}`, retryLimit: 3 });
          });
        }
      }
      const evaluated = await this.evaluate(trx, target.id);
      if (!evaluated) throw new Error('The licence just installed cannot be read back');
      return this.viewOf(trx, target.id, evaluated);
    });
  }

  /** The organisation a licence upload is for (D-32: the operator names it with multi tenancy). */
  private async targetOrganisation(principal: Principal, body: LicenceInstallRequest): Promise<TenantInfo> {
    const tenants = this.requireTenants();
    const multi = this.config.profile.tenancy.mode === 'multi';
    if (isWrapped(body)) {
      const target = await tenants.resolveBySlug(body.org);
      if (!target) throw new NotFoundError(`Unknown organisation ${body.org}`);
      if (!multi && principal.org?.id !== target.id) throw new NotFoundError(`Unknown organisation ${body.org}`);
      return target;
    }
    if (multi) {
      throw new ValidationError([{ path: 'body.org', message: 'With tenancy.mode multi the body is {org, licence}: name the organisation the licence is for' }]);
    }
    if (!principal.org) throw new NotFoundError('No organisation is selected');
    return principal.org;
  }

  private async auditRejected(target: TenantInfo, document: unknown, code: string, message: string): Promise<void> {
    const licenseId = typeof document === 'object' && document !== null && typeof (document as { license_id?: unknown }).license_id === 'string'
      ? ((document as { license_id: string }).license_id).slice(0, 80)
      : null;
    try {
      await this.audit?.recordDetached({
        action: 'licence.rejected',
        organizationId: target.id,
        entityType: 'licence',
        entityCode: licenseId,
        after: { reason: code, message: message.slice(0, 500) },
      });
    } catch (error) {
      this.logger.error(`Could not audit a rejected licence: ${(error as Error).message}`);
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // license.check (E.2)
  // -------------------------------------------------------------------------------------------------------------

  /**
   * The daily licence check of one organisation (E.2 `license.check`): state changes are audited
   * (`licence.state_changed`) and notified to Tenant Admins (`licence_state`), the `licence` alert of every system is
   * raised, replaced or resolved, Tenant Admins get `licence_expiring` 60, 30 and 7 days before `valid_until`, and
   * repositories whose adapter is not licensed become read-only (TS 5.7). Idempotent; never writes `ref`.
   */
  async checkOrganisation(orgId: string): Promise<{ state: LicenceState | 'none'; changed: boolean } | null> {
    const tenants = this.requireTenants();
    const org = await tenants.resolveById(orgId);
    if (!org) {
      this.logger.warn(`license.check: organisation ${orgId} does not exist; nothing to check`);
      return null;
    }
    return this.requireScope().withTenant(systemContextOf(org), async (trx) => {
      const evaluated = await this.evaluate(trx, orgId, { reportRollback: false });
      if (evaluated?.clockRollback) {
        this.logger.warn({ orgId }, 'license.check: the system clock is more than 24 hours behind the licence clock high-water mark (D-15)');
        await this.audit?.record(trx, {
          action: 'licence.clock_rollback',
          actor: { userId: SYSTEM_USER_ID, kind: 'system' },
          organizationId: orgId,
          entityType: 'licence',
          entityId: evaluated.record.id,
          after: { now: this.clock.now().toISOString(), evaluatedOn: evaluated.evaluatedOn },
        });
      }
      const state: LicenceState | 'none' = evaluated ? evaluated.state : 'none';
      const previous = await this.lastRecordedState(trx, orgId);
      const current: LicenceState = evaluated?.state ?? 'valid';
      const changed = evaluated !== null && previous !== current;
      const admins = await this.tenantAdmins(trx, orgId);
      const alert = evaluated ? this.alertFor(evaluated) : null;

      if (changed && evaluated) {
        await this.audit?.record(trx, {
          action: 'licence.state_changed',
          actor: { userId: SYSTEM_USER_ID, kind: 'system' },
          organizationId: orgId,
          entityType: 'licence',
          entityId: evaluated.record.id,
          entityCode: evaluated.record.licenseId,
          before: { state: previous },
          after: { state: current, evaluatedOn: evaluated.evaluatedOn },
        });
        const text = alert ?? { tone: 'info' as const, en: 'The licence is valid.', id: 'Lisensi berlaku.' };
        for (const userId of admins) {
          await this.notifications?.create(trx, {
            recipientUserId: userId,
            kind: 'licence_state',
            title: { en: `Licence state: ${STATE_LABELS[current].en}`, id: `Status lisensi: ${STATE_LABELS[current].id}` },
            body: { en: text.en, id: text.id },
            createdBy: SYSTEM_USER_ID,
          });
        }
      }
      await this.syncLicenceAlerts(trx, alert);

      if (evaluated?.verified && evaluated.document && evaluated.state === 'valid') {
        const days = evaluated.daysToExpiry;
        if ((LICENCE_EXPIRY_WARNING_DAYS as readonly number[]).includes(days)) {
          const until = evaluated.document.valid_until;
          const title = { en: `Licence expires in ${days} days`, id: `Lisensi berakhir dalam ${days} hari` };
          for (const userId of admins) {
            const already = await trx
              .selectFrom('notification')
              .select('id')
              .where('recipient_user_id', '=', userId)
              .where('kind', '=', 'licence_expiring')
              .where('title_en', '=', title.en)
              .where(sql<boolean>`position(${evaluated.record.licenseId} in body_en) > 0`)
              .executeTakeFirst();
            if (already) continue;
            await this.notifications?.create(trx, {
              recipientUserId: userId,
              kind: 'licence_expiring',
              title,
              body: {
                en: `Licence ${evaluated.record.licenseId} is valid until ${fmtDay(until)}. Install a renewed licence before then.`,
                id: `Lisensi ${evaluated.record.licenseId} berlaku sampai ${fmtDay(until, 'id')}. Pasang lisensi baru sebelum tanggal itu.`,
              },
              createdBy: SYSTEM_USER_ID,
            });
          }
        }
      }
      if (evaluated) await this.syncRepositoryAccess(trx, evaluated);
      return { state, changed };
    });
  }

  /** The state of the newest `licence.state_changed` entry of the organisation; `valid` when there is none. */
  private async lastRecordedState(trx: Trx, orgId: string): Promise<LicenceState> {
    const row = await trx
      .selectFrom('platform.audit_log')
      .select('after_data')
      .where('organization_id', '=', orgId)
      .where('action', '=', 'licence.state_changed')
      .orderBy('seq', 'desc')
      .limit(1)
      .executeTakeFirst();
    const state = (row?.after_data as { state?: unknown } | null | undefined)?.state;
    return state === 'grace' || state === 'read_only' ? state : 'valid';
  }

  /** Active Tenant Admins of the organisation (E.6 recipients). */
  async tenantAdmins(trx: Trx, orgId: string): Promise<string[]> {
    const rows = await trx
      .selectFrom('platform.org_membership as m')
      .innerJoin('platform.app_user as u', 'u.id', 'm.user_id')
      .select('m.user_id')
      .where('m.organization_id', '=', orgId)
      .where('m.status', '=', 'active')
      .where('m.deleted_at', 'is', null)
      .where('u.status', '=', 'active')
      .where('u.deleted_at', 'is', null)
      .where(sql<boolean>`'tenant_admin' = any(${sql.ref('m.admin_roles')})`)
      .orderBy('m.user_id')
      .execute();
    return rows.map((r) => r.user_id);
  }

  /** The `licence` alert the evaluated licence calls for, or null when it is valid. */
  private alertFor(evaluated: EvaluatedLicence): { tone: 'warn' | 'bad'; en: string; id: string } | null {
    const doc = evaluated.document;
    if (!evaluated.verified || !doc) {
      return {
        tone: 'bad',
        en: 'The installed licence cannot be verified. Data can still be read and exported; install a valid licence.',
        id: 'Lisensi yang terpasang tidak dapat diverifikasi. Data tetap dapat dibaca dan diekspor; pasang lisensi yang valid.',
      };
    }
    if (evaluated.state === 'read_only') {
      return { tone: 'bad', en: 'The licence has expired. Data can still be read and exported.', id: 'Lisensi telah berakhir. Data tetap dapat dibaca dan diekspor.' };
    }
    if (evaluated.state === 'grace') {
      if (evaluated.clockRollback) {
        return {
          tone: 'warn',
          en: 'The server clock is behind the last recorded time; the licence is in its grace period until the clock is corrected.',
          id: 'Jam server tertinggal dari waktu terakhir yang tercatat; lisensi berada dalam masa tenggang sampai jam diperbaiki.',
        };
      }
      if (evaluated.notYetValid) {
        return { tone: 'warn', en: `The licence is valid from ${fmtDay(doc.valid_from)}.`, id: `Lisensi berlaku mulai ${fmtDay(doc.valid_from, 'id')}.` };
      }
      return {
        tone: 'warn',
        en: `The licence expired on ${fmtDay(doc.valid_until)}. Everything works until the grace period ends on ${fmtDay(evaluated.graceEndsOn)}; then the organisation becomes read-only.`,
        id: `Lisensi berakhir pada ${fmtDay(doc.valid_until, 'id')}. Semua fungsi tetap berjalan sampai masa tenggang berakhir pada ${fmtDay(evaluated.graceEndsOn, 'id')}; setelah itu organisasi hanya dapat dibaca.`,
      };
    }
    return null;
  }

  /** Raises, replaces or resolves the open `licence` alert of every system that is not archived. */
  private async syncLicenceAlerts(trx: Trx, alert: { tone: 'warn' | 'bad'; en: string; id: string } | null): Promise<void> {
    const systems = await trx
      .selectFrom('management_system')
      .select('id')
      .where('deleted_at', 'is', null)
      .where('status', '<>', 'archived')
      .execute();
    for (const system of systems) {
      const open = await trx
        .selectFrom('ms_alert')
        .select(['id', 'tone', 'text_en'])
        .where('management_system_id', '=', system.id)
        .where('kind', '=', 'licence')
        .where('resolved_at', 'is', null)
        .where('deleted_at', 'is', null)
        .execute();
      const keep = alert ? open.find((a) => a.tone === alert.tone && a.text_en === alert.en) : undefined;
      const stale = open.filter((a) => a !== keep).map((a) => a.id);
      if (stale.length > 0) {
        await trx.updateTable('ms_alert').set({ resolved_at: new Date(), updated_by: SYSTEM_USER_ID }).where('id', 'in', stale).execute();
      }
      if (alert && !keep) {
        await trx
          .insertInto('ms_alert')
          .values({
            management_system_id: system.id,
            kind: 'licence',
            tone: alert.tone,
            text_en: alert.en,
            text_id: alert.id,
            source_ref: JSON.stringify({ source: 'license.check' }),
            created_by: SYSTEM_USER_ID,
            updated_by: SYSTEM_USER_ID,
          })
          .execute();
      }
    }
  }

  /** TS 5.7: a repository whose adapter is not licensed is read-only for the application; licensed again, it is not. */
  private async syncRepositoryAccess(trx: Trx, evaluated: EvaluatedLicence): Promise<void> {
    const licensed = new Set<string>(evaluated.verified && evaluated.document ? evaluated.document.storage_adapters : []);
    const repositories = await trx
      .selectFrom('storage_repository')
      .select(['id', 'slug', 'adapter', 'read_only'])
      .where('deleted_at', 'is', null)
      .execute();
    for (const repository of repositories) {
      const readOnly = !licensed.has(repository.adapter);
      if (repository.read_only === readOnly) continue;
      await trx.updateTable('storage_repository').set({ read_only: readOnly, updated_by: SYSTEM_USER_ID }).where('id', '=', repository.id).execute();
      await this.audit?.record(trx, {
        action: 'storage.repository.updated',
        actor: { userId: SYSTEM_USER_ID, kind: 'system' },
        entityType: 'storage_repository',
        entityId: repository.id,
        entityCode: repository.slug,
        before: { read_only: repository.read_only },
        after: { read_only: readOnly, reason: readOnly ? 'adapter_not_licensed' : 'adapter_licensed' },
      });
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Entitlements used by the gate and the management system service
  // -------------------------------------------------------------------------------------------------------------

  /** BR-21: the framework of a pack must be in the licence (TS 6.2). */
  assertFrameworkLicensed(evaluated: EvaluatedLicence | null, frameworkCode: string): void {
    const frameworks = evaluated?.verified && evaluated.document ? evaluated.document.frameworks : [];
    if (!frameworks.includes(frameworkCode)) {
      throw new BusinessRuleError('BR-21', {
        en: "This framework is not yet included in your organisation's licence. Contact your administrator.",
        id: 'Kerangka kerja ini belum termasuk dalam lisensi organisasi Anda. Hubungi administrator Anda.',
      });
    }
  }

  /** Whether the evaluated licence includes a storage adapter. */
  adapterLicensed(evaluated: EvaluatedLicence | null, adapter: StorageAdapter): boolean {
    return Boolean(evaluated?.verified && evaluated.document?.storage_adapters.includes(adapter));
  }

  /** Whether the evaluated licence includes a feature. */
  featureLicensed(evaluated: EvaluatedLicence | null, feature: LicenceFeature): boolean {
    return Boolean(evaluated?.verified && evaluated.document?.features.includes(feature));
  }

  /** Today in the organisation's time zone (or `demo.fixed_today`). */
  async today(orgId: string): Promise<string> {
    return this.clock.todayIn(await this.timeZoneOf(orgId));
  }

  private requireScope(): TenantScope {
    if (!this.scope) throw new Error('Licences need the tenancy and database modules');
    return this.scope;
  }

  private requireTenants(): TenantResolver {
    if (!this.tenants) throw new Error('Licences need the tenancy and database modules');
    return this.tenants;
  }
}

const STATE_LABELS: Readonly<Record<LicenceState, Messages>> = {
  valid: { en: 'valid', id: 'berlaku' },
  grace: { en: 'grace period', id: 'masa tenggang' },
  read_only: { en: 'read-only', id: 'hanya baca' },
};

function firstLine(text: string): string {
  return text.split('\n')[0] ?? text;
}

function isWrapped(body: LicenceInstallRequest): body is { org: string; licence: LicenceDocument } {
  return typeof body === 'object' && body !== null && 'licence' in body && 'org' in body;
}

/** 422 `LIC-BINDING` (D-15). */
export function bindingRuleError(detail: string): BusinessRuleError {
  return new BusinessRuleError(
    'LIC-BINDING',
    {
      en: `The licence is not for this installation or organisation: ${detail}.`,
      id: `Lisensi ini bukan untuk instalasi atau organisasi ini: ${detail}.`,
    },
    undefined,
    { messageKey: 'licence.binding' },
  );
}

/** The problem of a rejected licence: `LIC-BINDING` 422 for a binding failure, else 400 (D.3). */
export function licenceProblem(error: LicenceError): BusinessRuleError | ValidationError {
  if (error.code === 'binding') return bindingRuleError(error.message);
  const summary = firstLine(error.message);
  const errors = [{ path: 'body', message: summary }, ...error.issues.slice(0, 50).map((issue) => ({ path: 'body', message: issue }))];
  return new ValidationError(errors, `The licence was rejected (${error.code}): ${summary}`);
}
