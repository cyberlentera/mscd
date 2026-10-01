// BR-50 (digest 6.4, E.5): the same person is reminded about the same item at most once in 72 hours. The command
// answers 422 with the time of the last reminder, the time a new one is allowed and `retryAfter`.
import { Injectable } from '@nestjs/common';
import { fmtDayTime } from '../../common/dates';
import { BusinessRule, type BusinessRuleHandler, type RuleCheck, type RuleViolation } from '../rules';

/** Throttle window of BR-50. */
export const REMINDER_THROTTLE_MS = 72 * 60 * 60 * 1000;

export interface Br50Input {
  /** Last reminder to the same recipient about the same record key, or null. */
  lastSentAt: Date | null;
  now: Date;
  timeZone: string;
}

@Injectable()
@BusinessRule('BR-50', { severity: 'error' })
export class Br50ReminderThrottle implements BusinessRuleHandler<Br50Input> {
  check({ input }: RuleCheck<Br50Input>): RuleViolation | null {
    if (!input.lastSentAt) return null;
    const next = new Date(input.lastSentAt.getTime() + REMINDER_THROTTLE_MS);
    if (next.getTime() <= input.now.getTime()) return null;
    return {
      localized: {
        last: { en: fmtDayTime(input.lastSentAt, input.timeZone, 'en'), id: fmtDayTime(input.lastSentAt, input.timeZone, 'id') },
        next: { en: fmtDayTime(next, input.timeZone, 'en'), id: fmtDayTime(next, input.timeZone, 'id') },
      },
      data: { lastSentAt: input.lastSentAt.toISOString(), retryAfter: Math.ceil((next.getTime() - input.now.getTime()) / 1000) },
    };
  }
}
