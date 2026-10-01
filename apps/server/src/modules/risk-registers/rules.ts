// Rules of the risk-side register commands (digest 6.2 and 6.3, A.5 A-01): BR-04 (the implementer of a treatment
// never accepts its residual risk), BR-17 (a risk needs an owner), BR-23 (warning for evidence that also targets
// another system through a mapping with `evidence_reusable = false`), registered with `@BusinessRule` for the
// global `RuleEngine`. BR-22 (confirmation before changing a record shared by several systems) answers 409, not 422;
// its provider is registered once, by WP-35 (`registers/register.rules.ts`), so `confirmShared` asks the engine only
// whether the rule is active for a linked system and answers 409 `confirmation-required` for the register edits.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ConfirmationRequiredError } from '../../common/problems';
import type { Trx } from '../../common/tokens';
import { BusinessRule, ruleMessages, type BusinessRuleHandler, type RuleCheck, type RuleEngine, type RuleViolation } from '../rules';
import type { LinkRow } from './support';

export interface Br04Input {
  /** The user accepting the residual risk. */
  actorId: string;
  /** `risk_treatment.implemented_by_user_id` of the treatment being accepted. */
  implementerId: string | null;
}

/**
 * BR-04 (TS 6.3): residual risk is accepted by the risk's owner and never by the person who implemented the
 * treatment. The `residual_acceptance` CHECK constraint on the implementer snapshot is the database backstop.
 */
@Injectable()
@BusinessRule('BR-04', { severity: 'error' })
export class Br04ResidualAcceptanceRule implements BusinessRuleHandler<Br04Input> {
  check({ input }: RuleCheck<Br04Input>): RuleViolation | null {
    return input.implementerId !== null && input.implementerId === input.actorId ? {} : null;
  }
}

export interface Br17Input {
  /** The risk's owner after the change; null when unassigned. */
  ownerUserId: string | null;
}

/** BR-17 (A.5 A-01): a risk without an owner is rejected. */
@Injectable()
@BusinessRule('BR-17', { severity: 'error' })
export class Br17RiskOwnerRule implements BusinessRuleHandler<Br17Input> {
  check({ input }: RuleCheck<Br17Input>): RuleViolation | null {
    return input.ownerUserId === null ? {} : null;
  }
}

export interface Br23Input {
  evidenceId: string;
}

/**
 * BR-23 (warning, TS 6.3): the evidence targets requirements of different systems that a framework mapping marks
 * as not reusable (`ref.requirement_mapping.evidence_reusable = false`), in either direction; a catalogue item
 * counts as the requirement it belongs to.
 */
@Injectable()
@BusinessRule('BR-23', { severity: 'warning' })
export class Br23NonReusableMappingRule implements BusinessRuleHandler<Br23Input> {
  async check({ trx, input }: RuleCheck<Br23Input>): Promise<RuleViolation | null> {
    return (await crossSystemNonReusable(trx, input.evidenceId)) ? {} : null;
  }
}

/** True when two live targets of the evidence in different systems are joined by a non-reusable mapping. */
export async function crossSystemNonReusable(trx: Trx, evidenceId: string): Promise<boolean> {
  const { rows } = await sql<{ found: boolean }>`
    select exists (
      select 1
        from evidence_target a
        join evidence_target b on b.evidence_id = a.evidence_id and b.management_system_id <> a.management_system_id and b.deleted_at is null
        left join ref.catalogue_item ca on ca.id = a.catalogue_item_id
        left join ref.catalogue_item cb on cb.id = b.catalogue_item_id
        join ref.requirement_mapping m
          on (m.source_requirement_id = coalesce(a.requirement_id, ca.requirement_id) and m.target_requirement_id = coalesce(b.requirement_id, cb.requirement_id))
          or (m.target_requirement_id = coalesce(a.requirement_id, ca.requirement_id) and m.source_requirement_id = coalesce(b.requirement_id, cb.requirement_id))
       where a.evidence_id = ${evidenceId} and a.deleted_at is null and m.evidence_reusable = false
    ) as found`.execute(trx);
  return rows[0]?.found === true;
}

/**
 * BR-22 (TS 3.5): a change to a record linked to more than one system needs `confirm: true`; without it the
 * command answers 409 `confirmation-required` with the other systems in `affected` and in the message. The rule
 * applies when any linked system's edition activates it.
 */
export async function confirmShared(
  trx: Trx,
  rules: Pick<RuleEngine, 'isActive'>,
  links: readonly Pick<LinkRow, 'msId' | 'slug'>[],
  pathSlug: string,
  confirm: boolean | undefined,
): Promise<void> {
  const systems = [...new Map(links.map((l) => [l.msId, l.slug])).entries()];
  if (systems.length < 2 || confirm === true) return;
  let active = false;
  for (const [msId] of systems) {
    if (await rules.isActive(trx, 'BR-22', msId)) {
      active = true;
      break;
    }
  }
  if (!active) return;
  const others = systems.filter(([, slug]) => slug !== pathSlug).sort(([, a], [, b]) => a.localeCompare(b));
  const { rows } = await sql<{ id: string; code: string }>`
    select id, code from management_system where id = any(${others.map(([id]) => id)}::uuid[])`.execute(trx);
  const codes = others.map(([id, slug]) => rows.find((r) => r.id === id)?.code ?? slug.toUpperCase());
  const messages = ruleMessages('BR-22', { systems: codes.join(', ') });
  throw new ConfirmationRequiredError(others.map(([, slug]) => slug), { rule: 'BR-22', messages, detail: messages.en });
}

/** Every rule provider of this module (listed in `RiskRegistersModule.providers`). */
export const RISK_REGISTER_RULES = [Br04ResidualAcceptanceRule, Br17RiskOwnerRule, Br23NonReusableMappingRule] as const;
