import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type JWTPayload, type ProtectedHeaderParameters, decodeJwt, decodeProtectedHeader, errors as joseErrors, jwtVerify } from 'jose';
import { MockHttpError, entraError, googleOAuthError } from './errors.js';
import { formBody, header, originOf, queryOf, rawPath } from './http.js';
import { isTenant, randomToken } from './ids.js';
import type { Account, AuthCodeState, M365App, MockState, OAuthClient, Principal } from './state.js';

// Token endpoints.
//
// Microsoft identity platform, client credentials with a certificate (build plan J.7, D.5):
//   POST /{tenant}/oauth2/v2.0/token  grant_type=client_credentials, client_id, scope=https://graph.microsoft.com/.default,
//   client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer, client_assertion=<JWT>
// The assertion must be signed (RS256 or PS256) with the key of a certificate registered for the app, name that
// certificate in its header (`x5t#S256`, or the older `x5t`), carry iss = sub = client id, the token endpoint as
// `aud`, `exp` and `jti`, and be inside its validity window (five minutes of clock skew accepted).
//
// Google OAuth 2.0 (POST /token): `urn:ietf:params:oauth:grant-type:jwt-bearer` with a service account assertion
// (RS256, iss = client email, aud = token URL, scope, at most one hour between iat and exp, optional sub for
// domain-wide delegation), `refresh_token` and `authorization_code` (with PKCE) for registered OAuth clients.
// GET /o/oauth2/v2/auth is a consent page that signs in an account without asking and redirects with a code.

export interface IdentityContext {
  state: MockState;
  publicUrl: string | undefined;
}

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const JWT_BEARER_ASSERTION = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const CLOCK_TOLERANCE_SECONDS = 300;
const GOOGLE_TOKEN_AUDIENCES = ['https://oauth2.googleapis.com/token', 'https://www.googleapis.com/oauth2/v4/token', 'https://accounts.google.com/o/oauth2/token'];
const AUTH_CODE_LIFETIME_MS = 10 * 60 * 1000;

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

export function registerIdentityRoutes(app: FastifyInstance, context: IdentityContext): void {
  const { state } = context;

  app.post('/:tenant/oauth2/v2.0/token', async (request, reply) => {
    const { tenant } = request.params as { tenant: string };
    const body = await microsoftToken(context, request, tenant);
    return reply.code(200).headers(NO_STORE).send(body);
  });

  app.post('/token', async (request, reply) => {
    const form = formBody(request);
    const grantType = form.get('grant_type');
    let body: Record<string, unknown>;
    if (!grantType) throw googleOAuthError(400, 'invalid_request', 'Missing required parameter: grant_type');
    if (grantType === JWT_BEARER_GRANT) body = await serviceAccountToken(context, request, form);
    else if (grantType === 'refresh_token') body = refreshToken(state, request, form);
    else if (grantType === 'authorization_code') body = authorizationCode(state, request, form);
    else throw googleOAuthError(400, 'unsupported_grant_type', `Invalid grant_type: ${grantType}`);
    return reply.code(200).headers(NO_STORE).send(body);
  });

  app.post('/revoke', async (request, reply) => {
    const token = queryOf(request).get('token') ?? formBody(request).get('token');
    if (!token) throw googleOAuthError(400, 'invalid_request', 'Missing required parameter: token');
    const access = state.accessTokens.get(token);
    const refresh = state.refreshTokens.get(token);
    if (!access && !refresh) throw googleOAuthError(400, 'invalid_token', 'Token expired or revoked');
    if (access) access.revoked = true;
    if (refresh) refresh.revoked = true;
    return reply.code(200).send({});
  });

  app.get('/o/oauth2/v2/auth', async (request, reply) => {
    const query = queryOf(request);
    const clientId = query.get('client_id');
    if (!clientId) return reply.code(400).type('text/plain').send('Error 400: invalid_request\nMissing required parameter: client_id');
    const client = state.oauthClients.get(clientId);
    if (!client || client.revoked) return reply.code(401).type('text/plain').send('Error 401: invalid_client\nThe OAuth client was not found.');
    const redirectUri = query.get('redirect_uri');
    if (!redirectUri || !URL.canParse(redirectUri) || (client.redirectUris && !client.redirectUris.includes(redirectUri))) {
      return reply.code(400).type('text/plain').send('Error 400: redirect_uri_mismatch\nThe redirect URI in the request does not match the ones authorized for the OAuth client.');
    }
    const redirect = new URL(redirectUri);
    const stateParam = query.get('state');
    const finish = (params: Record<string, string>) => {
      for (const [key, value] of Object.entries(params)) redirect.searchParams.set(key, value);
      if (stateParam !== null) redirect.searchParams.set('state', stateParam);
      return reply.code(302).header('Location', redirect.toString()).send();
    };
    if (query.get('response_type') !== 'code') return finish({ error: 'unsupported_response_type' });
    const scope = query.get('scope');
    if (!scope) return finish({ error: 'invalid_request', error_description: 'Missing required parameter: scope' });
    const challenge = query.get('code_challenge');
    const method = query.get('code_challenge_method') ?? (challenge ? 'plain' : null);
    if (challenge && method !== 'S256' && method !== 'plain') return finish({ error: 'invalid_request', error_description: 'Invalid code_challenge_method' });
    const account = accountFor(client, query.get('login_hint'));
    if (!account) {
      return reply.code(400).type('text/plain').send('Error 400: no account to sign in; pass login_hint or register the client with defaultAccount');
    }
    const code = mintAuthCode(state, {
      clientId,
      redirectUri,
      account,
      scope,
      codeChallenge: challenge,
      codeChallengeMethod: challenge ? (method as 'S256' | 'plain') : null,
      offline: query.get('access_type') === 'offline',
    });
    return finish({ code, scope, iss: 'https://accounts.google.com' });
  });
}

function accountFor(client: OAuthClient, loginHint: string | null): Account | null {
  if (loginHint && /^[^\s@]+@[^\s@]+$/.test(loginHint)) {
    if (client.defaultAccount?.email.toLowerCase() === loginHint.toLowerCase()) return client.defaultAccount;
    return { email: loginHint, displayName: loginHint.split('@')[0] };
  }
  return client.defaultAccount;
}

export interface MintAuthCodeInput {
  clientId: string;
  redirectUri: string;
  account: Account;
  scope: string;
  codeChallenge?: string | null;
  codeChallengeMethod?: 'S256' | 'plain' | null;
  offline?: boolean;
}

/** Issues a single-use authorization code (also used by POST /_admin/oauth/codes). */
export function mintAuthCode(state: MockState, input: MintAuthCodeInput): string {
  const code = randomToken('4/mock-', 32);
  const record: AuthCodeState = {
    code,
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    account: input.account,
    scope: input.scope,
    codeChallenge: input.codeChallenge ?? null,
    codeChallengeMethod: input.codeChallenge ? (input.codeChallengeMethod ?? 'plain') : null,
    offline: input.offline ?? true,
    expiresAt: Date.now() + AUTH_CODE_LIFETIME_MS,
    used: false,
  };
  state.authCodes.set(code, record);
  return code;
}

function tokenResponse(state: MockState, principal: Principal, scope: string, clientId: string | null): Record<string, unknown> {
  const token = state.issueAccessToken(principal, scope, clientId);
  return { access_token: token.token, expires_in: state.settings.tokenLifetimeSeconds, scope, token_type: 'Bearer' };
}

// Microsoft

function microsoftAudiences(context: IdentityContext, request: FastifyRequest, app: M365App, tenant: string): string[] {
  const origin = originOf(request, context.publicUrl);
  const names = new Set([tenant, app.tenantId, ...app.tenantAliases]);
  const audiences = new Set<string>([`${origin}${rawPath(request)}`]);
  const hostOrigin = `${request.protocol}://${header(request, 'host') ?? 'localhost'}`;
  for (const name of names) {
    audiences.add(`https://login.microsoftonline.com/${name}/oauth2/v2.0/token`);
    audiences.add(`${origin}/${name}/oauth2/v2.0/token`);
    audiences.add(`${hostOrigin}/${name}/oauth2/v2.0/token`);
  }
  return [...audiences];
}

async function microsoftToken(context: IdentityContext, request: FastifyRequest, tenant: string): Promise<Record<string, unknown>> {
  const { state } = context;
  const form = formBody(request);
  const missing = (name: string) =>
    entraError(400, 'invalid_request', 900144, `The request body must contain the following parameter: '${name}'.`);
  const grantType = form.get('grant_type');
  if (!grantType) throw missing('grant_type');
  if (grantType !== 'client_credentials') {
    throw entraError(400, 'unsupported_grant_type', 70003, `The app requested an unsupported grant type '${grantType}'.`);
  }
  const clientId = form.get('client_id');
  if (!clientId) throw missing('client_id');
  const scope = form.get('scope');
  if (!scope) throw missing('scope');
  const scopes = scope.split(/\s+/).filter(Boolean);
  if (scopes.length !== 1 || scopes[0] !== GRAPH_SCOPE) {
    throw entraError(400, 'invalid_scope', 70011, `The provided value for the input parameter 'scope' is not valid. The scope ${scope} is not valid.`);
  }
  if (!isTenant(tenant) || !state.tenantKnown(tenant)) {
    throw entraError(400, 'invalid_request', 90002, `Tenant '${tenant}' not found. Check to make sure you have the correct tenant ID and are signing into the correct cloud.`);
  }
  const app = state.findApp(tenant, clientId);
  if (!app) {
    throw entraError(400, 'unauthorized_client', 700016, `Application with identifier '${clientId}' was not found in the directory '${tenant}'.`);
  }
  if (form.get('client_secret')) throw entraError(401, 'invalid_client', 7000215, 'Invalid client secret provided.');
  const assertion = form.get('client_assertion');
  if (!assertion) {
    throw entraError(401, 'invalid_client', 7000218, "The request body must contain the following parameter: 'client_assertion' or 'client_secret'.");
  }
  if (form.get('client_assertion_type') !== JWT_BEARER_ASSERTION) {
    throw entraError(400, 'invalid_request', 7000219, `'client_assertion_type' must be ${JWT_BEARER_ASSERTION}.`);
  }
  if (app.revoked) throw entraError(401, 'invalid_client', 7000112, `Application '${clientId}' is disabled.`);
  let protectedHeader: ProtectedHeaderParameters;
  try {
    protectedHeader = decodeProtectedHeader(assertion);
  } catch {
    throw entraError(401, 'invalid_client', 50027, 'JWT token is invalid or malformed.');
  }
  if (protectedHeader.alg !== 'RS256' && protectedHeader.alg !== 'PS256') {
    throw entraError(401, 'invalid_client', 50027, `JWT token is invalid or malformed: unsupported algorithm '${String(protectedHeader.alg)}'.`);
  }
  const thumbprint256 = typeof protectedHeader['x5t#S256'] === 'string' ? protectedHeader['x5t#S256'] : null;
  const thumbprint1 = typeof protectedHeader.x5t === 'string' ? protectedHeader.x5t : null;
  if (!thumbprint256 && !thumbprint1) {
    throw entraError(401, 'invalid_client', 700027, 'Client assertion failed signature validation. [Reason - The assertion header has no x5t#S256 or x5t certificate thumbprint.]');
  }
  const certificate = app.certificates.find(
    (c) => (thumbprint256 !== null && c.thumbprintSha256 === thumbprint256) || (thumbprint1 !== null && c.thumbprintSha1 === thumbprint1),
  );
  if (!certificate) {
    throw entraError(401, 'invalid_client', 700027, `Client assertion failed signature validation. [Reason - The key was not found., Thumbprint of key used by client: '${thumbprint256 ?? thumbprint1}']`);
  }
  const now = Date.now();
  if (certificate.notAfter.getTime() < now || certificate.notBefore.getTime() > now) {
    throw entraError(401, 'invalid_client', 700027, `Client assertion failed signature validation. [Reason - The key used is expired., Thumbprint of key used by client: '${thumbprint256 ?? thumbprint1}']`);
  }
  try {
    await jwtVerify(assertion, certificate.publicKey, {
      algorithms: ['RS256', 'PS256'],
      audience: microsoftAudiences(context, request, app, tenant),
      issuer: clientId,
      subject: clientId,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ['exp', 'jti'],
    });
  } catch (error) {
    throw microsoftAssertionError(error);
  }
  const principal: Principal = {
    provider: 'm365',
    kind: 'application',
    id: app.clientId,
    tenantId: app.tenantId,
    displayName: app.displayName,
    email: null,
    credentialKey: `m365:${app.tenantId}/${app.clientId}`.toLowerCase(),
  };
  const token = state.issueAccessToken(principal, GRAPH_SCOPE, app.clientId);
  return { token_type: 'Bearer', expires_in: state.settings.tokenLifetimeSeconds, access_token: token.token };
}

function microsoftAssertionError(error: unknown): MockHttpError {
  if (error instanceof joseErrors.JWSSignatureVerificationFailed) {
    return entraError(401, 'invalid_client', 700027, 'Client assertion failed signature validation.');
  }
  if (error instanceof joseErrors.JWTExpired) {
    return entraError(401, 'invalid_client', 700024, 'Client assertion is not within its valid time range.');
  }
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    if (error.claim === 'aud') return entraError(401, 'invalid_client', 50013, 'Assertion audience claim does not match the required value.');
    if (error.claim === 'iss' || error.claim === 'sub') {
      return entraError(401, 'invalid_client', 700021, "Client assertion application identifier doesn't match 'client_id' parameter.");
    }
    if (error.claim === 'nbf' || error.claim === 'iat') {
      return entraError(401, 'invalid_client', 700024, 'Client assertion is not within its valid time range.');
    }
    return entraError(401, 'invalid_client', 50027, `JWT token is invalid or malformed: ${error.message}.`);
  }
  return entraError(401, 'invalid_client', 50027, 'JWT token is invalid or malformed.');
}

// Google

function googleAudiences(context: IdentityContext, request: FastifyRequest): string[] {
  const origin = originOf(request, context.publicUrl);
  const hostOrigin = `${request.protocol}://${header(request, 'host') ?? 'localhost'}`;
  return [...new Set([`${origin}/token`, `${hostOrigin}/token`, ...GOOGLE_TOKEN_AUDIENCES])];
}

async function serviceAccountToken(context: IdentityContext, request: FastifyRequest, form: URLSearchParams): Promise<Record<string, unknown>> {
  const { state } = context;
  const assertion = form.get('assertion');
  if (!assertion) throw googleOAuthError(400, 'invalid_request', 'Missing required parameter: assertion');
  let protectedHeader: ProtectedHeaderParameters;
  let claims: JWTPayload;
  try {
    protectedHeader = decodeProtectedHeader(assertion);
    claims = decodeJwt(assertion);
  } catch {
    throw googleOAuthError(400, 'invalid_grant', 'Invalid JWT: the assertion is not a signed JWT.');
  }
  if (typeof claims.iss !== 'string') throw googleOAuthError(400, 'invalid_grant', 'Invalid JWT: missing iss claim.');
  const account = state.serviceAccounts.get(claims.iss.toLowerCase());
  if (!account) throw googleOAuthError(400, 'invalid_grant', 'Invalid grant: account not found');
  if (account.revoked) throw googleOAuthError(400, 'invalid_grant', 'Invalid JWT Signature.');
  if (protectedHeader.alg !== 'RS256') throw googleOAuthError(400, 'invalid_grant', 'Invalid JWT: the algorithm must be RS256.');
  const keys = account.keys.filter((key) => !key.keyId || !protectedHeader.kid || key.keyId === protectedHeader.kid);
  let lastError: unknown = new joseErrors.JWSSignatureVerificationFailed();
  let verified = false;
  for (const key of keys) {
    try {
      await jwtVerify(assertion, key.publicKey, {
        algorithms: ['RS256'],
        audience: googleAudiences(context, request),
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ['iat', 'exp'],
      });
      verified = true;
      break;
    } catch (error) {
      lastError = error;
      if (!(error instanceof joseErrors.JWSSignatureVerificationFailed)) break;
    }
  }
  if (!verified) {
    if (lastError instanceof joseErrors.JWSSignatureVerificationFailed) throw googleOAuthError(400, 'invalid_grant', 'Invalid JWT Signature.');
    if (lastError instanceof joseErrors.JWTClaimValidationFailed && lastError.claim === 'aud') {
      throw googleOAuthError(400, 'invalid_grant', `Invalid JWT: Failed audience check. The expected value was ${GOOGLE_TOKEN_AUDIENCES[0]}`);
    }
    throw googleOAuthError(400, 'invalid_grant', 'Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe. Check your iat and exp values in the JWT claim.');
  }
  if (typeof claims.iat !== 'number' || typeof claims.exp !== 'number' || claims.exp - claims.iat > 3600) {
    throw googleOAuthError(400, 'invalid_grant', 'Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe. Check your iat and exp values in the JWT claim.');
  }
  const scope = typeof claims.scope === 'string' ? claims.scope.trim() : '';
  if (!scope) throw googleOAuthError(400, 'invalid_scope', 'Invalid OAuth scope or ID token audience provided.');
  const subject = typeof claims.sub === 'string' && claims.sub.toLowerCase() !== account.clientEmail.toLowerCase() ? claims.sub : null;
  const principal: Principal = subject
    ? { provider: 'google', kind: 'user', id: subject, tenantId: null, displayName: subject.split('@')[0], email: subject, credentialKey: `sa:${account.clientEmail.toLowerCase()}` }
    : {
        provider: 'google',
        kind: 'service_account',
        id: account.clientEmail,
        tenantId: null,
        displayName: account.displayName,
        email: account.clientEmail,
        credentialKey: `sa:${account.clientEmail.toLowerCase()}`,
      };
  return tokenResponse(state, principal, scope, null);
}

function clientCredentials(request: FastifyRequest, form: URLSearchParams): { clientId: string | null; clientSecret: string | null } {
  const authorization = header(request, 'authorization');
  if (authorization && /^Basic\s+/i.test(authorization)) {
    const decoded = Buffer.from(authorization.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon > 0) {
      // RFC 6749 section 2.3.1: both parts are form-urlencoded before they are joined.
      try {
        return { clientId: decodeURIComponent(decoded.slice(0, colon)), clientSecret: decodeURIComponent(decoded.slice(colon + 1)) };
      } catch {
        throw googleOAuthError(401, 'invalid_client', 'The client credentials in the Authorization header are not valid percent-encoding.');
      }
    }
  }
  return { clientId: form.get('client_id'), clientSecret: form.get('client_secret') };
}

function authenticateClient(state: MockState, request: FastifyRequest, form: URLSearchParams): OAuthClient {
  const { clientId, clientSecret } = clientCredentials(request, form);
  if (!clientId) throw googleOAuthError(400, 'invalid_request', 'Could not determine client ID from request.');
  const client = state.oauthClients.get(clientId);
  if (!client) throw googleOAuthError(401, 'invalid_client', 'The OAuth client was not found.');
  if (client.revoked || clientSecret !== client.clientSecret) throw googleOAuthError(401, 'invalid_client', 'Unauthorized');
  return client;
}

function userPrincipal(account: Account, credentialKey: string): Principal {
  return { provider: 'google', kind: 'user', id: account.email, tenantId: null, displayName: account.displayName, email: account.email, credentialKey };
}

function refreshToken(state: MockState, request: FastifyRequest, form: URLSearchParams): Record<string, unknown> {
  const client = authenticateClient(state, request, form);
  const token = form.get('refresh_token');
  if (!token) throw googleOAuthError(400, 'invalid_request', 'Missing required parameter: refresh_token');
  const record = state.refreshTokens.get(token);
  if (!record || record.revoked || record.clientId !== client.clientId) {
    throw googleOAuthError(400, 'invalid_grant', 'Token has been expired or revoked.');
  }
  return tokenResponse(state, userPrincipal(record.account, `refresh:${token}`), record.scope, client.clientId);
}

function authorizationCode(state: MockState, request: FastifyRequest, form: URLSearchParams): Record<string, unknown> {
  const client = authenticateClient(state, request, form);
  const code = form.get('code');
  if (!code) throw googleOAuthError(400, 'invalid_request', 'Missing required parameter: code');
  const record = state.authCodes.get(code);
  if (!record || record.clientId !== client.clientId || record.expiresAt <= Date.now()) {
    throw googleOAuthError(400, 'invalid_grant', 'Malformed auth code.');
  }
  if (record.used) throw googleOAuthError(400, 'invalid_grant', 'Bad Request');
  if (form.get('redirect_uri') !== record.redirectUri) throw googleOAuthError(400, 'redirect_uri_mismatch', 'Bad Request');
  if (record.codeChallenge) {
    const verifier = form.get('code_verifier');
    if (!verifier) throw googleOAuthError(400, 'invalid_grant', 'Missing code verifier.');
    const computed = record.codeChallengeMethod === 'S256' ? createHash('sha256').update(verifier).digest('base64url') : verifier;
    if (computed !== record.codeChallenge) throw googleOAuthError(400, 'invalid_grant', 'Invalid code verifier.');
  }
  record.used = true;
  const response: Record<string, unknown> = {};
  let credentialKey = `code:${code}`;
  let refresh: string | null = null;
  if (record.offline) {
    refresh = randomToken('1//mock-', 32);
    state.refreshTokens.set(refresh, { token: refresh, clientId: client.clientId, account: record.account, scope: record.scope, revoked: false });
    credentialKey = `refresh:${refresh}`;
  }
  Object.assign(response, tokenResponse(state, userPrincipal(record.account, credentialKey), record.scope, client.clientId));
  if (refresh) response.refresh_token = refresh;
  return response;
}
