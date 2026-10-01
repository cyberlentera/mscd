// The review calendar feed (build plan D.3, D-09, F.12, PRD 9.1):
//
// - `POST /ms/{ms}/calendar-feed` (`ms.read`): a new token for the session user and the system, replacing (revoking)
//   an older one; the response carries the feed URL with the token, shown once. Only a MAC of the token is stored
//   (`calendar_feed_token.token_hash`, HMAC-SHA256 with the `calendar` key derived from `platform.key`).
// - `POST /ms/{ms}/calendar-feed/revoke` (`ms.read`): revokes the user's token for the system.
// - `GET /ms/{ms}/surveillance/reviews.ics?token=` (public): the token must be valid and unrevoked, belong to the
//   system of the path, and its user must still be an active member who holds `ms.read` in the system, checked on
//   every fetch; anything else is 404. The feed lists the documents the user may see (`ScopePolicy`) that are
//   overdue or due within four months, one all-day event per review date. The `token` query value never reaches a
//   log line (F.12 redaction of `token`).
//
// The token is `<organisation id, 16 bytes base64url><32 random bytes base64url>` (65 characters): the prefix names
// the organisation, so the public fetch reads one tenant schema instead of searching all of them; the random part is
// the secret.
import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { CalendarFeed, CommandResult } from '@mscd/shared';
import type { FastifyReply } from 'fastify';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { FileResponder } from '../../common/file-response';
import { NotFoundError } from '../../common/problems';
import { AUDIT_WRITER, PERMISSION_EVALUATOR, type AuditWriter, type PermissionEvaluator, type Principal, type TenantInfo, type Trx } from '../../common/tokens';
import { SecretBox } from '../keys/secret-box';
import { ScreenReadService } from '../read-model-api/screen-read.service';
import { TenantResolver } from '../tenancy/tenant-resolver';
import { TenantScope, systemContextOf, tenantContextOf } from '../tenancy/tenant-scope';
import { ExportContentService } from './export-content.service';
import { reviewCalendar } from './ics';

/** SecretBox MAC purpose of calendar feed tokens (D-09). */
export const CALENDAR_MAC_PURPOSE = 'calendar';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORG_PART = 22;
const SECRET_PART = 43;

/** A new feed token for an organisation. */
export function newCalendarToken(orgId: string): string {
  if (!UUID.test(orgId)) throw new Error(`Not a uuid: ${orgId}`);
  return `${Buffer.from(orgId.replace(/-/g, ''), 'hex').toString('base64url')}${randomBytes(32).toString('base64url')}`;
}

/** The organisation a feed token names, or null for anything that is not a feed token of this build. */
export function organisationOfCalendarToken(token: string): string | null {
  if (token.length !== ORG_PART + SECRET_PART || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  const bytes = Buffer.from(token.slice(0, ORG_PART), 'base64url');
  if (bytes.length !== 16 || bytes.toString('base64url') !== token.slice(0, ORG_PART)) return null;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The feed path of a system with its token (`CalendarFeed.downloadUrl`). */
export function calendarFeedUrl(ms: string, token: string): string {
  return `/api/v1/ms/${ms}/surveillance/reviews.ics?token=${token}`;
}

interface FeedSource {
  org: TenantInfo;
  principal: Principal;
  system: { id: string; slug: string; code: string; name: string };
  tokenId: string;
}

@Injectable()
export class CalendarFeedService {
  constructor(
    private readonly scope: TenantScope,
    private readonly tenants: TenantResolver,
    private readonly clock: Clock,
    private readonly secrets: SecretBox,
    private readonly content: ExportContentService,
    private readonly screens: ScreenReadService,
    private readonly files: FileResponder,
    @Inject(PERMISSION_EVALUATOR) private readonly evaluator: PermissionEvaluator,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  private tokenHash(token: string): Buffer {
    return Buffer.from(this.secrets.mac(CALENDAR_MAC_PURPOSE, token), 'hex');
  }

  private async system(trx: Trx, ms: string): Promise<{ id: string; slug: string; code: string; name: string }> {
    const row = await trx.selectFrom('management_system').select(['id', 'slug', 'code', 'name']).where('slug', '=', ms).where('deleted_at', 'is', null).executeTakeFirst();
    if (!row) throw new NotFoundError('Unknown management system');
    return row;
  }

  /** `POST /ms/{ms}/calendar-feed`: a new token for the user and the system; an older one is revoked. */
  async create(principal: Principal, ms: string): Promise<CalendarFeed> {
    const org = principal.org;
    if (!org) throw new NotFoundError('No organisation is selected');
    const token = newCalendarToken(org.id);
    return this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.system(trx, ms);
      // One create per user and system at a time: a second concurrent call waits here, then revokes the token the
      // first one inserted, so the partial unique index `calendar_feed_token_active_uq` is never hit (no 500).
      await sql`select pg_advisory_xact_lock(hashtextextended(${`calendar-feed:${principal.user.id}:${system.id}`}, 0))`.execute(trx);
      const now = this.clock.now();
      const replaced = await trx
        .updateTable('calendar_feed_token')
        .set({ revoked_at: now, updated_at: now, updated_by: principal.user.id })
        .where('user_id', '=', principal.user.id)
        .where('management_system_id', '=', system.id)
        .where('revoked_at', 'is', null)
        .where('deleted_at', 'is', null)
        .returning('id')
        .execute();
      const row = await trx
        .insertInto('calendar_feed_token')
        .values({ user_id: principal.user.id, management_system_id: system.id, token_hash: this.tokenHash(token), created_by: principal.user.id, updated_by: principal.user.id })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        action: 'calendar_feed.created',
        msId: system.id,
        entityType: 'calendar_feed_token',
        entityId: row.id,
        entityCode: system.slug,
        after: { replaced: replaced.length },
      });
      return {
        ok: true,
        changed: [],
        downloadUrl: calendarFeedUrl(ms, token),
        message: ['Calendar feed created; copy the link now, it is shown once', 'Umpan kalender dibuat; salin tautannya sekarang, tautan hanya ditampilkan sekali'],
      };
    });
  }

  /** `POST /ms/{ms}/calendar-feed/revoke`. */
  async revoke(principal: Principal, ms: string): Promise<CommandResult> {
    return this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.system(trx, ms);
      const now = this.clock.now();
      const revoked = await trx
        .updateTable('calendar_feed_token')
        .set({ revoked_at: now, updated_at: now, updated_by: principal.user.id })
        .where('user_id', '=', principal.user.id)
        .where('management_system_id', '=', system.id)
        .where('revoked_at', 'is', null)
        .where('deleted_at', 'is', null)
        .returning('id')
        .execute();
      for (const row of revoked) {
        await this.audit.record(trx, {
          action: 'calendar_feed.revoked',
          msId: system.id,
          entityType: 'calendar_feed_token',
          entityId: row.id,
          entityCode: system.slug,
        });
      }
      return {
        ok: true,
        changed: [],
        count: revoked.length,
        message: revoked.length > 0 ? ['Calendar feed revoked', 'Umpan kalender dicabut'] : ['No calendar feed to revoke', 'Tidak ada umpan kalender untuk dicabut'],
      };
    });
  }

  /** `GET /ms/{ms}/surveillance/reviews.ics?token=`: 404 for every token that does not grant the feed. */
  async feed(reply: FastifyReply, ms: string, token: string): Promise<FastifyReply> {
    const source = await this.resolve(ms, token);
    if (!source) throw new NotFoundError('No such calendar feed');
    const { org, principal, system } = source;
    const language = await this.scope.withTenant(systemContextOf(org), (trx) => this.content.languageOf(trx, principal.user.id));
    const page = await this.screens.documents(principal, system.slug, language, { page: 1, pageSize: 1_000_000 });
    const names = await this.scope.withTenant(systemContextOf(org), async (trx) => {
      const rows = await trx.selectFrom('platform.app_user').select(['handle', 'display_name']).where('handle', 'in', [...new Set(page.items.map((d) => d.owner).filter((h): h is string => !!h && h !== 'none')), '-']).execute();
      return new Map(rows.map((r) => [r.handle, r.display_name]));
    });
    const today = this.clock.todayIn(org.timeZone);
    const text = reviewCalendar({
      uidPrefix: `${org.slug}-${system.slug}`,
      calendarName: `${system.code} ${language === 'id' ? 'tinjauan dokumen' : 'document reviews'}`,
      today,
      now: this.clock.now(),
      language,
      documents: page.items
        .filter((d) => d.rev !== '')
        .map((d) => ({ code: d.id, title: d.title, reviewAt: d.rev, status: d.st, owner: d.owner && d.owner !== 'none' ? (names.get(d.owner) ?? d.owner) : null })),
    });
    await this.scope.withTenant({ ...systemContextOf(org), userId: principal.user.id }, async (trx) => {
      await trx.updateTable('calendar_feed_token').set({ last_used_at: this.clock.now() }).where('id', '=', source.tokenId).execute();
      await this.audit.record(trx, {
        action: 'file.downloaded',
        actor: { userId: principal.user.id, kind: principal.user.kind === 'guest' ? 'guest' : 'user' },
        msId: system.id,
        entityType: 'calendar_feed_token',
        entityId: source.tokenId,
        entityCode: system.slug,
        after: { fileName: `${system.code}-document-reviews.ics` },
      });
    });
    return this.files.send(reply, { body: text, storedType: 'text/calendar', fileName: `${system.code}-document-reviews.ics` });
  }

  /** The organisation, user and system a token grants, or null (unknown, revoked, other system, lost access). */
  private async resolve(ms: string, token: string): Promise<FeedSource | null> {
    const orgId = organisationOfCalendarToken(token);
    if (!orgId) return null;
    const org = await this.tenants.resolveById(orgId);
    if (!org || (org.status !== 'active' && org.status !== 'offboarding')) return null;
    const found = await this.scope.withTenant(systemContextOf(org), async (trx) => {
      const row = await trx
        .selectFrom('calendar_feed_token as t')
        .innerJoin('management_system as ms', 'ms.id', 't.management_system_id')
        .select(['t.id', 't.user_id', 'ms.id as ms_id', 'ms.slug', 'ms.code', 'ms.name'])
        .where('t.token_hash', '=', this.tokenHash(token))
        .where('t.revoked_at', 'is', null)
        .where('t.deleted_at', 'is', null)
        .where('ms.deleted_at', 'is', null)
        .executeTakeFirst();
      if (!row || row.slug !== ms) return null;
      const member = await trx
        .selectFrom('platform.org_membership')
        .select('status')
        .where('organization_id', '=', org.id)
        .where('user_id', '=', row.user_id)
        .where('status', '=', 'active')
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!member) return null;
      const principal = await this.content.principalFor(trx, org, row.user_id);
      if (!principal) return null;
      return { principal, tokenId: row.id, system: { id: row.ms_id, slug: row.slug, code: row.code, name: row.name } };
    });
    if (!found) return null;
    try {
      if ((await this.evaluator.evaluate(found.principal, 'ms.read', { scope: 'ms', ms })) === null) return null;
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
    return { org, ...found };
  }
}
