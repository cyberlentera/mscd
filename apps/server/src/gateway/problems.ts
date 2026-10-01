// Problem responses of the storage gateway (build plan D.5): `application/problem+json` with the gateway slugs
// `bad-request`, `not-found`, `forbidden`, `outside-root`, `unreachable`, `rate-limited` (with `Retry-After`),
// `unsupported`, `too-large` and `internal`. The statuses come from the shared `GATEWAY_PROBLEM_STATUS`, so the
// api's gateway client maps them back the same way.
import { GATEWAY_PROBLEM_STATUS, problemType, type GatewayProblemReason, type GatewayProblemSlug } from '@mscd/shared';

const TITLES: Readonly<Record<GatewayProblemSlug, string>> = {
  'bad-request': 'Bad request',
  'not-found': 'Not found',
  'forbidden': 'Not allowed',
  'outside-root': 'Outside the repository root',
  'unreachable': 'The storage provider is unreachable',
  'rate-limited': 'The storage provider is throttling requests',
  'unsupported': 'Not supported by this repository',
  'too-large': 'The file is larger than allowed',
  'internal': 'Internal error',
};

export interface GatewayProblemDocument {
  type: string;
  title: string;
  status: number;
  detail?: string;
  reason?: GatewayProblemReason;
  retryAfter?: number;
  requestId: string;
}

/** An error the gateway answers with a problem document. */
export class GatewayError extends Error {
  readonly status: number;

  constructor(
    readonly slug: GatewayProblemSlug,
    detail?: string,
    readonly extras: { reason?: GatewayProblemReason; retryAfter?: number } = {},
    options?: { cause?: unknown },
  ) {
    super(detail ?? TITLES[slug], options);
    this.name = 'GatewayError';
    this.status = GATEWAY_PROBLEM_STATUS[slug];
  }

  /** The problem document; `internal` problems never carry the error text (F.12). */
  toProblem(requestId: string): GatewayProblemDocument {
    const problem: GatewayProblemDocument = { type: problemType(this.slug), title: TITLES[this.slug], status: this.status, requestId };
    if (this.slug !== 'internal' && this.message !== TITLES[this.slug]) problem.detail = this.message;
    if (this.extras.reason) problem.reason = this.extras.reason;
    if (this.extras.retryAfter !== undefined) problem.retryAfter = Math.max(0, Math.ceil(this.extras.retryAfter));
    return problem;
  }
}

export const badRequest = (detail: string) => new GatewayError('bad-request', detail);
export const notFound = (detail = 'The object does not exist') => new GatewayError('not-found', detail);
export const forbidden = (detail: string, reason?: GatewayProblemReason) => new GatewayError('forbidden', detail, reason ? { reason } : {});
export const outsideRoot = (detail = 'The item is not below the root folder of this repository or system') => new GatewayError('outside-root', detail);
export const unsupported = (detail: string) => new GatewayError('unsupported', detail);
export const tooLarge = (maxBytes: number) => new GatewayError('too-large', `The file is larger than ${maxBytes} bytes`);
