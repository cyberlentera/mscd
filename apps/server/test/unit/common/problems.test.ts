import { BadRequestException, ForbiddenException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { Problem } from '@mscd/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toProblemError, zodFieldErrors } from '../../../src/common/problem-filter';
import {
  BusinessRuleError,
  ConfirmationRequiredError,
  ConflictError,
  DependencyUnavailableError,
  InternalError,
  NotAMemberError,
  PreconditionFailedError,
  ProblemError,
  RateLimitedError,
  ReadOnlyModeError,
  ReauthRequiredError,
  TransitionNotAllowedError,
  ValidationError,
} from '../../../src/common/problems';

const REQUEST_ID = 'req-test-0001';

/** A pg DatabaseError as the driver throws it. */
function pgError(code: string, message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { name: 'error', code, severity: 'ERROR', ...extra });
}

function problemOf(error: unknown) {
  const problem = toProblemError(error).toProblem(REQUEST_ID);
  expect(Problem.safeParse(problem).success, JSON.stringify(problem)).toBe(true);
  return problem;
}

describe('problem errors (D.1)', () => {
  it('carry the slug, status and extension members', () => {
    const ref = { module: 'audit' as const, entityType: 'risk', id: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b', code: 'R-031' };
    const rule = problemOf(new BusinessRuleError('BR-01', { en: 'No valid evidence', id: 'Tidak ada bukti valid' }, ref));
    expect(rule).toMatchObject({
      type: 'https://mscd.cyberlentera.com/problems/business-rule',
      status: 422,
      rule: 'BR-01',
      messages: { en: 'No valid evidence', id: 'Tidak ada bukti valid' },
      ref,
      requestId: REQUEST_ID,
    });
    expect(problemOf(new TransitionNotAllowedError('implemented', 'planned'))).toMatchObject({ status: 409, type: expect.stringMatching(/transition-not-allowed$/) });
    expect(problemOf(new ConfirmationRequiredError(['isms', 'qms'], { rule: 'BR-22' }))).toMatchObject({ status: 409, affected: ['isms', 'qms'], rule: 'BR-22' });
    const methods = { local: false, providers: [{ slug: 'keycloak', kind: 'oidc' as const, label: 'Keycloak' }] };
    expect(problemOf(new ReauthRequiredError(methods))).toMatchObject({ status: 409, methods });
    expect(problemOf(new PreconditionFailedError())).toMatchObject({ status: 412 });
    expect(problemOf(new ReadOnlyModeError())).toMatchObject({ status: 403, rule: 'BR-37', type: expect.stringMatching(/read-only-mode$/) });
    expect(problemOf(new RateLimitedError(12.2))).toMatchObject({ status: 429, retryAfter: 13 });
    expect(problemOf(new NotAMemberError('bagus'))).toMatchObject({ status: 422, rule: 'NOT-A-MEMBER' });
    expect(problemOf(new ConflictError('taken'))).toMatchObject({ status: 409, detail: 'taken' });
    expect(problemOf(new DependencyUnavailableError())).toMatchObject({ status: 503 });
  });

  it('keep internal errors to the request id', () => {
    const problem = problemOf(new InternalError('secret stack detail'));
    expect(problem).toEqual({ type: 'https://mscd.cyberlentera.com/problems/internal', title: 'Internal error', status: 500, requestId: REQUEST_ID });
    expect(problemOf(new Error('database password is xyz'))).toEqual(problem);
  });
});

describe('error mapping (D.1)', () => {
  it('maps zod errors to 400 validation with dotted paths', () => {
    const result = z.object({ to: z.enum(['a', 'b']), items: z.array(z.object({ code: z.string() })) }).safeParse({ to: 'c', items: [{}] });
    expect(result.success).toBe(false);
    if (result.success) return;
    const problem = problemOf(result.error);
    expect(problem.status).toBe(400);
    expect(problem.errors?.map((e) => e.path)).toEqual(['to', 'items.0.code']);
    expect(zodFieldErrors(result.error, 'body').map((e) => e.path)).toEqual(['body.to', 'body.items.0.code']);
  });

  it('maps Nest HTTP errors by status', () => {
    expect(problemOf(new NotFoundException('Cannot GET /x')).status).toBe(404);
    expect(problemOf(new ForbiddenException()).status).toBe(403);
    expect(problemOf(new PayloadTooLargeException()).status).toBe(413);
    expect(problemOf(new BadRequestException('Multipart: boundary not found'))).toMatchObject({ status: 400, detail: 'Multipart: boundary not found' });
  });

  it('maps PostgreSQL errors by SQLSTATE', () => {
    expect(problemOf(pgError('23505', 'duplicate key value violates unique constraint "risk_code_uq"'))).toMatchObject({ status: 409, type: expect.stringMatching(/conflict$/) });
    expect(problemOf(pgError('23514', 'new row violates check constraint "residual_check"', { constraint: 'residual_check' }))).toMatchObject({
      status: 422,
      type: expect.stringMatching(/business-rule$/),
      messageKey: 'db.check.residual_check',
    });
    expect(problemOf(pgError('23514', 'BR-43: preparation task due 2026-10-10 is not before the audit on 2026-10-01'))).toMatchObject({ status: 422, rule: 'BR-43' });
    expect(
      problemOf(pgError('23503', 'User 8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b in column owner_user_id is not a member of organisation 00000000-0000-4000-8000-00000000a001')),
    ).toMatchObject({ status: 422, rule: 'NOT-A-MEMBER' });
    const fk = problemOf(pgError('23503', 'insert or update on table "risk" violates foreign key constraint'));
    expect(fk).toMatchObject({ status: 422, messageKey: 'db.foreign_key_violation' });
    expect(fk.rule).toBeUndefined();
    expect(problemOf(pgError('42501', 'new row violates row-level security policy for table "risk"')).status).toBe(403);
    expect(problemOf(pgError('40001', 'could not serialize access')).status).toBe(409);
    expect(problemOf(pgError('57014', 'canceling statement due to statement timeout')).status).toBe(503);
    expect(problemOf(pgError('22P02', 'invalid input syntax for type uuid')).status).toBe(400);
    const unknown = problemOf(pgError('XX000', 'internal error with secret'));
    expect(unknown.status).toBe(500);
    expect(JSON.stringify(unknown)).not.toContain('secret');
  });

  it('maps Fastify and network errors', () => {
    expect(problemOf(Object.assign(new Error('Request body is too large'), { statusCode: 413, code: 'FST_ERR_CTP_BODY_TOO_LARGE' })).status).toBe(413);
    expect(problemOf(Object.assign(new Error('Body is not valid JSON'), { statusCode: 400, code: 'FST_ERR_CTP_INVALID_JSON_BODY' }))).toMatchObject({
      status: 400,
      detail: 'The body is not valid JSON',
    });
    expect(problemOf(Object.assign(new Error('Unsupported Media Type'), { statusCode: 415, code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE' })).status).toBe(400);
    expect(problemOf(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })).status).toBe(503);
    expect(problemOf(Object.assign(new Error('Rate limit exceeded'), { statusCode: 429 })).status).toBe(429);
  });

  it('passes problem errors through unchanged', () => {
    const error = new ValidationError([{ path: 'body.to', message: 'Invalid option' }]);
    expect(toProblemError(error)).toBe(error);
    expect(error).toBeInstanceOf(ProblemError);
  });
});
