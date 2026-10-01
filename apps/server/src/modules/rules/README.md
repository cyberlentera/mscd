# rules module

Business rule engine of digest 6.1 to 6.4 (build plan K.2 WP-20).

- `business-rule.ts`: `@BusinessRule(id, {severity})` marks a provider class whose `check({trx, msId, params, input})` returns a violation or null. Severity `error` rejects with 422 `business-rule`, `warning` adds a D.1 warning, `flag` is only reported.
- `rule-activation.ts`: a pack rule (BR-01 to BR-50) runs for a system only when `ref.rule_activation` of the system's edition activates it; platform rules (`LIC-*`, `VERIFY-SELF`, `NOT-A-MEMBER`, `SOD-SELF-GRANT`) always run.
- `rule-engine.ts`: `RuleEngine.enforce(trx, rule, input, {msIds, ref})` runs the rule for every system given (all linked systems for a shared entity, TS 3.5), throws on the first error and returns warnings; `evaluate` returns the findings without throwing.
- `messages.ts`: the English and Indonesian message of every rule (`ruleMessages(rule, vars)`), written once for every work package.

Implementations live in the module of the command that triggers them (WP-20 in `implementation/rules`) and are found through Nest's DiscoveryService, so later work packages add rules without editing this module.
Owner: WP-20.
