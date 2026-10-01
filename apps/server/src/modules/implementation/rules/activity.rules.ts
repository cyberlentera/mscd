// Rules of the activity and phase commands (digest 6.2 and 6.4, TS 6.6, D-13, A.4 5.4, A-48): BR-12 (critical
// gates), BR-39 (a blocked activity names its gate item and reason), BR-40 (controlled-document outputs are linked
// before completion), BR-46 (blocked activities against open gate items, a flag), BR-47 (output document status
// against activity status, a warning) and VERIFY-SELF (nobody verifies their own work).
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { BusinessRule, type BusinessRuleHandler, type RuleCheck, type RuleViolation } from '../../rules';

/**
 * BR-12 input: `start` when an activity of phase `phaseNo` leaves `not_started` (rejected while an earlier critical
 * gate phase has an activity that is not verified, D-13); `phase` when phase `phaseNo` is verified as a whole
 * (rejected unless every activity is verified).
 */
export type Br12Input =
  | { kind: 'start'; phaseNo: number }
  | { kind: 'phase'; phaseNo: number; total: number; verified: number };

@Injectable()
@BusinessRule('BR-12', { severity: 'error' })
export class Br12GateRule implements BusinessRuleHandler<Br12Input> {
  async check({ trx, msId, input }: RuleCheck<Br12Input>): Promise<RuleViolation | null> {
    if (input.kind === 'phase') {
      if (input.total > 0 && input.verified === input.total) return null;
      return {
        messages: {
          en: 'Phase verification needs all activities Verified',
          id: 'Verifikasi fase memerlukan semua aktivitas Terverifikasi',
        },
        data: { phase: input.phaseNo, total: input.total, verified: input.verified },
      };
    }
    const { rows } = await sql<{ phase_no: number }>`
      select min(phase_no)::int as phase_no from implementation_activity_progress
       where management_system_id = ${msId} and deleted_at is null and is_gate_phase
         and phase_no < ${input.phaseNo} and status <> 'verified'`.execute(trx);
    const gate = rows[0]?.phase_no ?? null;
    return gate === null ? null : { vars: { phase: gate }, data: { gatePhase: gate } };
  }
}

export interface Br39Input {
  gateItemRef: string;
  /** Business ids of the system's current gate items (A-27: requirements holding the gate, open chain gate records). */
  gateItems: readonly string[];
}

/** BR-39: the blocker must name one of the system's current gate items (A-27); reason and reference are required. */
@Injectable()
@BusinessRule('BR-39', { severity: 'error' })
export class Br39BlockerRule implements BusinessRuleHandler<Br39Input> {
  check({ input }: RuleCheck<Br39Input>): RuleViolation | null {
    const ref = input.gateItemRef.trim();
    return ref !== '' && input.gateItems.includes(ref) ? null : { data: { gateItemRef: ref } };
  }
}

export interface Br40Input {
  /** Output code copied from the pack template (`output_document_code`): the output is a controlled document. */
  outputDocumentCode: string | null;
  /** The linked register document (`output_document_id`) after the command resolved it. */
  outputDocumentId: string | null;
}

/** BR-40: an activity whose output is a controlled document is completed only with the document linked. */
@Injectable()
@BusinessRule('BR-40', { severity: 'error' })
export class Br40OutputDocumentRule implements BusinessRuleHandler<Br40Input> {
  check({ input }: RuleCheck<Br40Input>): RuleViolation | null {
    return input.outputDocumentCode && !input.outputDocumentId ? { data: { outputDocumentCode: input.outputDocumentCode } } : null;
  }
}

export interface Br46Input {
  /** Blocked activities of the gate phase (the critical gate of the system). */
  blockedActivities: number;
  /** Open gate items of the system (A-27). */
  openGateItems: number;
}

/** BR-46 (flag): the gate phase holds more or fewer blocked activities than there are open gate items. */
@Injectable()
@BusinessRule('BR-46', { severity: 'flag' })
export class Br46GateConsistencyRule implements BusinessRuleHandler<Br46Input> {
  check({ input }: RuleCheck<Br46Input>): RuleViolation | null {
    return input.blockedActivities === input.openGateItems ? null : { data: { ...input } };
  }
}

export interface Br47Input {
  activityStatus: string;
  documentCode: string;
  documentStatus: string;
}

/**
 * BR-47 (warning): the output document's status contradicts the activity's, for example an approved document while
 * the activity is blocked because of it, or a verified activity whose output is not approved.
 */
@Injectable()
@BusinessRule('BR-47', { severity: 'warning' })
export class Br47OutputStatusRule implements BusinessRuleHandler<Br47Input> {
  check({ input }: RuleCheck<Br47Input>): RuleViolation | null {
    const contradiction =
      (input.activityStatus === 'blocked' && input.documentStatus === 'approved') ||
      (input.activityStatus === 'verified' && input.documentStatus !== 'approved');
    return contradiction ? { data: { ...input } } : null;
  }
}

export interface VerifySelfInput {
  actorId: string;
  /** People who may not verify: the completer and, per machine, the owner (A.4 5.4). */
  excluded: readonly (string | null | undefined)[];
}

/**
 * VERIFY-SELF (A.4 5.4, A-48): a requirement is verified by someone other than `coalesce(completed_by, owner)`, an
 * activity by someone other than its completer and its owner; when the MS Manager owns the activity another MS
 * Manager or a Programme Owner verifies.
 */
@Injectable()
@BusinessRule('VERIFY-SELF', { severity: 'error' })
export class VerifySelfRule implements BusinessRuleHandler<VerifySelfInput> {
  check({ input }: RuleCheck<VerifySelfInput>): RuleViolation | null {
    return input.excluded.some((id) => id && id === input.actorId) ? {} : null;
  }
}
