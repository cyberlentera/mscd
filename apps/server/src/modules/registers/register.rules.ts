// Business rules of the register, document and audit event commands (WP-35, digest 6.2 to 6.4): BR-16 (no
// self-approval of a document), BR-22 (a change of a shared entity lists the other systems and needs a
// confirmation), BR-41 (a due date after the next audit, warning), BR-42 (an audit date change notifies the holders
// whose items now fall after the audit) and BR-43 (preparation tasks end before the audit). They run through the
// global `RuleEngine`, only where the system's edition activates them.
import { Injectable } from '@nestjs/common';
import { fmtDay } from '../../common/dates';
import { BusinessRule, type BusinessRuleHandler, type RuleCheck, type RuleViolation } from '../rules';

/** BR-16 input: the actor and the people who authored what is being approved. */
export interface Br16Input {
  actorId: string;
  /** Submitter of the version in review (or of the current version), else the creator of the register entry. */
  authors: readonly (string | null)[];
}

@Injectable()
@BusinessRule('BR-16', { severity: 'error' })
export class Br16NoSelfApproval implements BusinessRuleHandler<Br16Input> {
  check({ input }: RuleCheck<Br16Input>): RuleViolation | null {
    return input.authors.some((a) => a !== null && a === input.actorId) ? {} : null;
  }
}

/**
 * BR-22 input: the systems a shared entity is linked to (codes, the path system first) and whether the caller
 * already confirmed. Commands answer a finding with 409 `confirmation-required` and `affected` (D.1), not 422.
 * Also used by WP-36 for register edits and by the generic soft delete.
 */
export interface Br22Input {
  /** Codes of every linked system, the path system first. */
  systems: readonly string[];
  confirmed: boolean;
}

@Injectable()
@BusinessRule('BR-22', { severity: 'error' })
export class Br22SharedChange implements BusinessRuleHandler<Br22Input> {
  check({ input }: RuleCheck<Br22Input>): RuleViolation | null {
    if (input.confirmed || input.systems.length < 2) return null;
    const others = input.systems.slice(1);
    return { vars: { systems: others.join(', ') }, affected: [...others] };
  }
}

/** BR-41 input: a due date and the date of the system's next audit. */
export interface Br41Input {
  due: string | null;
  auditDate: string | null;
}

@Injectable()
@BusinessRule('BR-41', { severity: 'warning' })
export class Br41AfterAudit implements BusinessRuleHandler<Br41Input> {
  check({ input }: RuleCheck<Br41Input>): RuleViolation | null {
    if (!input.due || !input.auditDate || input.due <= input.auditDate) return null;
    return { localized: { date: { en: fmtDay(input.auditDate, 'en'), id: fmtDay(input.auditDate, 'id') } } };
  }
}

/** BR-42 input: how many of one holder's items fall after the audit since its date changed. */
export interface Br42Input {
  count: number;
}

@Injectable()
@BusinessRule('BR-42', { severity: 'flag' })
export class Br42AuditDateChanged implements BusinessRuleHandler<Br42Input> {
  check({ input }: RuleCheck<Br42Input>): RuleViolation | null {
    return input.count > 0 ? { vars: { n: String(input.count) }, data: { count: input.count } } : null;
  }
}

/** BR-43 input: a preparation task's due date and the date of its audit event. */
export interface Br43Input {
  due: string;
  auditDate: string;
}

@Injectable()
@BusinessRule('BR-43', { severity: 'error' })
export class Br43PrepBeforeAudit implements BusinessRuleHandler<Br43Input> {
  check({ input }: RuleCheck<Br43Input>): RuleViolation | null {
    return input.due >= input.auditDate ? {} : null;
  }
}

/** Every rule provider of `RegistersModule`. */
export const REGISTER_RULES = [Br16NoSelfApproval, Br22SharedChange, Br41AfterAudit, Br42AuditDateChanged, Br43PrepBeforeAudit] as const;
