// Derived licence state (D-15, BR-37, digest 16.2). Nothing derived is stored: the state comes from the verified
// document and the clock on every evaluation.
//
//   valid      valid_from <= today <= valid_until
//   grace      valid_until < today <= valid_until + grace_days (everything works, a warning is raised)
//   read_only  after the grace period: user writes are blocked, data stays readable and exportable (BR-37)
//
// A licence whose valid_from lies in the future is treated as `grace` (it works, with a warning), so a renewal
// installed early never locks an organisation. When the wall clock is more than 24 hours behind the high-water mark
// (`platform.clock_mark`), the licence is evaluated at the high-water date and the state is at least `grace`.
import type { LicenceState } from '@mscd/shared';
import { addDays, diffDays, localDate } from '../../common/dates';

/** How far the clock may fall behind the high-water mark before it counts as a rollback (D-15). */
export const CLOCK_ROLLBACK_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/** Days before `valid_until` on which Tenant Admins get `licence_expiring` (E.2 `license.check`). */
export const LICENCE_EXPIRY_WARNING_DAYS = [60, 30, 7] as const;

const STATE_ORDER: Readonly<Record<LicenceState, number>> = { valid: 0, grace: 1, read_only: 2 };

/** The validity fields a state is derived from. */
export interface LicenceValidity {
  valid_from: string;
  valid_until: string;
  grace_days: number;
}

/** Last day of the grace period (inclusive). */
export function graceEndsOn(doc: LicenceValidity): string {
  return addDays(doc.valid_until, doc.grace_days);
}

/** State of a licence on a date (`YYYY-MM-DD`). */
export function licenceStateOn(doc: LicenceValidity, day: string): LicenceState {
  if (day < doc.valid_from) return 'grace';
  if (day <= doc.valid_until) return 'valid';
  if (day <= graceEndsOn(doc)) return 'grace';
  return 'read_only';
}

/** The more restrictive of two states. */
export function worseState(a: LicenceState, b: LicenceState): LicenceState {
  return STATE_ORDER[a] >= STATE_ORDER[b] ? a : b;
}

export interface ClockReading {
  /** Today in the organisation's time zone (or `demo.fixed_today`). */
  today: string;
  /** The current instant. */
  now: Date;
  /** `platform.clock_mark.high_water`, when known. */
  highWater: Date | null;
  /** Organisation time zone, to turn the high-water mark into a date. */
  timeZone: string;
}

export interface LicenceStateResult {
  state: LicenceState;
  /** The clock is more than 24 hours behind the high-water mark. */
  clockRollback: boolean;
  /** The date the state was derived for (today, or the high-water date after a rollback). */
  evaluatedOn: string;
  /** `valid_from` lies after the evaluation date. */
  notYetValid: boolean;
  /** Days from the evaluation date to `valid_until` (negative once expired). */
  daysToExpiry: number;
  graceEndsOn: string;
}

/** True when `now` lies more than the tolerance behind the high-water mark. */
export function isClockRollback(now: Date, highWater: Date | null): boolean {
  return highWater !== null && now.getTime() < highWater.getTime() - CLOCK_ROLLBACK_TOLERANCE_MS;
}

/** D-15 evaluation of a verified licence document against the clock. */
export function evaluateLicenceState(doc: LicenceValidity, clock: ClockReading): LicenceStateResult {
  const rollback = isClockRollback(clock.now, clock.highWater);
  let day = clock.today;
  if (rollback && clock.highWater) {
    const highWaterDay = localDate(clock.highWater, clock.timeZone);
    if (highWaterDay > day) day = highWaterDay;
  }
  let state = licenceStateOn(doc, day);
  if (rollback) state = worseState(state, 'grace');
  return {
    state,
    clockRollback: rollback,
    evaluatedOn: day,
    notYetValid: day < doc.valid_from,
    daysToExpiry: diffDays(day, doc.valid_until),
    graceEndsOn: graceEndsOn(doc),
  };
}
