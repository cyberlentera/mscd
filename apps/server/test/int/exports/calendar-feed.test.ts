// The review calendar feed (build plan D.3, D-09, F.12, PRD 9.1; WP-24): a hashed token per user and system, create
// and revoke, the public ICS feed with one all-day event per review date for the overdue documents and those due
// within four months (the documents the token's user may see), `ms.read` checked on every fetch (a revoked token,
// an older replaced token, another system and a user who lost the role all get 404), and no token in any log line.
import { createHash } from 'node:crypto';
import type { CalendarFeed, CommandResult, Page } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '../../../src/common/dates';
import { feedHorizon } from '../../../src/modules/exports/ics';
import { useTestDatabase } from '../../setup/test-db';
import { inOrg, signIn, userId, type FilesClient } from '../files/helpers';
import { createWp24App, type Wp24App } from '../notifications/helpers';

const TODAY = '2026-09-29';

interface FeedAnswer {
  status: number;
  type: string;
  text: string;
}

function tokenOf(url: string): string {
  return new URL(url, 'http://x').searchParams.get('token')!;
}

/** Content lines of an ICS text, unfolded (RFC 5545 3.1). */
function unfold(text: string): string[] {
  return text.replace(/\r\n /g, '').split('\r\n').filter((l) => l !== '');
}

describe('review calendar feed (D.3, PRD 9.1)', () => {
  const db = useTestDatabase('demo');
  let ctx: Wp24App;
  let rina: FilesClient;
  let bagus: FilesClient;

  const fetchFeed = async (url: string): Promise<FeedAnswer> => {
    const response = await ctx.app.inject({ method: 'GET', url });
    return { status: response.statusCode, type: String(response.headers['content-type'] ?? ''), text: response.body };
  };

  const create = async (client: FilesClient, ms = 'isms'): Promise<string> => {
    const answer = await client.post<CalendarFeed>(`/api/v1/ms/${ms}/calendar-feed`, {});
    expect(answer.status).toBe(201);
    expect(answer.body.downloadUrl).toMatch(new RegExp(`^/api/v1/ms/${ms}/surveillance/reviews\\.ics\\?token=[A-Za-z0-9_-]{65}$`));
    return answer.body.downloadUrl;
  };

  /** Review dates the feed must hold for a user: their visible documents, overdue or due up to the horizon. */
  const expectedDates = async (client: FilesClient): Promise<string[]> => {
    const docs = await client.get<Page<{ rev: string }>>('/api/v1/ms/isms/documents?pageSize=200');
    const horizon = feedHorizon(TODAY);
    return [...new Set(docs.body.items.map((d) => d.rev).filter((rev) => rev !== '' && rev <= horizon))].sort();
  };

  beforeAll(async () => {
    ctx = await createWp24App(db);
    rina = await signIn(ctx, db, 'rina', 'tst');
    bagus = await signIn(ctx, db, 'bagus', 'tst');
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('serves an ICS feed with one all-day event per review date, overdue first, up to four months ahead', async () => {
    const url = await create(rina);
    const feed = await fetchFeed(url);
    expect(feed.status).toBe(200);
    expect(feed.type).toBe('text/calendar; charset=utf-8');
    expect(feed.text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(feed.text.endsWith('END:VCALENDAR\r\n')).toBe(true);
    // CRLF only, and every physical line within 75 octets.
    expect(feed.text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    for (const line of feed.text.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);

    const lines = unfold(feed.text);
    expect(lines).toContain('PRODID:-//Cyberlentera//MSCD//EN');
    const starts = lines.filter((l) => l.startsWith('DTSTART;VALUE=DATE:')).map((l) => l.slice('DTSTART;VALUE=DATE:'.length));
    const expected = await expectedDates(rina);
    expect(expected.length).toBeGreaterThan(1);
    expect(starts).toEqual(expected.map((d) => d.replace(/-/g, '')));
    expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(expected.length);
    const ends = lines.filter((l) => l.startsWith('DTEND;VALUE=DATE:')).map((l) => l.slice('DTEND;VALUE=DATE:'.length));
    expect(ends).toEqual(expected.map((d) => addDays(d, 1).replace(/-/g, '')));
    const uids = lines.filter((l) => l.startsWith('UID:'));
    expect(new Set(uids).size).toBe(uids.length);
    expect(uids[0]).toMatch(/^UID:tst-isms-review-\d{8}@mscd$/);
    // Overdue reviews are named as such; the horizon is four months from today.
    const overdue = expected.filter((d) => d < TODAY);
    expect(lines.filter((l) => l.startsWith('SUMMARY:Overdue review'))).toHaveLength(overdue.length);
    expect(expected.every((d) => d <= '2027-01-29')).toBe(true);

    // The fetch is audited for the token's user; the token itself is in no log line and in no audit entry.
    const token = tokenOf(url);
    expect(ctx.logs.some((l) => l.includes('reviews.ics'))).toBe(true);
    expect(ctx.logs.filter((l) => l.includes(token))).toEqual([]);
    const audit = await inOrg(db, 'tst', async (trx) =>
      (await sql<{ action: string; text: string }>`select action, coalesce(after_data::text, '') as text from audit_trail where entity_type = 'calendar_feed_token' order by seq`.execute(trx)).rows,
    );
    expect(audit.map((a) => a.action)).toEqual(['calendar_feed.created', 'file.downloaded']);
    expect(audit.some((a) => a.text.includes(token))).toBe(false);
    // Only a MAC of the token is stored.
    const stored = await inOrg(db, 'tst', (trx) => trx.selectFrom('calendar_feed_token').select(['token_hash', 'last_used_at']).where('revoked_at', 'is', null).execute());
    expect(stored).toHaveLength(1);
    expect(Buffer.from(stored[0]!.token_hash).toString('hex')).not.toBe(createHash('sha256').update(token).digest('hex'));
    expect(Buffer.from(stored[0]!.token_hash).includes(Buffer.from(token))).toBe(false);
    expect(stored[0]!.last_used_at).not.toBeNull();
  });

  it('lists only the documents the token user may see (owner scope for a Domain Owner)', async () => {
    const url = await create(bagus);
    const feed = await fetchFeed(url);
    expect(feed.status).toBe(200);
    const starts = unfold(feed.text).filter((l) => l.startsWith('DTSTART')).map((l) => l.slice(-8));
    const expected = await expectedDates(bagus);
    expect(starts).toEqual(expected.map((d) => d.replace(/-/g, '')));
    expect(expected.length).toBeLessThan((await expectedDates(rina)).length);
  });

  it('a replaced, revoked, foreign or malformed token gets 404 (or 400); creating again replaces the old token', async () => {
    const first = await create(rina);
    const second = await create(rina);
    expect((await fetchFeed(first)).status).toBe(404);
    expect((await fetchFeed(second)).status).toBe(200);
    // The token of one system does not open another path.
    const token = tokenOf(second);
    expect((await fetchFeed(`/api/v1/ms/qms/surveillance/reviews.ics?token=${token}`)).status).toBe(404);
    // An unknown token of the right shape, and one naming an unknown organisation.
    expect((await fetchFeed(second.replace(/token=(.{22})(.{43})/, (_m, org: string) => `token=${org}${'A'.repeat(43)}`))).status).toBe(404);
    expect((await fetchFeed(`/api/v1/ms/isms/surveillance/reviews.ics?token=${'B'.repeat(65)}`)).status).toBe(404);
    expect((await fetchFeed('/api/v1/ms/isms/surveillance/reviews.ics?token=short')).status).toBe(400);

    const revoked = await rina.post<CommandResult>('/api/v1/ms/isms/calendar-feed/revoke', {});
    expect(revoked.status).toBe(200);
    expect(revoked.body.count).toBe(1);
    expect((await fetchFeed(second)).status).toBe(404);
    const again = await rina.post<CommandResult>('/api/v1/ms/isms/calendar-feed/revoke', {});
    expect(again.body.count).toBe(0);
    const actions = await inOrg(db, 'tst', async (trx) =>
      (await sql<{ action: string }>`select action from audit_trail where entity_type = 'calendar_feed_token' and action = 'calendar_feed.revoked'`.execute(trx)).rows,
    );
    expect(actions).toHaveLength(1);
  });

  it('a user who lost the role, or the membership, gets 404 on the next fetch', async () => {
    const url = await create(bagus);
    expect((await fetchFeed(url)).status).toBe(200);
    const bagusId = await userId(db, 'bagus');
    const roles = await inOrg(db, 'tst', async (trx) =>
      (await sql<{ id: string }>`update user_ms_role set deleted_at = now() where user_id = ${bagusId}::uuid and deleted_at is null returning id`.execute(trx)).rows,
    );
    expect(roles.length).toBeGreaterThan(0);
    expect((await fetchFeed(url)).status).toBe(404);
    await inOrg(db, 'tst', (trx) => trx.updateTable('user_ms_role').set({ deleted_at: null }).where('id', 'in', roles.map((r) => r.id)).execute());
    expect((await fetchFeed(url)).status).toBe(200);

    await inOrg(db, 'tst', (trx) =>
      sql`update platform.org_membership set status = 'disabled' where user_id = ${bagusId}::uuid and organization_id = nullif(current_setting('app.org_id', true), '')::uuid`.execute(trx),
    );
    expect((await fetchFeed(url)).status).toBe(404);
  });
});
