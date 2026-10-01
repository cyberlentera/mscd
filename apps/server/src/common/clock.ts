import { Inject, Injectable, Optional } from '@nestjs/common';
import { MscdConfig } from '../config/mscd-config';
import { localDate } from './dates';

/** Looks up the time zone of an organisation (`platform.organization.time_zone`); provided by the tenancy module. */
export interface OrgTimeZoneLookup {
  timeZoneOf(orgId: string): Promise<string>;
}

/** Injection token of the `OrgTimeZoneLookup` (the tenancy module binds it to `TenantResolver`). */
export const ORG_TIME_ZONE_LOOKUP = Symbol.for('mscd.orgTimeZoneLookup');

/** Default organisation time zone (C.4 `organization.time_zone` default). */
export const DEFAULT_TIME_ZONE = 'Asia/Jakarta';

/**
 * Time source of the server (D-07, A-22). `today(orgId)` is the organisation's local date; the profile key
 * `demo.fixed_today` (demo and test installs only, D-20) replaces it everywhere. Tests replace `now()` by
 * overriding the provider with `Clock.fixed(...)`.
 */
@Injectable()
export class Clock {
  constructor(
    private readonly config: MscdConfig,
    @Optional() @Inject(ORG_TIME_ZONE_LOOKUP) private readonly timeZones?: OrgTimeZoneLookup,
  ) {}

  /** A clock whose `now()` is always `at` (tests and commands that replay a date). */
  static fixed(config: MscdConfig, at: Date, timeZones?: OrgTimeZoneLookup): Clock {
    const clock = new Clock(config, timeZones);
    clock.now = () => new Date(at.getTime());
    return clock;
  }

  /** The current instant. */
  now(): Date {
    return new Date();
  }

  /** `demo.fixed_today` when demo mode sets it, else null. */
  get fixedToday(): string | null {
    const demo = this.config.profile.demo;
    return demo.enabled && demo.fixed_today ? demo.fixed_today : null;
  }

  /** Today in a time zone (IANA name), or `demo.fixed_today`. */
  todayIn(timeZone: string): string {
    return this.fixedToday ?? localDate(this.now(), timeZone);
  }

  /** Today in the organisation's time zone (D-07), or `demo.fixed_today`. */
  async today(orgId: string): Promise<string> {
    const fixed = this.fixedToday;
    if (fixed) return fixed;
    const timeZone = this.timeZones ? await this.timeZones.timeZoneOf(orgId) : DEFAULT_TIME_ZONE;
    return localDate(this.now(), timeZone);
  }
}
