// Schedules of build plan E.2. Installation-wide jobs run on cron schedules in UTC; daily jobs of an organisation
// are enqueued by `scheduler.tick` in the hour of the organisation's local time (D-07), with a singleton key that
// includes the local date.
import type { JobName } from '@mscd/shared';
import { localDate } from '../../common/dates';

/** Cron jobs of E.2 (UTC). `notifications.dispatch` is the 5 minute sweep of E.6. */
export const CRON_SCHEDULES: readonly { name: JobName; cron: string; retryLimit: number }[] = [
  { name: 'scheduler.tick', cron: '5 * * * *', retryLimit: 3 },
  { name: 'packs.lifecycle', cron: '10 0 * * *', retryLimit: 3 },
  { name: 'audit.verify-chain', cron: '0 4 * * *', retryLimit: 2 },
  { name: 'cleanup.expired', cron: '20 * * * *', retryLimit: 3 },
  { name: 'notifications.dispatch', cron: '*/5 * * * *', retryLimit: 5 },
];

export interface DailyJob {
  name: JobName;
  /** Local time `HH:MM`. */
  at: string;
  /** Singleton key prefix; the key is `<prefix>:<org>:<local date>` (E.2). */
  prefix: string;
  /** Jobs that take a system id have the E.2 key `<prefix>:<org>:all` when they run for every system. */
  allSystems?: boolean;
  /** Day of the week (0 Sunday) when the job runs weekly only. */
  weekday?: number;
  retryLimit: number;
}

/** Daily jobs of E.2 that `scheduler.tick` enqueues per organisation, in local time. */
export const DAILY_JOBS: readonly DailyJob[] = [
  { name: 'license.check', at: '00:05', prefix: 'lc', retryLimit: 3 },
  { name: 'tasks.overdue', at: '00:15', prefix: 'to', retryLimit: 3 },
  { name: 'audit-prep.generate', at: '00:30', prefix: 'ap', retryLimit: 3 },
  { name: 'freshness.sweep', at: '01:00', prefix: 'fs', retryLimit: 3 },
  { name: 'link-health.plan', at: '02:00', prefix: 'lhp', retryLimit: 3 },
  { name: 'link-health.repository', at: '02:30', prefix: 'lhr', retryLimit: 3 },
  { name: 'drift.evaluate', at: '02:45', prefix: 'de', allSystems: true, retryLimit: 3 },
  { name: 'integrity.rehash', at: '03:00', prefix: 'ir', weekday: 0, retryLimit: 3 },
  { name: 'cycle.derive', at: '03:15', prefix: 'cd', allSystems: true, retryLimit: 3 },
  { name: 'documents.review-alerts', at: '06:30', prefix: 'dra', retryLimit: 3 },
  { name: 'notifications.digest', at: '07:00', prefix: 'ndg', retryLimit: 3 },
];

/** Local wall clock of an instant in a time zone. */
export interface LocalTime {
  date: string;
  hour: number;
  minute: number;
  second: number;
  /** 0 Sunday to 6 Saturday. */
  weekday: number;
}

const WEEKDAYS: Readonly<Record<string, number>> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The local date, hour, minute, second and weekday of `instant` in `timeZone`. */
export function localTimeOf(instant: Date, timeZone: string): LocalTime {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
  return {
    date: localDate(instant, timeZone),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAYS[get('weekday')] ?? 0,
  };
}

export interface DueDailyJob {
  job: DailyJob;
  singletonKey: string;
  /** Delay so the job starts at its local minute (0 when that minute has passed). */
  startAfterSeconds: number;
}

/** The daily jobs due in the local hour of `instant` for one organisation (the work of one `scheduler.tick`). */
export function dueDailyJobs(orgId: string, instant: Date, timeZone: string, jobs: readonly DailyJob[] = DAILY_JOBS): DueDailyJob[] {
  const local = localTimeOf(instant, timeZone);
  const due: DueDailyJob[] = [];
  for (const job of jobs) {
    const [hour, minute] = job.at.split(':').map(Number) as [number, number];
    if (hour !== local.hour) continue;
    if (job.weekday !== undefined && job.weekday !== local.weekday) continue;
    const startAfterSeconds = Math.max(0, (minute - local.minute) * 60 - local.second);
    const key = job.allSystems ? `${job.prefix}:${orgId}:all` : `${job.prefix}:${orgId}:${local.date}`;
    due.push({ job, singletonKey: key, startAfterSeconds });
  }
  return due;
}
