// The business rule engine (build plan K.2 WP-20, digest 6.1, TS 3.5). Commands ask it to check one rule with an
// input for the systems the change concerns: the rule runs for each system whose edition activates it
// (`ref.rule_activation`), and for a shared entity it runs for every linked system; a violation in any one system is
// enough to reject the command. Implementations are found through `@BusinessRule` (DiscoveryService), so later work
// packages add rules in their own modules.
import { Injectable, Logger } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { Messages, RecordRef, RuleId, Warning } from '@mscd/shared';
import { BusinessRuleError } from '../../common/problems';
import type { Trx } from '../../common/tokens';
import {
  BUSINESS_RULE_METADATA, type BusinessRuleHandler, type BusinessRuleMetadata, type RuleSeverity, type RuleViolation,
} from './business-rule';
import { ruleMessageKey, ruleMessages } from './messages';
import { RuleActivationService } from './rule-activation';

/** One violation found for one system. */
export interface RuleFinding {
  rule: RuleId;
  severity: RuleSeverity;
  /** `management_system.id` the rule was evaluated for. */
  msId: string;
  messages: Messages;
  ref?: RecordRef;
  affected?: string[];
  data?: unknown;
}

export interface RuleRunOptions {
  /**
   * Systems to evaluate the rule for: the record's system, or every system a shared entity is linked to (TS 3.5).
   * The rule runs only where it is active.
   */
  msIds: readonly string[];
  /** Record named in the problem or warning when the violation gives none. */
  ref?: RecordRef;
}

interface Registered {
  metadata: BusinessRuleMetadata;
  handler: BusinessRuleHandler<unknown>;
}

@Injectable()
export class RuleEngine {
  private readonly logger = new Logger(RuleEngine.name);
  private registry: Map<RuleId, Registered> | null = null;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly activation: RuleActivationService,
  ) {}

  /** Every `@BusinessRule` provider of the application by rule id; two providers for one rule are an error. */
  private rules(): Map<RuleId, Registered> {
    if (this.registry) return this.registry;
    const found = new Map<RuleId, Registered>();
    for (const wrapper of this.discovery.getProviders()) {
      const { metatype, instance } = wrapper;
      if (!metatype || typeof metatype !== 'function' || !instance) continue;
      const metadata = Reflect.getMetadata(BUSINESS_RULE_METADATA, metatype) as BusinessRuleMetadata | undefined;
      if (!metadata) continue;
      if (typeof (instance as Partial<BusinessRuleHandler>).check !== 'function') {
        throw new Error(`@BusinessRule(${metadata.rule}) on ${metatype.name}: the class has no check(input) method`);
      }
      const existing = found.get(metadata.rule);
      if (existing && existing.handler !== instance) {
        throw new Error(`Two implementations of ${metadata.rule}: ${existing.handler.constructor.name} and ${metatype.name}`);
      }
      found.set(metadata.rule, { metadata, handler: instance as BusinessRuleHandler<unknown> });
    }
    this.registry = found;
    this.logger.debug(`Business rules registered: ${[...found.keys()].sort().join(', ') || 'none'}`);
    return found;
  }

  /** Rule ids with an implementation in this application, sorted. */
  registered(): RuleId[] {
    return [...this.rules().keys()].sort();
  }

  /** True when the rule is active for the system (platform rules always are). */
  isActive(trx: Trx, rule: RuleId, msId: string): Promise<boolean> {
    return this.activation.isActive(trx, rule, msId);
  }

  /**
   * Runs one rule for every system of `options.msIds` where it is active and returns what it found, without
   * throwing. An unregistered rule is a programming error.
   */
  async evaluate<I>(trx: Trx, rule: RuleId, input: I, options: RuleRunOptions): Promise<RuleFinding[]> {
    const registered = this.rules().get(rule);
    if (!registered) throw new Error(`No implementation of ${rule} is registered (@BusinessRule)`);
    const findings: RuleFinding[] = [];
    for (const msId of [...new Set(options.msIds)]) {
      const params = await this.activation.paramsOf(trx, rule, msId);
      if (params === null) continue;
      const violation: RuleViolation | null | undefined = await registered.handler.check({ trx, msId, params, input });
      if (!violation) continue;
      const ref = violation.ref ?? options.ref;
      findings.push({
        rule,
        severity: registered.metadata.severity,
        msId,
        messages: violation.messages ?? ruleMessages(rule, violation.vars, violation.localized),
        ...(ref ? { ref } : {}),
        ...(violation.affected ? { affected: violation.affected } : {}),
        ...(violation.data !== undefined ? { data: violation.data } : {}),
      });
    }
    return findings;
  }

  /**
   * Runs one rule and acts on its severity: an `error` finding throws 422 `business-rule` (the first system that
   * fails is enough, TS 3.5); `warning` findings come back as D.1 warnings (one per distinct message); `flag`
   * findings are returned by `evaluate` only.
   */
  async enforce<I>(trx: Trx, rule: RuleId, input: I, options: RuleRunOptions): Promise<Warning[]> {
    const findings = await this.evaluate(trx, rule, input, options);
    const error = findings.find((f) => f.severity === 'error');
    if (error) {
      throw new BusinessRuleError(rule, error.messages, error.ref, {
        messageKey: ruleMessageKey(rule),
        ...(error.affected ? { affected: error.affected } : {}),
      });
    }
    return warningsOf(findings);
  }
}

/** The D.1 warnings of a list of findings, one per rule and distinct English text. */
export function warningsOf(findings: readonly RuleFinding[]): Warning[] {
  const seen = new Set<string>();
  const out: Warning[] = [];
  for (const f of findings) {
    if (f.severity !== 'warning') continue;
    const key = `${f.rule}\u0000${f.messages.en}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ rule: f.rule, messages: f.messages });
  }
  return out;
}

/** Joins warning lists without repeating a rule and text. */
export function mergeWarnings(...lists: readonly (readonly Warning[])[]): Warning[] {
  const seen = new Set<string>();
  const out: Warning[] = [];
  for (const w of lists.flat()) {
    const key = `${w.rule}\u0000${w.messages.en}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}
