import { describe, expect, it } from 'vitest';
import { Clock } from '../../../src/common/clock';
import { addDays, diffDays, fmtDay, fmtDayTime, isIsoDate, isTimeZone, localDate, startOfLocalDay } from '../../../src/common/dates';
import { assertIfMatch, etagOf, ifMatchSatisfied, parseIfMatch } from '../../../src/common/etag';
import { PreconditionFailedError } from '../../../src/common/problems';
import { MscdConfig } from '../../../src/config/mscd-config';

const TEST_PROFILE = `${__dirname}/../../../profiles/test.yaml`;

function config(env: Record<string, string> = {}): MscdConfig {
  return MscdConfig.load({ runMode: 'api', flavor: 'dev', env: { MSCD_PROFILE_FILE: TEST_PROFILE, ...env } });
}

describe('date helpers (D-07, G.5)', () => {
  it('adds and counts days on local dates across month, year and leap days', () => {
    expect(addDays('2026-09-29', 1)).toBe('2026-09-30');
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(diffDays('2026-09-29', '2026-10-29')).toBe(30);
    expect(diffDays('2026-10-29', '2026-09-29')).toBe(-30);
    expect(diffDays('2026-03-28', '2026-03-30')).toBe(2);
    expect(() => addDays('2026-02-30', 1)).toThrow(TypeError);
    expect(() => addDays('2026-02-01', 1.5)).toThrow(TypeError);
  });

  it('formats days and instants as G.5 says', () => {
    expect(fmtDay('2026-02-02')).toBe('02 Feb 2026');
    expect(fmtDay('2026-08-17', 'id')).toBe('17 Agu 2026');
    expect(fmtDay(null)).toBe('-');
    expect(fmtDayTime(new Date('2026-09-27T23:30:00Z'), 'Asia/Jakarta')).toBe('28 Sep 2026 06:30');
    expect(fmtDayTime('2026-09-27T23:30:00Z', 'UTC')).toBe('27 Sep 2026 23:30');
    expect(fmtDayTime(undefined, 'UTC')).toBe('-');
  });

  it('finds local dates and the start of a local day, also on daylight saving days', () => {
    expect(localDate(new Date('2026-09-28T17:30:00Z'), 'Asia/Jakarta')).toBe('2026-09-29');
    expect(localDate(new Date('2026-09-28T16:30:00Z'), 'Asia/Jakarta')).toBe('2026-09-28');
    expect(startOfLocalDay('2026-09-29', 'Asia/Jakarta').toISOString()).toBe('2026-09-28T17:00:00.000Z');
    expect(startOfLocalDay('2026-03-29', 'Europe/Berlin').toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(startOfLocalDay('2026-03-30', 'Europe/Berlin').toISOString()).toBe('2026-03-29T22:00:00.000Z');
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isTimeZone('Asia/Jakarta')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('Clock (D-07)', () => {
  it('uses demo.fixed_today when demo mode sets it', async () => {
    const clock = Clock.fixed(config(), new Date('2027-01-15T12:00:00Z'));
    expect(clock.fixedToday).toBe('2026-09-29');
    expect(clock.todayIn('UTC')).toBe('2026-09-29');
    expect(await clock.today('00000000-0000-4000-8000-00000000a001')).toBe('2026-09-29');
  });

  it('uses the organisation time zone otherwise', async () => {
    const cfg = config({ MSCD__DEMO__FIXED_TODAY: 'null' });
    const lookup = { timeZoneOf: async (orgId: string) => (orgId === 'org-ny' ? 'America/New_York' : 'Asia/Jakarta') };
    const clock = Clock.fixed(cfg, new Date('2026-09-29T02:00:00Z'), lookup);
    expect(clock.fixedToday).toBeNull();
    expect(await clock.today('org-jkt')).toBe('2026-09-29');
    expect(await clock.today('org-ny')).toBe('2026-09-28');
    expect(clock.todayIn('UTC')).toBe('2026-09-29');
  });
});

describe('ETag and If-Match (D.1 Concurrency)', () => {
  const updatedAt = new Date('2026-09-29T03:15:00.123Z');

  it('derives weak ETags from updated_at', () => {
    expect(etagOf(updatedAt)).toBe(`W/"${updatedAt.getTime()}"`);
    expect(etagOf(updatedAt.toISOString())).toBe(etagOf(updatedAt));
  });

  it('accepts a missing header, a match, a strong form and a list; rejects a stale tag with 412', () => {
    const tag = etagOf(updatedAt);
    expect(parseIfMatch(undefined)).toBeNull();
    expect(parseIfMatch('*')).toBe('*');
    expect(parseIfMatch(`W/"1", ${tag}`)).toEqual(['W/"1"', tag]);
    expect(ifMatchSatisfied(undefined, updatedAt)).toBe(true);
    expect(ifMatchSatisfied(tag, updatedAt)).toBe(true);
    expect(ifMatchSatisfied(`"${updatedAt.getTime()}"`, updatedAt)).toBe(true);
    expect(ifMatchSatisfied(`W/"1", ${tag}`, updatedAt)).toBe(true);
    expect(ifMatchSatisfied('*', updatedAt)).toBe(true);
    expect(ifMatchSatisfied('W/"1"', updatedAt)).toBe(false);
    expect(() => assertIfMatch('W/"1"', updatedAt)).toThrow(PreconditionFailedError);
    expect(() => assertIfMatch(tag, updatedAt)).not.toThrow();
  });
});
