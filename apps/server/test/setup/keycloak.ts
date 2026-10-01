// Vitest global setup of the OIDC and SAML suites, enabled with MSCD_TEST_SSO=1 (build plan J.1, J.2, WP-16). It
// starts keycloak/keycloak:26.7.5 once per run (`start-dev --import-realm`) with the realm of the developer stack
// (deploy/compose/dev/keycloak/realm-mscd.json: realm `mscd`, confidential client `mscd`, users rina, bagus, maya,
// hendra and sso.only with fixed ids, `amr` references `pwd` and `otp`), labelled mscd.test=true and named with
// MSCD_TEST_CONTAINER_PREFIX when set, and hands its address and administrator to the test files
// (`inject('mscdKeycloak')`). Without MSCD_TEST_SSO=1 nothing starts and the value is undefined, so the suites skip.
// MSCD_TEST_KEYCLOAK_URL (with MSCD_TEST_KEYCLOAK_ADMIN and MSCD_TEST_KEYCLOAK_ADMIN_PASSWORD) uses a running
// Keycloak with that realm instead, for example the developer stack (`http://localhost:58080`); the administrator
// password is then required.
//
// The file also holds the helpers the suites use against Keycloak: the administrator REST client (users with
// passwords and required actions, client attributes) and a cookie-keeping HTTP client that walks the sign-in pages.
// Keycloak 26 sets `Secure; SameSite=None` sign-in cookies on `localhost` even over HTTP, and the issuer follows the
// request host, so everything uses `localhost` (never 127.0.0.1) and the cookie jar sends Secure cookies to it.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { TestProject } from 'vitest/node';
import { totpAt } from '../../src/modules/identity/totp';

export const KEYCLOAK_IMAGE = 'keycloak/keycloak:26.7.5';
export const KEYCLOAK_REALM = 'mscd';
export const KEYCLOAK_REALM_FILE = path.resolve(__dirname, '../../../../deploy/compose/dev/keycloak/realm-mscd.json');
/** Confidential client of the realm (realm-mscd.json). */
export const KEYCLOAK_CLIENT_ID = 'mscd';

interface RealmFile {
  clients?: { clientId?: string; secret?: string }[];
  users?: { username?: string; credentials?: { type?: string; value?: string }[] }[];
}

/**
 * The development secrets stay only in the realm file (R-11): the client secret of `mscd` and the password of the
 * realm users are read from it when this module loads, so they cannot drift from what Keycloak imports.
 */
function realmSecrets(): { clientSecret: string; userPassword: string } {
  const realm = JSON.parse(readFileSync(KEYCLOAK_REALM_FILE, 'utf8')) as RealmFile;
  const clientSecret = realm.clients?.find((c) => c.clientId === KEYCLOAK_CLIENT_ID)?.secret;
  const userPassword = realm.users?.find((u) => u.username === 'sso.only')?.credentials?.find((c) => c.type === 'password')?.value;
  if (!clientSecret) throw new Error(`No secret of client ${KEYCLOAK_CLIENT_ID} in ${KEYCLOAK_REALM_FILE}`);
  if (!userPassword) throw new Error(`No password of the realm users in ${KEYCLOAK_REALM_FILE}`);
  return { clientSecret, userPassword };
}

const REALM_SECRETS = realmSecrets();
export const KEYCLOAK_CLIENT_SECRET = REALM_SECRETS.clientSecret;
/** Password of every user of the realm file (G.3, WP-02). */
export const KEYCLOAK_USER_PASSWORD = REALM_SECRETS.userPassword;
/** Fixed subjects of the realm users (WP-02 handoff). */
export const KEYCLOAK_SUBJECTS = {
  rina: '00000000-0000-4000-8000-0000000000c1',
  bagus: '00000000-0000-4000-8000-0000000000c2',
  maya: '00000000-0000-4000-8000-0000000000c3',
  hendra: '00000000-0000-4000-8000-0000000000c4',
  'sso.only': '00000000-0000-4000-8000-0000000000d1',
} as const;

/** What the global setup hands to the test files. */
export interface KeycloakTestServer {
  /** `http://localhost:<port>` */
  baseUrl: string;
  /** `http://localhost:<port>/realms/mscd` */
  issuer: string;
  adminUser: string;
  adminPassword: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    mscdKeycloak: KeycloakTestServer | undefined;
  }
}

/** Containers of crashed runs are removed by later runs once this old (R-06, as test/setup/global-db.ts). */
const CONTAINER_LIFETIME_MS = 3 * 60 * 60 * 1000;
const STARTUP_TIMEOUT_MS = 240_000;

let stopContainer: (() => Promise<void>) | undefined;

export async function setup(project: TestProject): Promise<void> {
  project.provide('mscdKeycloak', undefined);
  if (process.env.MSCD_TEST_SSO !== '1') return;
  process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true';

  const external = process.env.MSCD_TEST_KEYCLOAK_URL;
  if (external) {
    const adminPassword = process.env.MSCD_TEST_KEYCLOAK_ADMIN_PASSWORD;
    if (!adminPassword) throw new Error('MSCD_TEST_KEYCLOAK_URL needs MSCD_TEST_KEYCLOAK_ADMIN_PASSWORD (the administrator password of that Keycloak)');
    const baseUrl = localhostUrl(external).replace(/\/+$/, '');
    const server: KeycloakTestServer = {
      baseUrl,
      issuer: `${baseUrl}/realms/${KEYCLOAK_REALM}`,
      adminUser: process.env.MSCD_TEST_KEYCLOAK_ADMIN ?? 'admin',
      adminPassword,
    };
    await waitForRealm(server.issuer, 60_000);
    project.provide('mscdKeycloak', server);
    return;
  }

  const { GenericContainer, Wait } = await import('testcontainers');
  const adminPassword = randomBytes(12).toString('hex');
  let container = new GenericContainer(KEYCLOAK_IMAGE)
    .withCommand(['start-dev', '--import-realm'])
    .withEnvironment({ KC_BOOTSTRAP_ADMIN_USERNAME: 'admin', KC_BOOTSTRAP_ADMIN_PASSWORD: adminPassword, KC_LOG_LEVEL: 'warn' })
    .withCopyFilesToContainer([{ source: KEYCLOAK_REALM_FILE, target: '/opt/keycloak/data/import/realm-mscd.json', mode: 0o644 }])
    .withExposedPorts(8080)
    .withLabels({ 'mscd.test': 'true', 'mscd.test.expires': String(Date.now() + CONTAINER_LIFETIME_MS) })
    .withWaitStrategy(Wait.forHttp(`/realms/${KEYCLOAK_REALM}/.well-known/openid-configuration`, 8080).forStatusCode(200))
    .withStartupTimeout(STARTUP_TIMEOUT_MS);
  const prefix = process.env.MSCD_TEST_CONTAINER_PREFIX;
  if (prefix) container = container.withName(`${prefix}keycloak-${randomBytes(4).toString('hex')}`);
  const started = await container.start();
  stopContainer = async () => {
    await started.stop();
  };
  // The issuer follows the request host; tests and the api must use the same name (WP-02 handoff).
  const host = started.getHost() === '127.0.0.1' ? 'localhost' : started.getHost();
  const baseUrl = `http://${host}:${started.getMappedPort(8080)}`;
  project.provide('mscdKeycloak', { baseUrl, issuer: `${baseUrl}/realms/${KEYCLOAK_REALM}`, adminUser: 'admin', adminPassword });
}

export async function teardown(): Promise<void> {
  await stopContainer?.();
  stopContainer = undefined;
}

function localhostUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.hostname === '127.0.0.1') parsed.hostname = 'localhost';
  return parsed.toString();
}

async function waitForRealm(issuer: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${issuer}/.well-known/openid-configuration`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`Keycloak realm ${issuer} did not answer within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Administrator REST client
// ---------------------------------------------------------------------------------------------------------------

export interface NewKeycloakUser {
  username: string;
  email?: string;
  emailVerified?: boolean;
  firstName?: string;
  lastName?: string;
  password?: string;
  requiredActions?: string[];
}

/** Keycloak administrator API of the test realm (users and client settings). */
export class KeycloakAdmin {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly server: KeycloakTestServer) {}

  /** Creates a user with a password (default the realm password) and returns its id, the token `sub`. */
  async createUser(user: NewKeycloakUser): Promise<string> {
    const response = await this.call('POST', '/users', {
      username: user.username,
      email: user.email,
      emailVerified: user.emailVerified ?? true,
      enabled: true,
      firstName: user.firstName ?? 'Test',
      lastName: user.lastName ?? user.username,
      requiredActions: user.requiredActions ?? [],
      credentials: [{ type: 'password', value: user.password ?? KEYCLOAK_USER_PASSWORD, temporary: false }],
    });
    if (response.status !== 201) throw new Error(`Keycloak user ${user.username} was not created: ${response.status} ${await response.text()}`);
    const location = response.headers.get('location') ?? '';
    const id = location.slice(location.lastIndexOf('/') + 1);
    if (!id) throw new Error('Keycloak returned no user id');
    return id;
  }

  async deleteUser(id: string): Promise<void> {
    await this.call('DELETE', `/users/${encodeURIComponent(id)}`);
  }

  /** Ends every Keycloak session of a user (so the next sign-in shows the login form again). */
  async logoutUser(id: string): Promise<void> {
    await this.call('POST', `/users/${encodeURIComponent(id)}/logout`);
  }

  /**
   * Changes settings of a client of the realm (for example the SAML client `mscd-dev-sp`): `attributes` are merged
   * into the client's attributes, the other members replace the client's. Returns the settings before the change,
   * so a test can restore them.
   */
  async updateClient(clientId: string, changes: { attributes?: Record<string, string> } & Record<string, unknown>): Promise<Record<string, unknown>> {
    const list = (await (await this.call('GET', `/clients?clientId=${encodeURIComponent(clientId)}`)).json()) as { id: string }[];
    const client = list[0] as (Record<string, unknown> & { id: string; attributes?: Record<string, string> }) | undefined;
    if (!client) throw new Error(`Keycloak client ${clientId} not found`);
    const { attributes, ...rest } = changes;
    await this.call('PUT', `/clients/${encodeURIComponent(client.id)}`, { ...client, ...rest, attributes: { ...(client.attributes ?? {}), ...(attributes ?? {}) } });
    return client;
  }

  /**
   * Creates a confidential OpenID Connect client of the realm (redirect URIs `*`) with the given protocol mappers and
   * default client scopes, and returns its internal id for `deleteClient`.
   */
  async createClient(client: { clientId: string; secret: string; protocolMappers?: Record<string, unknown>[]; defaultClientScopes?: string[] }): Promise<string> {
    const response = await this.call('POST', '/clients', {
      clientId: client.clientId,
      protocol: 'openid-connect',
      enabled: true,
      publicClient: false,
      clientAuthenticatorType: 'client-secret',
      secret: client.secret,
      standardFlowEnabled: true,
      directAccessGrantsEnabled: false,
      redirectUris: ['*'],
      webOrigins: ['+'],
      attributes: { 'pkce.code.challenge.method': 'S256' },
      protocolMappers: client.protocolMappers ?? [],
      ...(client.defaultClientScopes ? { defaultClientScopes: client.defaultClientScopes } : {}),
    });
    if (response.status !== 201) throw new Error(`Keycloak client ${client.clientId} was not created: ${response.status} ${await response.text()}`);
    const location = response.headers.get('location') ?? '';
    const id = location.slice(location.lastIndexOf('/') + 1);
    if (!id) throw new Error('Keycloak returned no client id');
    return id;
  }

  async deleteClient(id: string): Promise<void> {
    await this.call('DELETE', `/clients/${encodeURIComponent(id)}`);
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 5_000) return this.token.value;
    const response = await fetch(`${this.server.baseUrl}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: this.server.adminUser, password: this.server.adminPassword }),
    });
    if (!response.ok) throw new Error(`Keycloak administrator sign-in failed: ${response.status}`);
    const body = (await response.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  private async call(method: string, pathInRealm: string, body?: unknown): Promise<Response> {
    const response = await fetch(`${this.server.baseUrl}/admin/realms/${KEYCLOAK_REALM}${pathInRealm}`, {
      method,
      headers: { authorization: `Bearer ${await this.accessToken()}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status >= 400 && !(method === 'POST' && pathInRealm === '/users')) {
      throw new Error(`Keycloak ${method} ${pathInRealm}: ${response.status} ${await response.text()}`);
    }
    return response;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// A browser for the Keycloak pages
// ---------------------------------------------------------------------------------------------------------------

export interface HtmlForm {
  id: string | null;
  action: string;
  /** Hidden and pre-filled inputs of the form. */
  fields: Record<string, string>;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return match ? decodeEntities(match[2] ?? match[3] ?? '') : null;
}

/** The forms of an HTML page with their action and the values of their hidden inputs. */
export function htmlForms(html: string): HtmlForm[] {
  const forms: HtmlForm[] = [];
  for (const match of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const open = match[1] ?? '';
    const inner = match[2] ?? '';
    const fields: Record<string, string> = {};
    for (const input of inner.matchAll(/<input\b[^>]*>/gi)) {
      const tag = input[0];
      const name = attribute(tag, 'name');
      const type = (attribute(tag, 'type') ?? 'text').toLowerCase();
      if (name && type === 'hidden') fields[name] = attribute(tag, 'value') ?? '';
    }
    forms.push({ id: attribute(` ${open}`, 'id'), action: attribute(` ${open}`, 'action') ?? '', fields });
  }
  return forms;
}

/** Text of the error message on a Keycloak page, for test failure messages. */
export function keycloakPageError(html: string): string {
  const match = /<span[^>]*(?:kc-feedback-text|input-error)[^>]*>([\s\S]*?)<\/span>/i.exec(html);
  return match ? decodeEntities(match[1]!.replace(/<[^>]+>/g, '').trim()) : html.slice(0, 300).replace(/\s+/g, ' ');
}

export interface KeycloakResponse {
  status: number;
  location: string | null;
  html: string;
}

/**
 * HTTP client with one cookie jar for the Keycloak host. Redirects are not followed, so a test sees the redirect to
 * the api's callback. Cookies are sent regardless of `Secure` and path, as a browser does for `localhost`.
 */
export class KeycloakBrowser {
  readonly cookies = new Map<string, string>();

  async get(url: string): Promise<KeycloakResponse> {
    return this.send(url, { method: 'GET' });
  }

  async postForm(url: string, fields: Record<string, string>): Promise<KeycloakResponse> {
    return this.send(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
  }

  private async send(url: string, init: { method: string; headers?: Record<string, string>; body?: string }): Promise<KeycloakResponse> {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (this.cookies.size > 0) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const response = await fetch(url, { method: init.method, headers, body: init.body, redirect: 'manual' });
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';');
      const eq = pair!.indexOf('=');
      if (eq <= 0) continue;
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      const expired = attributes.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a) || (/^\s*expires\s*=/i.test(a) && Date.parse(a.split('=').slice(1).join('=')) <= Date.now()));
      if (expired || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const location = response.headers.get('location');
    return { status: response.status, location: location ? new URL(location, url).toString() : null, html: response.status === 200 ? await response.text() : '' };
  }
}

export interface KeycloakSignIn {
  username: string;
  password?: string;
  /**
   * The user's Keycloak TOTP secret, when the realm asks for an OTP code; filled in by the TOTP setup page when the
   * user has the CONFIGURE_TOTP required action.
   */
  totp?: { secret: string | null };
}

/** Where Keycloak sends the browser after the sign-in: a redirect (OIDC) or a form posted to the client (SAML). */
export type KeycloakOutcome = { kind: 'redirect'; url: string } | { kind: 'post'; action: string; fields: Record<string, string> };

/**
 * Walks the Keycloak sign-in from a URL of the realm (an OIDC authorisation URL, or the SAML HTTP-Redirect URL): the
 * login form, then the OTP form or the TOTP setup page when they appear, until Keycloak hands the browser back to the
 * client, by a redirect (OIDC: the api callback with `code` and `state`, or `error`) or by the auto-submitted form of
 * the SAML HTTP-POST binding (`SAMLResponse`, `RelayState`). Throws with the page's message when Keycloak shows the
 * login form again.
 */
export async function keycloakSignIn(browser: KeycloakBrowser, url: string, user: KeycloakSignIn): Promise<KeycloakOutcome> {
  const origin = new URL(url).origin;
  let response = await browser.get(url);
  let loginPosted = false;
  for (let step = 0; step < 10; step += 1) {
    if (response.status >= 300 && response.status < 400 && response.location) {
      if (new URL(response.location).origin !== origin) return { kind: 'redirect', url: response.location };
      response = await browser.get(response.location);
      continue;
    }
    if (response.status !== 200) throw new Error(`Keycloak answered ${response.status} during sign-in`);
    const forms = htmlForms(response.html);
    const login = forms.find((f) => f.id === 'kc-form-login');
    const otp = forms.find((f) => f.id === 'kc-otp-login-form');
    const totpSetup = forms.find((f) => f.id === 'kc-totp-settings-form');
    const handBack = forms.find((f) => f.action !== '' && new URL(f.action, origin).origin !== origin);
    if (login) {
      if (loginPosted) throw new Error(`Keycloak refused the sign-in of ${user.username}: ${keycloakPageError(response.html)}`);
      loginPosted = true;
      response = await browser.postForm(login.action, { ...login.fields, username: user.username, password: user.password ?? KEYCLOAK_USER_PASSWORD });
    } else if (totpSetup) {
      const secret = totpSetup.fields.totpSecret;
      if (!secret || !user.totp) throw new Error(`Keycloak asks ${user.username} to set up an authenticator`);
      user.totp.secret = secret;
      response = await browser.postForm(totpSetup.action, { ...totpSetup.fields, totp: keycloakTotp(secret, 0), userLabel: 'MSCD test' });
    } else if (otp) {
      if (!user.totp?.secret) throw new Error(`Keycloak asks ${user.username} for an OTP code`);
      // The next step: the setup or an earlier sign-in may have used the current one (codes are single use).
      response = await browser.postForm(otp.action, { ...otp.fields, otp: keycloakTotp(user.totp.secret, 1) });
    } else if (handBack) {
      return { kind: 'post', action: new URL(handBack.action, origin).toString(), fields: handBack.fields };
    } else {
      throw new Error(`Unexpected Keycloak page: ${keycloakPageError(response.html)}`);
    }
  }
  throw new Error('Keycloak sign-in did not finish in 10 steps');
}

/** `keycloakSignIn` for OIDC: returns the URL of the redirect back to the client. */
export async function signInAtKeycloak(browser: KeycloakBrowser, authorizationUrl: string, user: KeycloakSignIn): Promise<string> {
  const outcome = await keycloakSignIn(browser, authorizationUrl, user);
  if (outcome.kind !== 'redirect') throw new Error(`Keycloak posted a form to ${outcome.action} instead of redirecting`);
  return outcome.url;
}

/** A TOTP code of a Keycloak secret (HMAC-SHA1 over the secret's UTF-8 bytes, 6 digits, 30 seconds). */
export function keycloakTotp(secret: string, offsetSteps = 0): string {
  return totpAt(Buffer.from(secret, 'utf8'), Date.now() + offsetSteps * 30_000);
}
