// BR-22 for every command that changes or deletes a shared entity (document, evidence, context issue, interested
// party, asset, risk, metric, audit event, management review; TS 3.5): when the entity is linked to more than one
// system and the request carries no `confirm: true`, the command answers 409 `confirmation-required` with the slugs
// of the other systems in `affected` (their codes in the message) and the rule's text (D.1). Exported for WP-36 and WP-37, which call it for
// their register edits instead of registering BR-22 again.
import { Injectable } from '@nestjs/common';
import { SHAREABLE_ENTITY_TYPES, type RecordRef } from '@mscd/shared';
import { ConfirmationRequiredError } from '../../common/problems';
import type { Trx } from '../../common/tokens';
import { RuleEngine } from '../rules';
import { linkedSystems } from './command-support';
import type { Br22Input } from './register.rules';

const SHAREABLE: ReadonlySet<string> = new Set(SHAREABLE_ENTITY_TYPES);

@Injectable()
export class SharedChangeGuard {
  constructor(private readonly rules: RuleEngine) {}

  /**
   * Throws 409 `confirmation-required` (BR-22) when the entity is shared with other systems and `confirmed` is not
   * true; returns the linked systems (path system first). Entities that are not shareable pass through.
   */
  async assertConfirmed(
    trx: Trx,
    entity: { entityType: string; id: string; msId: string; ref?: RecordRef },
    confirmed: boolean | undefined,
  ): Promise<{ id: string; slug: string; code: string }[]> {
    if (!SHAREABLE.has(entity.entityType)) return [];
    const systems = await linkedSystems(trx, entity.entityType, entity.id, entity.msId);
    if (systems.length < 2 || confirmed === true) return systems;
    const findings = await this.rules.evaluate<Br22Input>(
      trx,
      'BR-22',
      { systems: systems.map((s) => s.code), confirmed: false },
      { msIds: systems.map((s) => s.id), ...(entity.ref ? { ref: entity.ref } : {}) },
    );
    const finding = findings[0];
    if (!finding) return systems;
    throw new ConfirmationRequiredError(systems.slice(1).map((s) => s.slug), {
      rule: 'BR-22',
      messages: finding.messages,
      detail: finding.messages.en,
    });
  }
}
