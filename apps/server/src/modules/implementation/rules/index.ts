// Rule implementations of the implementation commands (registered with `@BusinessRule`, run by `RuleEngine`).
import { Br01EvidenceRule, Br02RiskLinkRule, Br03ExclusionJustificationRule } from './applicability.rules';
import {
  Br12GateRule, Br39BlockerRule, Br40OutputDocumentRule, Br46GateConsistencyRule, Br47OutputStatusRule, VerifySelfRule,
} from './activity.rules';

export * from './applicability.rules';
export * from './activity.rules';

/** Every rule provider of this module (listed in `ImplementationModule.providers`). */
export const IMPLEMENTATION_RULES = [
  Br01EvidenceRule,
  Br02RiskLinkRule,
  Br03ExclusionJustificationRule,
  Br12GateRule,
  Br39BlockerRule,
  Br40OutputDocumentRule,
  Br46GateConsistencyRule,
  Br47OutputStatusRule,
  VerifySelfRule,
] as const;
