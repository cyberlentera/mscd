// What other modules use from the rule engine (B.4: exported classes and functions, never internals).
export { RulesModule } from './rules.module';
export { RuleEngine, mergeWarnings, warningsOf, type RuleFinding, type RuleRunOptions } from './rule-engine';
export { RuleActivationService, isPackRule, type SystemRules } from './rule-activation';
export {
  BusinessRule, BUSINESS_RULE_METADATA, type BusinessRuleHandler, type BusinessRuleMetadata, type BusinessRuleOptions, type RuleCheck,
  type RuleSeverity, type RuleViolation,
} from './business-rule';
export { RULE_MESSAGES, ruleMessageKey, ruleMessages, type RuleMessageTemplate, type RuleVars } from './messages';
