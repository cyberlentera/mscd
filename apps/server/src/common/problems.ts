// Problem errors of the api (build plan D.1). Services throw these; the problem filter (problem-filter.ts) turns
// every error into an RFC 9457 `application/problem+json` response. The slug decides the HTTP status
// (`PROBLEM_STATUS` of @mscd/shared); the extension members are the D.1 ones.
import { PROBLEM_STATUS, problemType, type ProblemSlug, type RuleId } from '@mscd/shared';
import type { FieldError, Messages, Problem, ReauthMethods, RecordRef } from '@mscd/shared';

/** Default English titles of the problem slugs. */
export const PROBLEM_TITLES: Readonly<Record<ProblemSlug, string>> = {
  'validation': 'Invalid request',
  'unauthenticated': 'Sign-in required',
  'csrf': 'Missing or invalid CSRF token',
  'forbidden': 'Not allowed',
  'read-only-mode': 'The organisation is in read-only mode',
  'organisation-inactive': 'The organisation is not active',
  'not-found': 'Not found',
  'transition-not-allowed': 'Transition not allowed',
  'confirmation-required': 'Confirmation required',
  'reauth-required': 'Sign in again',
  'conflict': 'Conflict',
  'precondition-failed': 'The record has changed',
  'payload-too-large': 'Payload too large',
  'business-rule': 'Business rule violated',
  'rate-limited': 'Too many requests',
  'dependency-unavailable': 'A dependency is unavailable',
  'internal': 'Internal error',
};

/** Extension members a problem may carry besides `type`, `title`, `status` and `requestId` (D.1). */
export interface ProblemExtras {
  title?: string;
  detail?: string;
  rule?: RuleId;
  messageKey?: string;
  messages?: Messages;
  ref?: RecordRef | string;
  errors?: FieldError[];
  retryAfter?: number;
  affected?: string[];
  methods?: ReauthMethods;
}

/** An error that is answered with a problem document. */
export class ProblemError extends Error {
  readonly status: number;

  constructor(
    readonly slug: ProblemSlug,
    readonly extras: ProblemExtras = {},
    options?: { cause?: unknown },
  ) {
    super(extras.detail ?? extras.messages?.en ?? extras.title ?? PROBLEM_TITLES[slug], options);
    this.name = new.target.name;
    this.status = PROBLEM_STATUS[slug];
  }

  /** The problem document for this error (`requestId` from the request). */
  toProblem(requestId: string): Problem {
    const { title, ...members } = this.extras;
    const problem: Problem = {
      type: problemType(this.slug),
      title: title ?? PROBLEM_TITLES[this.slug],
      status: this.status,
      requestId,
    };
    for (const [key, value] of Object.entries(members)) {
      if (value !== undefined) (problem as Record<string, unknown>)[key] = value;
    }
    return problem;
  }
}

/** 400 `validation` with the failing members (`path` is dotted and starts with `params`, `query`, `body` or `headers`). */
export class ValidationError extends ProblemError {
  constructor(errors: FieldError[], detail?: string) {
    super('validation', { errors, ...(detail ? { detail } : {}) });
  }
}

/** 401 `unauthenticated`. */
export class UnauthenticatedError extends ProblemError {
  constructor(extras: Pick<ProblemExtras, 'detail' | 'messageKey' | 'methods'> = {}) {
    super('unauthenticated', extras);
  }
}

/** 403 `csrf` (F.2). */
export class CsrfError extends ProblemError {
  constructor(detail = 'The X-CSRF-Token header is missing or does not match the session') {
    super('csrf', { detail });
  }
}

/** 403 `forbidden`. */
export class ForbiddenError extends ProblemError {
  constructor(detail?: string, extras: Omit<ProblemExtras, 'detail'> = {}) {
    super('forbidden', { ...extras, ...(detail ? { detail } : {}) });
  }
}

/** 403 `read-only-mode` (BR-37): the organisation's licence is past grace. */
export class ReadOnlyModeError extends ProblemError {
  constructor() {
    super('read-only-mode', {
      rule: 'BR-37',
      messages: {
        en: 'The licence has expired: the organisation is read-only until a valid licence is installed',
        id: 'Lisensi telah berakhir: organisasi hanya dapat dibaca sampai lisensi yang valid dipasang',
      },
    });
  }
}

/** 403 `organisation-inactive` (D.1 Organisation status). */
export class OrganisationInactiveError extends ProblemError {
  constructor(detail = 'The organisation of this session is not active') {
    super('organisation-inactive', { detail });
  }
}

/** 404 `not-found`. The detail never says whether the record exists elsewhere. */
export class NotFoundError extends ProblemError {
  constructor(detail?: string) {
    super('not-found', detail ? { detail } : {});
  }
}

/** 409 `transition-not-allowed`: no C.13 row allows the transition for this state and actor. */
export class TransitionNotAllowedError extends ProblemError {
  constructor(from: string | null, to: string, extras: Omit<ProblemExtras, 'detail'> = {}) {
    super('transition-not-allowed', { ...extras, detail: `Transition from ${from ?? 'nothing'} to ${to} is not allowed` });
  }
}

/** 409 `confirmation-required` (BR-22, BR-38): the request must be repeated with `confirm: true`. */
export class ConfirmationRequiredError extends ProblemError {
  constructor(affected: string[], extras: Pick<ProblemExtras, 'rule' | 'messages' | 'detail'> = {}) {
    super('confirmation-required', { ...extras, affected });
  }
}

/** 409 `reauth-required` (D-26): the target organisation does not accept the session's authentication. */
export class ReauthRequiredError extends ProblemError {
  constructor(methods: ReauthMethods, detail?: string) {
    super('reauth-required', { methods, ...(detail ? { detail } : {}) });
  }
}

/** 409 `conflict`. */
export class ConflictError extends ProblemError {
  constructor(detail?: string, extras: Omit<ProblemExtras, 'detail'> = {}) {
    super('conflict', { ...extras, ...(detail ? { detail } : {}) });
  }
}

/** 412 `precondition-failed`: `If-Match` names an older version of the record (D.1 Concurrency). */
export class PreconditionFailedError extends ProblemError {
  constructor(ref?: RecordRef | string) {
    super('precondition-failed', { detail: 'The record was changed by someone else; reload and try again', ...(ref ? { ref } : {}) });
  }
}

/** 413 `payload-too-large`. */
export class PayloadTooLargeError extends ProblemError {
  constructor(detail = 'The request body is larger than this route accepts') {
    super('payload-too-large', { detail });
  }
}

/** 422 `business-rule` with the rule id, the message in both languages and the record (D.1). */
export class BusinessRuleError extends ProblemError {
  constructor(rule: RuleId, messages: Messages, ref?: RecordRef | string, extras: Pick<ProblemExtras, 'messageKey' | 'affected'> = {}) {
    super('business-rule', { rule, messages, ...(ref ? { ref } : {}), ...extras });
  }
}

/** 422 `NOT-A-MEMBER`: a person column names someone who is not an active member of the organisation (F.7). */
export class NotAMemberError extends BusinessRuleError {
  constructor(who?: string) {
    super('NOT-A-MEMBER', {
      en: who ? `${who} is not a member of this organisation` : 'The person is not a member of this organisation',
      id: who ? `${who} bukan anggota organisasi ini` : 'Orang tersebut bukan anggota organisasi ini',
    });
  }
}

/** 429 `rate-limited` with `Retry-After` (F.3). */
export class RateLimitedError extends ProblemError {
  constructor(retryAfter: number, detail = 'Too many requests; try again later') {
    super('rate-limited', { retryAfter: Math.max(0, Math.ceil(retryAfter)), detail });
  }
}

/** 503 `dependency-unavailable`. */
export class DependencyUnavailableError extends ProblemError {
  constructor(detail = 'A service this request needs is unavailable; try again later', options?: { cause?: unknown }) {
    super('dependency-unavailable', { detail }, options);
  }
}

/** 500 `internal`. The response carries the request id only (F.12). */
export class InternalError extends ProblemError {
  constructor(message = 'Internal error', options?: { cause?: unknown }) {
    super('internal', {}, options);
    this.message = message;
  }
}
