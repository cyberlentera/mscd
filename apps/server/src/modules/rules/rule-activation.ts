// Rule activation (digest 6.1, TS 3.5, build plan G.7): a business rule runs for a management system only when the
// pack of the system's edition activates it in `ref.rule_activation` (`active`, with its `params`). Platform rules
// (`LIC-*`, `VERIFY-SELF`, `NOT-A-MEMBER`, `SOD-SELF-GRANT`) are not pack content and are always active.
import { Injectable } from '@nestjs/common';
import { BUSINESS_RULE_IDS, type RuleId } from '@mscd/shared';
import { sql } from 'kysely';
import type { Trx } from '../../common/tokens';

const BUSINESS_RULES: ReadonlySet<string> = new Set(BUSINESS_RULE_IDS);

/** True for BR-01 to BR-50, whose activation comes from the pack. */
export function isPackRule(rule: RuleId): boolean {
  return BUSINESS_RULES.has(rule);
}

/** Active rules of one system: rule id to `params`. */
export type SystemRules = ReadonlyMap<string, Readonly<Record<string, unknown>>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class RuleActivationService {
  /** Per transaction: system id to its active rules (the activation of an edition never changes inside one command). */
  private readonly cache = new WeakMap<object, Map<string, SystemRules>>();

  /** The active pack rules of each system (by `management_system.framework_version_id`); unknown systems map to none. */
  async forSystems(trx: Trx, msIds: readonly string[]): Promise<Map<string, SystemRules>> {
    const cached = this.cache.get(trx) ?? new Map<string, SystemRules>();
    this.cache.set(trx, cached);
    const missing = [...new Set(msIds)].filter((id) => !cached.has(id) && UUID.test(id));
    if (missing.length > 0) {
      const { rows } = await sql<{ ms_id: string; rule_id: string; params: Record<string, unknown> | null }>`
        select ms.id as ms_id, ra.rule_id, ra.params
          from management_system ms
          join ref.rule_activation ra on ra.framework_version_id = ms.framework_version_id and ra.active
         where ms.id = any(${sql`${missing}::uuid[]`}) and ms.deleted_at is null
         order by ms.id, ra.rule_id`.execute(trx);
      const found = new Map<string, Map<string, Readonly<Record<string, unknown>>>>();
      for (const id of missing) found.set(id, new Map());
      for (const row of rows) found.get(row.ms_id)!.set(row.rule_id, Object.freeze({ ...(row.params ?? {}) }));
      for (const [id, rules] of found) cached.set(id, rules);
    }
    const out = new Map<string, SystemRules>();
    for (const id of msIds) out.set(id, cached.get(id) ?? new Map());
    return out;
  }

  /** The parameters of `rule` for a system when it is active there, else null. Platform rules are always active with `{}`. */
  async paramsOf(trx: Trx, rule: RuleId, msId: string): Promise<Readonly<Record<string, unknown>> | null> {
    if (!isPackRule(rule)) return {};
    const rules = (await this.forSystems(trx, [msId])).get(msId)!;
    return rules.get(rule) ?? null;
  }

  async isActive(trx: Trx, rule: RuleId, msId: string): Promise<boolean> {
    return (await this.paramsOf(trx, rule, msId)) !== null;
  }
}
