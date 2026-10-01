import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import {
  LOG_REDACT_PATHS,
  REDACTED,
  redactSealedFields,
  redactUrl,
  serializeRequest,
} from '../../../src/modules/platform/logging';
import { REQUEST_ID_PATTERN, requestIdFrom } from '../../../src/modules/platform/request-id';

describe('redactUrl (F.12)', () => {
  it('replaces the values of the listed query parameters only', () => {
    expect(redactUrl('/api/v1/auth/oidc/kc/callback?code=abc&state=xyz&iss=https%3A%2F%2Fidp')).toBe(
      '/api/v1/auth/oidc/kc/callback?code=[redacted]&state=[redacted]&iss=https%3A%2F%2Fidp',
    );
    expect(redactUrl('/api/v1/ms/isms/surveillance/reviews.ics?token=secret')).toBe('/api/v1/ms/isms/surveillance/reviews.ics?token=[redacted]');
    expect(redactUrl('/x?t=1&SAMLResponse=PHN&RelayState=r&invitation=i&page=2')).toBe(
      '/x?t=[redacted]&SAMLResponse=[redacted]&RelayState=[redacted]&invitation=[redacted]&page=2',
    );
  });

  it('handles encoded names, names without a value and URLs without a query', () => {
    expect(redactUrl('/x?%74oken=a&code')).toBe('/x?%74oken=[redacted]&code=[redacted]');
    expect(redactUrl('/api/v1/system/profile')).toBe('/api/v1/system/profile');
    expect(redactUrl('/x?%E0%A4%A=1&code=2')).toBe('/x?%E0%A4%A=1&code=[redacted]');
  });
});

describe('redactSealedFields', () => {
  it('redacts keys ending in _sealed at any depth of plain objects', () => {
    expect(redactSealedFields({ a: 1, secret_sealed: 'x', nested: { list: [{ totp_sealed: 'y', ok: 2 }] } })).toEqual({
      a: 1,
      secret_sealed: REDACTED,
      nested: { list: [{ totp_sealed: REDACTED, ok: 2 }] },
    });
  });

  it('leaves class instances such as errors untouched', () => {
    const error = new Error('boom');
    expect(redactSealedFields({ err: error }).err).toBe(error);
  });
});

describe('pino redaction with the F.12 paths', () => {
  it('censors headers, secrets and sealed fields in the written line', () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const logger = pino(
      { redact: { paths: [...LOG_REDACT_PATHS], censor: REDACTED }, formatters: { log: (o) => redactSealedFields(o) } },
      stream,
    );
    logger.info({
      req: { headers: { cookie: 'mscd_session=abc', authorization: 'Bearer t', 'x-csrf-token': 'c', 'x-mscd-put': 'p', host: 'h' } },
      res: { headers: { 'set-cookie': 'mscd_session=new' } },
      body: { password: 'pw', clientSecret: 'cs', code: '123456', mfa_secret_sealed: 'v1.x', name: 'kept' },
    });
    const line = JSON.parse(lines[0]!);
    expect(line.req.headers).toEqual({
      cookie: REDACTED,
      authorization: REDACTED,
      'x-csrf-token': REDACTED,
      'x-mscd-put': REDACTED,
      host: 'h',
    });
    expect(line.res.headers['set-cookie']).toBe(REDACTED);
    expect(line.body).toEqual({ password: REDACTED, clientSecret: REDACTED, code: REDACTED, mfa_secret_sealed: REDACTED, name: 'kept' });
  });

  it('censors secrets at the top level of a log object too', () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const logger = pino({ redact: { paths: [...LOG_REDACT_PATHS], censor: REDACTED } }, stream);
    logger.warn({ password: 'Mscd-Demo-2026!', clientSecret: 'kc-secret', code: 'oidc-code', token: 't', refreshToken: 'r', context: 'kept' }, 'sign-in');
    const line = JSON.parse(lines[0]!);
    expect(line).toMatchObject({ password: REDACTED, clientSecret: REDACTED, code: REDACTED, token: REDACTED, refreshToken: REDACTED, context: 'kept' });
    expect(lines[0]).not.toContain('Mscd-Demo-2026!');
  });

  it('serializes requests with a redacted URL and no separate query object', () => {
    expect(
      serializeRequest({ id: 'r', method: 'GET', url: '/a?token=x', query: { token: 'x' }, params: {}, headers: {}, remoteAddress: '1.2.3.4' }),
    ).toEqual({ id: 'r', method: 'GET', url: '/a?token=[redacted]', headers: {}, remoteAddress: '1.2.3.4', remotePort: undefined });
  });
});

describe('request ids (D.1)', () => {
  it('accepts 8 to 64 letters, digits and dashes', () => {
    expect(requestIdFrom('abcd-1234')).toBe('abcd-1234');
    expect(requestIdFrom(['0123456789abcdef', 'other'])).toBe('0123456789abcdef');
    expect(requestIdFrom('a'.repeat(64))).toBe('a'.repeat(64));
  });

  it('replaces anything else with a UUID', () => {
    for (const bad of [undefined, '', 'short', 'a'.repeat(65), 'has space 123', 'semi;colon1', 'line\nbreak1']) {
      const id = requestIdFrom(bad);
      expect(id).not.toBe(bad);
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(REQUEST_ID_PATTERN.test(id)).toBe(true);
    }
  });
});
