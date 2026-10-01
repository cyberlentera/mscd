// Problem details filter (build plan D.1, F.12). Every error of an api request becomes an RFC 9457
// `application/problem+json` document with a D.1 slug: problem errors as thrown, zod errors as 400 `validation`,
// Nest and Fastify HTTP errors by status, PostgreSQL errors by SQLSTATE (`23505` 409, `23514` 422, `23503` from
// `assert_member` 422 `NOT-A-MEMBER`). Internal errors carry the request id only, never a message or stack.
import { ArgumentsHost, Catch, HttpException, Logger, type ExceptionFilter } from '@nestjs/common';
import type { BusinessRuleId, FieldError } from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { currentRequestId } from './request-context';
import {
  BusinessRuleError,
  ConflictError,
  DependencyUnavailableError,
  ForbiddenError,
  InternalError,
  NotAMemberError,
  NotFoundError,
  PayloadTooLargeError,
  ProblemError,
  RateLimitedError,
  UnauthenticatedError,
  ValidationError,
} from './problems';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

/** Dotted path of a zod issue path, with an optional prefix (`body.items.0.code`). */
export function issuePath(path: readonly PropertyKey[], prefix?: string): string {
  const parts = path.map((p) => (typeof p === 'symbol' ? p.toString() : String(p)));
  return [prefix, ...parts].filter((p) => p !== undefined && p !== '').join('.');
}

/** Field errors of a zod error (D.1 `errors[]`). */
export function zodFieldErrors(error: ZodError, prefix?: string): FieldError[] {
  return error.issues.map((issue) => ({ path: issuePath(issue.path, prefix), message: issue.message }));
}

interface PgError {
  code: string;
  message: string;
  constraint?: string;
  severity?: string;
}

function isPgError(error: unknown): error is PgError {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as Partial<PgError> & { name?: string };
  return typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) && typeof e.message === 'string' && (e.name === 'error' || typeof e.severity === 'string');
}

const NETWORK_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'EPIPE']);

const STATUS_PROBLEMS: Readonly<Record<number, () => ProblemError>> = {
  401: () => new UnauthenticatedError(),
  403: () => new ForbiddenError(),
  404: () => new NotFoundError(),
  409: () => new ConflictError(),
  413: () => new PayloadTooLargeError(),
  503: () => new DependencyUnavailableError(),
};

/** The problem error of an HTTP status (Nest or Fastify errors); other 4xx answers are `validation`, 5xx `internal`. */
function fromStatus(status: number, message: string | undefined, retryAfter?: number): ProblemError {
  if (status === 429) return new RateLimitedError(retryAfter ?? 60);
  const make = STATUS_PROBLEMS[status];
  if (make) return make();
  if (status >= 400 && status < 500) {
    return new ValidationError([], message && message.length <= 200 ? message : 'The request cannot be processed');
  }
  return new InternalError(message);
}

/** The problem for a PostgreSQL error by SQLSTATE (D.1). */
function fromPostgres(error: PgError): ProblemError {
  const { code, message } = error;
  if (code === '23505') return new ConflictError('A record with the same identifier already exists', { messageKey: 'db.unique_violation' });
  if (code === '23514') {
    const rule = /^(BR-\d{2}):/.exec(message)?.[1] as BusinessRuleId | undefined;
    if (rule) return new BusinessRuleError(rule, { en: message, id: message });
    return new ProblemError('business-rule', {
      messageKey: error.constraint ? `db.check.${error.constraint}` : 'db.check_violation',
      messages: { en: 'The values break a rule of the record', id: 'Nilai melanggar aturan rekaman' },
    });
  }
  if (code === '23503') {
    if (/is not a member of organisation/.test(message)) return new NotAMemberError();
    return new ProblemError('business-rule', {
      messageKey: 'db.foreign_key_violation',
      messages: { en: 'A referenced record does not exist', id: 'Rekaman yang dirujuk tidak ada' },
    });
  }
  if (code === '23502') {
    return new ProblemError('business-rule', {
      messageKey: 'db.not_null_violation',
      messages: { en: 'A required value is missing', id: 'Nilai wajib tidak diisi' },
    });
  }
  if (code === '22P02' || code === '22007' || code === '22008' || code === '22003') {
    return new ValidationError([], 'A value has the wrong format');
  }
  if (code === '42501') return new ForbiddenError();
  if (code === '40001' || code === '40P01' || code === '55P03') return new ConflictError('The record is being changed by another request; try again');
  if (code === '57014' || code.startsWith('08') || code.startsWith('53') || code === '57P01' || code === '57P03') {
    return new DependencyUnavailableError('The database is unavailable or too slow; try again later', { cause: error });
  }
  return new InternalError(`PostgreSQL error ${code}`, { cause: error });
}

/** Maps any error to the problem error the api answers with. */
export function toProblemError(error: unknown): ProblemError {
  if (error instanceof ProblemError) return error;
  if (error instanceof ZodError) return new ValidationError(zodFieldErrors(error));
  if (error instanceof HttpException) {
    const response = error.getResponse();
    const message = typeof response === 'string' ? response : (response as { message?: unknown }).message;
    return fromStatus(error.getStatus(), typeof message === 'string' ? message : undefined);
  }
  if (isPgError(error)) return fromPostgres(error);
  if (typeof error === 'object' && error !== null) {
    const e = error as { statusCode?: unknown; code?: unknown; message?: unknown; retryAfter?: unknown };
    if (typeof e.code === 'string' && NETWORK_ERROR_CODES.has(e.code)) {
      return new DependencyUnavailableError(undefined, { cause: error });
    }
    if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 600) {
      // Fastify errors (body parser, multipart limits, rate limit plugin).
      if (e.statusCode === 415) return new ValidationError([], 'Unsupported media type');
      if (e.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || e.code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
        return new ValidationError([], 'The body is not valid JSON');
      }
      return fromStatus(e.statusCode, typeof e.message === 'string' ? e.message : undefined, typeof e.retryAfter === 'number' ? e.retryAfter : undefined);
    }
  }
  return new InternalError(error instanceof Error ? error.message : String(error), { cause: error });
}

/** Writes a problem error to a Fastify reply. */
export function sendProblem(reply: FastifyReply, problem: ProblemError, requestId: string): void {
  const body = problem.toProblem(requestId);
  if (body.retryAfter !== undefined) reply.header('retry-after', String(body.retryAfter));
  reply.status(problem.status).header('content-type', PROBLEM_CONTENT_TYPE).send(JSON.stringify(body));
}

/** Global exception filter of run mode `api` (registered by `PlatformModule`). */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger('Problem');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();
    const problem = toProblemError(exception);
    const requestId = (request?.id as string | undefined) ?? currentRequestId() ?? 'unknown';
    if (problem.status >= 500) {
      const cause = problem.cause ?? exception;
      this.logger.error(
        { err: cause instanceof Error ? cause : new Error(String(cause)), requestId, url: request?.url?.split('?')[0] },
        `Request ${requestId} failed: ${problem.message}`,
      );
    }
    if (reply.sent) return;
    sendProblem(reply, problem, requestId);
  }
}
