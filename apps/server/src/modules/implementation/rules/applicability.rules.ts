// Rules of the applicability commands (digest 6.2, A.4 5.2, E.3): BR-01 (evidence of the current period with a
// valid link before an entry is implemented), BR-02 (applicable entries need a risk-based justification in the
// frameworks whose pack activates it, ISO 27001 and ISO 37001) and BR-03 (warning for an exclusion justification
// that says nothing, with the phrase list of the pack's rule parameters).
import { Injectable } from '@nestjs/common';
import { BusinessRule, type BusinessRuleHandler, type RuleCheck, type RuleViolation } from '../../rules';
import { evidenceStateOfEntry } from '../evidence-state';

export interface Br01Input {
  entryId: string;
  /** Organisation date (D-07). */
  today: string;
  /** Instant the validity windows are measured at (C.12). */
  now: Date;
}

/**
 * BR-01 (TS 6.1, E.3): an entry becomes `implemented` only when some evidence that is fresh or aging and valid for
 * status logic has an intact or moved link and was produced within the current operating period
 * (`entryEvidenceState.satisfiesBr01`). An entry verified on an older valid item is therefore accepted although a
 * newer item is broken.
 */
@Injectable()
@BusinessRule('BR-01', { severity: 'error' })
export class Br01EvidenceRule implements BusinessRuleHandler<Br01Input> {
  async check({ trx, msId, input }: RuleCheck<Br01Input>): Promise<RuleViolation | null> {
    const state = await evidenceStateOfEntry(trx, input.entryId, msId, input.today, input.now);
    return state.satisfiesBr01 ? null : { data: state };
  }
}

export interface Br02Input {
  /** The entry applies (`is_applicable` not false and status not `not_applicable`). */
  applicable: boolean;
  /** Non-deleted risks linked to the entry after the change. */
  riskCount: number;
}

/** BR-02 (PRD 6.3): an applicable entry without a linked risk cannot be saved or verified. */
@Injectable()
@BusinessRule('BR-02', { severity: 'error' })
export class Br02RiskLinkRule implements BusinessRuleHandler<Br02Input> {
  check({ input }: RuleCheck<Br02Input>): RuleViolation | null {
    return input.applicable && input.riskCount === 0 ? {} : null;
  }
}

export interface Br03Input {
  justification: string;
}

/** Shortest exclusion justification that is not flagged when the pack gives no `minLength` (characters). */
export const BR03_DEFAULT_MIN_LENGTH = 10;

/** Lower case, single spaces, without the punctuation that does not change the meaning at either end. */
export function normaliseJustification(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s"'([{]+|[\s"'.,;:!?)\]}]+$/g, '');
}

function phraseList(params: Readonly<Record<string, unknown>>): string[] {
  const phrases = params.phrases;
  const out: string[] = [];
  if (Array.isArray(phrases)) {
    for (const p of phrases) if (typeof p === 'string') out.push(p);
  } else if (phrases && typeof phrases === 'object') {
    for (const list of Object.values(phrases as Record<string, unknown>)) {
      if (Array.isArray(list)) for (const p of list) if (typeof p === 'string') out.push(p);
    }
  }
  return out.map(normaliseJustification).filter((p) => p !== '');
}

/**
 * BR-03 (warning, A-07): the exclusion justification equals one of the pack's phrases in any language
 * (`params.phrases.en`, `params.phrases.id`) or is shorter than `params.minLength` characters (default 10).
 */
@Injectable()
@BusinessRule('BR-03', { severity: 'warning' })
export class Br03ExclusionJustificationRule implements BusinessRuleHandler<Br03Input> {
  check({ params, input }: RuleCheck<Br03Input>): RuleViolation | null {
    const text = normaliseJustification(input.justification);
    const minLength = typeof params.minLength === 'number' && params.minLength >= 0 ? params.minLength : BR03_DEFAULT_MIN_LENGTH;
    if (text.length < minLength) return {};
    const phrases = new Set(phraseList(params));
    if (phrases.has(text)) return {};
    // A justification made only of listed phrases ("n/a - tbd") says nothing either.
    const parts = text.split(/\s*[-/,;]\s+|\s+[-/,;]\s*/).map(normaliseJustification).filter((p) => p !== '');
    if (parts.length > 1 && parts.every((p) => phrases.has(p))) return {};
    return null;
  }
}
