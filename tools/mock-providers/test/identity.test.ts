import { createHash, createPrivateKey, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGoogleServiceAccountAssertion, createSelfSignedCertificate } from '../src/index.js';
import {
  CLIENT_ID,
  DRIVE_SCOPE,
  OAUTH_CLIENT,
  OAUTH_SECRET,
  ORIGIN,
  REDIRECT_URI,
  SA_EMAIL,
  TENANT,
  TENANT_ALIAS,
  build,
  call,
  certificate,
  form,
  googleTokenResponse,
  graphTokenResponse,
  otherCertificate,
} from './helpers.js';

let app: FastifyInstance;

beforeEach(() => {
  app = build();
});

afterEach(async () => {
  await app.close();
});

async function rawAssertion(claims: Record<string, unknown>, header: Record<string, unknown>, privateKeyPem = certificate().privateKeyPem, alg = 'RS256') {
  return new SignJWT(claims).setProtectedHeader({ alg, typ: 'JWT', ...header }).sign(createPrivateKey(privateKeyPem));
}

function microsoftForm(assertion: string, extra: Record<string, string> = {}) {
  return form({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    scope: 'https://graph.microsoft.com/.default',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: assertion,
    ...extra,
  });
}

function baseClaims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { iss: CLIENT_ID, sub: CLIENT_ID, aud: `${ORIGIN}/${TENANT}/oauth2/v2.0/token`, jti: randomUUID(), iat: now, nbf: now, exp: now + 300, ...overrides };
}

describe('Microsoft identity token endpoint', () => {
  it('issues an app-only token for a certificate client assertion (RS256 and PS256)', async () => {
    for (const algorithm of ['RS256', 'PS256'] as const) {
      const response = await graphTokenResponse(app, { algorithm });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Object.keys(body).sort()).toEqual(['access_token', 'expires_in', 'token_type']);
      expect(body.token_type).toBe('Bearer');
      expect(body.expires_in).toBe(3599);
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });

  it('accepts the tenant alias in the URL and the public token URL as audience', async () => {
    const alias = await graphTokenResponse(app, { tenant: TENANT_ALIAS });
    expect(alias.statusCode).toBe(200);
    const canonical = await graphTokenResponse(app, { audience: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token` });
    expect(canonical.statusCode).toBe(200);
  });

  it('identifies the certificate by the SHA-1 thumbprint (x5t) as well', async () => {
    const assertion = await rawAssertion(baseClaims(), { x5t: certificate().thumbprintSha1 });
    const response = await call(app, 'POST', `/${TENANT}/oauth2/v2.0/token`, microsoftForm(assertion));
    expect(response.statusCode).toBe(200);
  });

  it('rejects wrong audience, issuer, expiry, signature and unknown certificates', async () => {
    const cases: [string, Record<string, unknown>, Record<string, unknown>, string | undefined, number][] = [
      ['audience', baseClaims({ aud: 'https://example.invalid/token' }), { 'x5t#S256': certificate().thumbprintSha256 }, undefined, 50013],
      ['issuer', baseClaims({ iss: 'someone-else', sub: 'someone-else' }), { 'x5t#S256': certificate().thumbprintSha256 }, undefined, 700021],
      ['expired', baseClaims({ exp: Math.floor(Date.now() / 1000) - 3600, nbf: Math.floor(Date.now() / 1000) - 4000, iat: Math.floor(Date.now() / 1000) - 4000 }), { 'x5t#S256': certificate().thumbprintSha256 }, undefined, 700024],
      ['signature', baseClaims(), { 'x5t#S256': certificate().thumbprintSha256 }, otherCertificate().privateKeyPem, 700027],
      ['unknown certificate', baseClaims(), { 'x5t#S256': otherCertificate().thumbprintSha256 }, otherCertificate().privateKeyPem, 700027],
      ['no thumbprint', baseClaims(), {}, undefined, 700027],
      ['no jti', { ...baseClaims(), jti: undefined }, { 'x5t#S256': certificate().thumbprintSha256 }, undefined, 50027],
    ];
    for (const [name, claims, header, key, code] of cases) {
      const assertion = await rawAssertion(claims, header, key);
      const response = await call(app, 'POST', `/${TENANT}/oauth2/v2.0/token`, microsoftForm(assertion));
      expect(response.statusCode, name).toBe(401);
      expect(response.json().error, name).toBe('invalid_client');
      expect(response.json().error_codes, name).toEqual([code]);
    }
  });

  it('rejects unknown tenants and applications, other scopes, other grants and client secrets', async () => {
    expect((await graphTokenResponse(app, { tenant: 'contoso.onmicrosoft.com' })).json().error_codes).toEqual([90002]);
    const unknownApp = await graphTokenResponse(app, { clientId: randomUUID() });
    expect(unknownApp.statusCode).toBe(400);
    expect(unknownApp.json().error).toBe('unauthorized_client');
    const scope = await graphTokenResponse(app, { scope: 'https://graph.microsoft.com/Files.Read.All' });
    expect(scope.json().error).toBe('invalid_scope');
    const grant = await call(app, 'POST', `/${TENANT}/oauth2/v2.0/token`, form({ grant_type: 'password', client_id: CLIENT_ID }));
    expect(grant.json().error).toBe('unsupported_grant_type');
    const secret = await call(app, 'POST', `/${TENANT}/oauth2/v2.0/token`, form({ grant_type: 'client_credentials', client_id: CLIENT_ID, scope: 'https://graph.microsoft.com/.default', client_secret: 'x' }));
    expect(secret.statusCode).toBe(401);
    expect(secret.json().error_codes).toEqual([7000215]);
    const missing = await call(app, 'POST', `/${TENANT}/oauth2/v2.0/token`, form({ grant_type: 'client_credentials', client_id: CLIENT_ID, scope: 'https://graph.microsoft.com/.default' }));
    expect(missing.statusCode).toBe(401);
  });

  it('refuses an expired certificate', async () => {
    const expired = createSelfSignedCertificate({ notBefore: new Date(Date.now() - 400 * 86400_000), days: 30, privateKeyPem: certificate().privateKeyPem });
    const register = await call(app, 'POST', '/_admin/credentials', {
      json: { kind: 'm365_certificate', tenantId: TENANT, clientId: 'expired-app', certificatePem: expired.certificatePem },
    });
    expect(register.statusCode).toBe(201);
    const response = await graphTokenResponse(app, { clientId: 'expired-app', cert: expired });
    expect(response.statusCode).toBe(401);
    expect(response.json().error_description).toContain('expired');
  });
});

describe('Google token endpoint', () => {
  it('issues a token for a service account assertion', async () => {
    const response = await googleTokenResponse(app);
    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json()).sort()).toEqual(['access_token', 'expires_in', 'scope', 'token_type']);
    expect(response.json().scope).toBe(DRIVE_SCOPE);
    const canonical = await googleTokenResponse(app, { audience: 'https://oauth2.googleapis.com/token' });
    expect(canonical.statusCode).toBe(200);
  });

  it('rejects unknown accounts, other keys, wrong audiences, long-lived and scope-less assertions', async () => {
    const cases: [string, Parameters<typeof googleTokenResponse>[1], string][] = [
      ['unknown account', { clientEmail: 'nobody@mscd-test.iam.gserviceaccount.com' }, 'invalid_grant'],
      ['other key id', { keyId: 'key-2' }, 'invalid_grant'],
      ['other key', { cert: otherCertificate() }, 'invalid_grant'],
      ['audience', { audience: 'https://example.invalid/token' }, 'invalid_grant'],
      ['lifetime', { lifetimeSeconds: 7200 }, 'invalid_grant'],
      ['scope', { scope: '' }, 'invalid_scope'],
    ];
    for (const [name, overrides, error] of cases) {
      const response = await googleTokenResponse(app, overrides);
      expect(response.statusCode, name).toBe(400);
      expect(response.json().error, name).toBe(error);
    }
    const grant = await call(app, 'POST', '/token', form({ grant_type: 'password' }));
    expect(grant.json().error).toBe('unsupported_grant_type');
  });

  it('acts as the delegated user when the assertion has a subject', async () => {
    const response = await googleTokenResponse(app, { subject: 'tono.hartono@nusantaradigital.co.id' });
    const token = response.json().access_token as string;
    const about = await call(app, 'GET', '/drive/v3/about?fields=user', { token });
    expect(about.json().user.emailAddress).toBe('tono.hartono@nusantaradigital.co.id');
  });

  it('refreshes tokens for registered clients and refuses revoked refresh tokens', async () => {
    const ok = await call(app, 'POST', '/token', form({ grant_type: 'refresh_token', refresh_token: '1//refresh-valid', client_id: OAUTH_CLIENT, client_secret: OAUTH_SECRET }));
    expect(ok.statusCode).toBe(200);
    expect(Object.keys(ok.json()).sort()).toEqual(['access_token', 'expires_in', 'scope', 'token_type']);
    const basic = await call(app, 'POST', '/token', {
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${OAUTH_CLIENT}:${OAUTH_SECRET}`).toString('base64')}` },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: '1//refresh-valid' }).toString(),
    });
    expect(basic.statusCode).toBe(200);
    const expired = await call(app, 'POST', '/token', form({ grant_type: 'refresh_token', refresh_token: '1//refresh-expired', client_id: OAUTH_CLIENT, client_secret: OAUTH_SECRET }));
    expect(expired.statusCode).toBe(400);
    expect(expired.json()).toEqual({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
    const secret = await call(app, 'POST', '/token', form({ grant_type: 'refresh_token', refresh_token: '1//refresh-valid', client_id: OAUTH_CLIENT, client_secret: 'wrong' }));
    expect(secret.statusCode).toBe(401);
    expect(secret.json().error).toBe('invalid_client');
    const malformed = await call(app, 'POST', '/token', {
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from('%E0%A4%A:x').toString('base64')}` },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: '1//refresh-valid' }).toString(),
    });
    expect(malformed.statusCode).toBe(401);
    expect(malformed.json().error).toBe('invalid_client');
  });

  it('runs the consent flow: authorize redirect, code exchange with PKCE, single use', async () => {
    const verifier = 'v'.repeat(50);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const query = new URLSearchParams({
      client_id: OAUTH_CLIENT,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/drive.file',
      state: 'state-123',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      login_hint: 'tono.hartono@nusantaradigital.co.id',
    });
    const authorize = await call(app, 'GET', `/o/oauth2/v2/auth?${query}`);
    expect(authorize.statusCode).toBe(302);
    const location = new URL(authorize.headers.location as string);
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get('state')).toBe('state-123');
    const code = location.searchParams.get('code') as string;
    expect(code).toBeTruthy();

    const exchange = (extra: Record<string, string>) =>
      call(app, 'POST', '/token', form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: OAUTH_CLIENT, client_secret: OAUTH_SECRET, ...extra }));
    expect((await exchange({ code_verifier: 'wrong-verifier-'.repeat(4) })).json().error_description).toBe('Invalid code verifier.');
    expect((await exchange({ code_verifier: verifier, redirect_uri: 'https://other.invalid/cb' })).json().error).toBe('redirect_uri_mismatch');
    const ok = await exchange({ code_verifier: verifier });
    expect(ok.statusCode).toBe(200);
    expect(Object.keys(ok.json()).sort()).toEqual(['access_token', 'expires_in', 'refresh_token', 'scope', 'token_type']);
    expect((await exchange({ code_verifier: verifier })).json().error).toBe('invalid_grant');

    const refreshed = await call(app, 'POST', '/token', form({ grant_type: 'refresh_token', refresh_token: ok.json().refresh_token, client_id: OAUTH_CLIENT, client_secret: OAUTH_SECRET }));
    expect(refreshed.statusCode).toBe(200);
    const about = await call(app, 'GET', '/drive/v3/about?fields=user(emailAddress,me)', { token: refreshed.json().access_token });
    expect(about.json()).toEqual({ user: { emailAddress: 'tono.hartono@nusantaradigital.co.id', me: true } });
  });

  it('refuses consent for unknown clients and redirect URIs that are not registered', async () => {
    const unknown = await call(app, 'GET', `/o/oauth2/v2/auth?client_id=nope&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=x`);
    expect(unknown.statusCode).toBe(401);
    const mismatch = await call(app, 'GET', `/o/oauth2/v2/auth?client_id=${OAUTH_CLIENT}&redirect_uri=${encodeURIComponent('https://evil.invalid/cb')}&response_type=code&scope=x`);
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.body).toContain('redirect_uri_mismatch');
  });

  it('mints codes through the admin API and revokes tokens through /revoke', async () => {
    const minted = await call(app, 'POST', '/_admin/oauth/codes', { json: { clientId: OAUTH_CLIENT, redirectUri: REDIRECT_URI, account: { email: 'sari@nusantaradigital.co.id' } } });
    expect(minted.statusCode).toBe(201);
    const exchange = await call(app, 'POST', '/token', form({ grant_type: 'authorization_code', code: minted.json().code, redirect_uri: REDIRECT_URI, client_id: OAUTH_CLIENT, client_secret: OAUTH_SECRET }));
    expect(exchange.statusCode).toBe(200);
    const token = exchange.json().access_token as string;
    expect((await call(app, 'GET', '/drive/v3/about?fields=user', { token })).statusCode).toBe(200);
    expect((await call(app, 'POST', `/revoke?token=${encodeURIComponent(token)}`)).statusCode).toBe(200);
    expect((await call(app, 'GET', '/drive/v3/about?fields=user', { token })).statusCode).toBe(401);
  });
});

describe('tokens across APIs', () => {
  it('accepts a token only on the API of the endpoint that issued it', async () => {
    const graph = (await graphTokenResponse(app)).json().access_token as string;
    const google = (await googleTokenResponse(app)).json().access_token as string;
    expect((await call(app, 'GET', '/v1.0/drives/drive-sp-compliance', { token: graph })).statusCode).toBe(200);
    expect((await call(app, 'GET', '/v1.0/drives/drive-sp-compliance', { token: google })).statusCode).toBe(401);
    expect((await call(app, 'GET', '/drive/v3/about?fields=user', { token: google })).statusCode).toBe(200);
    expect((await call(app, 'GET', '/drive/v3/about?fields=user', { token: graph })).statusCode).toBe(401);
  });

  it('refuses tokens whose scope has no Drive access', async () => {
    const assertion = await createGoogleServiceAccountAssertion({
      clientEmail: SA_EMAIL,
      privateKeyPem: certificate().privateKeyPem,
      audience: `${ORIGIN}/token`,
      scope: 'https://www.googleapis.com/auth/calendar',
    });
    const token = (await call(app, 'POST', '/token', form({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }))).json().access_token as string;
    const response = await call(app, 'GET', '/drive/v3/about?fields=user', { token });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.errors[0].reason).toBe('insufficientPermissions');
  });

  it('expires tokens after the configured lifetime', async () => {
    const short = build({ settings: { tokenLifetimeSeconds: 1 } });
    try {
      const response = await graphTokenResponse(short);
      expect(response.json().expires_in).toBe(1);
      const token = response.json().access_token as string;
      expect((await call(short, 'GET', '/v1.0/drives/drive-sp-compliance', { token })).statusCode).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const expired = await call(short, 'GET', '/v1.0/drives/drive-sp-compliance', { token });
      expect(expired.statusCode).toBe(401);
      expect(expired.json().error.code).toBe('InvalidAuthenticationToken');
      expect(expired.headers['www-authenticate']).toContain('Bearer');
    } finally {
      await short.close();
    }
  });
});
