// `@BusinessRule(id)` (build plan K.2 WP-20, digest 6.1): a rule implementation is a provider class decorated with
// the rule id it checks. Implementations live in the module of the command that triggers them (WP-20 in
// `implementation`, WP-35, WP-36 and WP-37 in theirs) and the `RuleEngine` finds them through Nest's
// DiscoveryService, as the worker finds job handlers, so no central file lists them.
import { SetMetadata } from '@nestjs/common';
import { RULE_IDS, type Messages, type RecordRef, type RuleId } from '@mscd/shared';
import type { Trx } from '../../common/tokens';
import type { RuleVars } from './messages';

export const BUSINESS_RULE_METADATA = 'mscd:business-rule';

/**
 * What a finding of the rule does: `error` rejects the command (422 `business-rule`), `warning` lets it succeed
 * with a `warnings` entry (D.1 Warnings), `flag` is reported to the caller without a warning (for example BR-46 in
 * the implementation summary).
 */
export type RuleSeverity = 'error' | 'warning' | 'flag';

export interface BusinessRuleOptions {
  severity: RuleSeverity;
}

export interface BusinessRuleMetadata extends BusinessRuleOptions {
  rule: RuleId;
}

/** What one evaluation of a rule sees: the transaction, the system it is evaluated for, its pack parameters and the input. */
export interface RuleCheck<I> {
  trx: Trx;
  /** `management_system.id` the rule is evaluated for (a shared entity is evaluated once per linked system, TS 3.5). */
  msId: string;
  /** `ref.rule_activation.params` of the system's edition (`{}` for platform rules). */
  params: Readonly<Record<string, unknown>>;
  input: I;
}

/** A violation found by a rule. Messages default to the rule's catalogue text with `vars` filled in. */
export interface RuleViolation {
  vars?: RuleVars;
  /** Variables whose value differs per language. */
  localized?: Readonly<Record<string, { en: string; id: string }>>;
  /** Overrides the catalogue text (for example a drift rule's own message, BR-48). */
  messages?: Messages;
  ref?: RecordRef;
  affected?: string[];
  /** Free data for flags (for example the two counts of BR-46). */
  data?: unknown;
}

/** A provider class decorated with `@BusinessRule(...)` implements this method; null or undefined means the rule holds. */
export interface BusinessRuleHandler<I = unknown> {
  check(check: RuleCheck<I>): Promise<RuleViolation | null | undefined> | RuleViolation | null | undefined;
}

const KNOWN_RULES: ReadonlySet<string> = new Set(RULE_IDS);

/** Marks a provider class as the implementation of one rule. The class must also be a provider of its module. */
export function BusinessRule(rule: RuleId, options: BusinessRuleOptions = { severity: 'error' }): ClassDecorator {
  if (!KNOWN_RULES.has(rule)) throw new Error(`@BusinessRule: unknown rule ${rule}`);
  const metadata: BusinessRuleMetadata = { rule, ...options };
  return SetMetadata(BUSINESS_RULE_METADATA, metadata);
}
