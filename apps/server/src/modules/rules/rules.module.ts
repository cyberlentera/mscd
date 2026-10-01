import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { RuleActivationService } from './rule-activation';
import { RuleEngine } from './rule-engine';

/**
 * Business rule engine (build plan K.2 WP-20, digest 6.1 to 6.4): `RuleEngine` runs the `@BusinessRule`
 * implementations that the command modules register, for the systems whose edition activates them
 * (`ref.rule_activation`); `rules/messages.ts` holds every rule's message in English and Indonesian. Global, so the
 * command modules of WP-20, WP-35, WP-36 and WP-37 inject `RuleEngine` without importing this module.
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [RuleActivationService, RuleEngine],
  exports: [RuleActivationService, RuleEngine],
})
export class RulesModule {}
