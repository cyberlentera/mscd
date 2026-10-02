// Rules of the audit-side registers (digest 6.2, TS 6.3, PRD 8.2, A-07), registered with `@BusinessRule` for the
// global `RuleEngine`, which runs each one only for systems whose edition activates it (`ref.rule_activation`):
// - BR-06 and BR-07: a major finding closes only with a root cause analysis and a systemic check (the `finding`
//   CHECK constraint is the database backstop);
// - BR-08: a major or minor finding closes only with a linked corrective action that is closed and effective, and
//   an effectiveness verification is never dated on the implementation day (CHECK on `corrective_action`);
// - BR-09: neither the implementer nor the owner of a corrective action verifies it (CHECKs on `corrective_action`);
// - BR-13: a management review closes only when every mandatory input of every linked system has content;
// - BR-14: a management review closes only with recorded decisions.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Trx } from '../../common/tokens';
import { BusinessRule, type BusinessRuleHandler, type RuleCheck, type RuleViolation } from '../rules';
import { filled } from './support';

export interface Br06Input {
  classification: string;
  rcaText: string | null;
}

/** BR-06: a major finding cannot be closed without a root cause analysis. */
@Injectable()
@BusinessRule('BR-06', { severity: 'error' })
export class Br06RootCauseRule implements BusinessRuleHandler<Br06Input> {
  check({ input }: RuleCheck<Br06Input>): RuleViolation | null {
    return input.classification === 'major' && !filled(input.rcaText) ? {} : null;
  }
}

export interface Br07Input {
  classification: string;
  systemicCheckText: string | null;
}

/** BR-07: a major finding cannot be closed without a systemic check. */
@Injectable()
@BusinessRule('BR-07', { severity: 'error' })
export class Br07SystemicCheckRule implements BusinessRuleHandler<Br07Input> {
  check({ input }: RuleCheck<Br07Input>): RuleViolation | null {
    return input.classification === 'major' && !filled(input.systemicCheckText) ? {} : null;
  }
}

/**
 * BR-08 has two checks, one per command: closing a finding (`kind: 'finding'`, major and minor findings need a
 * linked corrective action that is `closed` with `effective = true` and verified on another day than it was
 * implemented) and verifying a corrective action (`kind: 'verification'`, the verification date differs from the
 * implementation date).
 */
export type Br08Input =
  | { kind: 'finding'; findingId: string; classification: string }
  | { kind: 'verification'; implementedAt: string | null; verifiedAt: string };

@Injectable()
@BusinessRule('BR-08', { severity: 'error' })
export class Br08EffectiveCorrectiveActionRule implements BusinessRuleHandler<Br08Input> {
  async check({ trx, input }: RuleCheck<Br08Input>): Promise<RuleViolation | null> {
    if (input.kind === 'verification') return input.implementedAt !== null && input.implementedAt === input.verifiedAt ? {} : null;
    if (input.classification !== 'major' && input.classification !== 'minor') return null;
    return (await hasEffectiveCorrectiveAction(trx, input.findingId)) ? null : {};
  }
}

/** True when a live corrective action linked to the finding is closed, effective and verified after implementation. */
export async function hasEffectiveCorrectiveAction(trx: Trx, findingId: string): Promise<boolean> {
  const { rows } = await sql<{ found: boolean }>`
    select exists (
      select 1 from corrective_action_finding l
        join corrective_action c on c.id = l.corrective_action_id and c.deleted_at is null
       where l.finding_id = ${findingId} and l.deleted_at is null
         and c.status = 'closed' and c.effective = true and c.verified_at is not null
         and (c.implemented_at is null or c.verified_at <> c.implemented_at)
    ) as found`.execute(trx);
  return rows[0]?.found === true;
}

export interface Br09Input {
  verifierId: string;
  implementerId: string | null;
  ownerId: string | null;
}

/** BR-09: a corrective action cannot be verified by its implementer or its owner. */
@Injectable()
@BusinessRule('BR-09', { severity: 'error' })
export class Br09IndependentVerifierRule implements BusinessRuleHandler<Br09Input> {
  check({ input }: RuleCheck<Br09Input>): RuleViolation | null {
    return input.verifierId === input.implementerId || input.verifierId === input.ownerId ? {} : null;
  }
}

export interface Br13Input {
  reviewId: string;
}

/** A mandatory review input of a linked system without content. */
export interface MissingReviewInput {
  msId: string;
  slug: string;
  defCode: string;
  title: string;
}

/**
 * Mandatory `review_input_def` rows of the editions of every system linked to the review whose input of that
 * system is missing or empty.
 */
export async function missingReviewInputs(trx: Trx, reviewId: string, msId?: string): Promise<MissingReviewInput[]> {
  const { rows } = await sql<{ ms_id: string; slug: string; code: string; title: string }>`
    select m.id as ms_id, m.slug, d.code, d.title
      from entity_ms_link l
      join management_system m on m.id = l.management_system_id and m.deleted_at is null
      join ref.review_input_def d on d.framework_version_id = m.framework_version_id and d.mandatory
      left join management_review_input i on i.management_review_id = l.entity_id and i.review_input_def_id = d.id
                                         and i.management_system_id = m.id and i.deleted_at is null
     where l.entity_type = 'management_review' and l.entity_id = ${reviewId} and l.deleted_at is null
       and (${msId ?? null}::uuid is null or m.id = ${msId ?? null}::uuid)
       and (i.content is null or btrim(i.content) = '')
     order by l.is_primary desc, m.slug, d.sort_order, d.code`.execute(trx);
  return rows.map((r) => ({ msId: r.ms_id, slug: r.slug, defCode: r.code, title: r.title }));
}

/**
 * BR-13: the review cannot close while a mandatory input of a linked system is empty. The rule runs once per linked
 * system where it is active and checks that system's inputs; `affected` names the system.
 */
@Injectable()
@BusinessRule('BR-13', { severity: 'error' })
export class Br13ReviewInputsRule implements BusinessRuleHandler<Br13Input> {
  async check({ trx, msId, input }: RuleCheck<Br13Input>): Promise<RuleViolation | null> {
    const missing = await missingReviewInputs(trx, input.reviewId, msId);
    if (missing.length === 0) return null;
    return { affected: [...new Set(missing.map((m) => m.slug))], data: { missing: missing.map((m) => ({ ms: m.slug, defCode: m.defCode })) } };
  }
}

export interface Br14Input {
  decisionsText: string | null;
}

/** BR-14: the review cannot close without recorded decisions. */
@Injectable()
@BusinessRule('BR-14', { severity: 'error' })
export class Br14ReviewDecisionsRule implements BusinessRuleHandler<Br14Input> {
  check({ input }: RuleCheck<Br14Input>): RuleViolation | null {
    return filled(input.decisionsText) ? null : {};
  }
}

/** Every rule provider of this module (listed in `AuditRegistersModule.providers`). */
export const AUDIT_REGISTER_RULES = [
  Br06RootCauseRule, Br07SystemicCheckRule, Br08EffectiveCorrectiveActionRule, Br09IndependentVerifierRule, Br13ReviewInputsRule, Br14ReviewDecisionsRule,
] as const;
