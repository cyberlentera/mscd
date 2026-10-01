import { createPublicKey } from 'node:crypto';
import { inspectCertificate } from './certs.js';
import { mimeTypeFromName } from './content.js';
import {
  isDriveId,
  isGraphId,
  isGraphVersionId,
  isTenant,
  stableDriveFileId,
  stableGraphItemId,
} from './ids.js';
import {
  type DriveState,
  type GoogleDriveKind,
  type ItemState,
  type M365DriveType,
  type MockSettings,
  type MockState,
  type NewVersionInput,
  type Person,
  type Provider,
  SYSTEM_PERSON,
} from './state.js';

// Fixture documents (format version 1). A fixture describes the provider state the mock starts from: credentials
// the token endpoints trust, Microsoft 365 drives and Google drives with their folders, files and versions. The
// CLI loads one with `--fixtures <file>` (or `--fixtures demo` for fixtures/demo.json), `POST /_admin/reset`
// restores it, and `POST /_admin/fixtures` merges another document into the running state. The format is
// documented in README.md; `parseFixtureDocument` rejects unknown keys so a typo fails loudly.

export interface PersonFixture {
  displayName: string;
  email?: string;
}

export interface VersionFixture {
  /** Graph version id ("1.0", "2.0", ...) or Drive revision id. Default: the provider's next id. */
  id?: string;
  modifiedAt?: string;
  modifiedBy?: PersonFixture;
  /** UTF-8 content. */
  content?: string;
  contentBase64?: string;
  /** Size of the synthesized content when no content is given (default 1024). */
  size?: number;
  /** Hash values reported by the provider; computed from the content when absent. */
  quickXorHash?: string;
  sha256?: string;
  md5?: string;
  keepForever?: boolean;
}

export interface FileFixture {
  id?: string;
  name: string;
  /** Folder path from the drive root, segments separated by "/" ("" or absent is the root). */
  path?: string;
  /** Alternative to `path`: id of the parent folder. */
  parentId?: string;
  mimeType?: string;
  description?: string;
  createdAt?: string;
  createdBy?: PersonFixture;
  trashed?: boolean;
  /** Versions, oldest first; the last one is current. Without `versions`, the fields below form one version. */
  versions?: VersionFixture[];
  versionId?: string;
  modifiedAt?: string;
  modifiedBy?: PersonFixture;
  content?: string;
  contentBase64?: string;
  size?: number;
  quickXorHash?: string;
  sha256?: string;
  md5?: string;
}

export interface FolderFixture {
  id?: string;
  path: string;
  description?: string;
  createdAt?: string;
  createdBy?: PersonFixture;
}

interface DriveFixtureBase {
  id: string;
  name?: string;
  createdAt?: string;
  owner?: PersonFixture;
  forbidden?: boolean;
  allowedPrincipals?: string[];
  folders?: FolderFixture[];
  items?: FileFixture[];
}

export interface M365DriveFixture extends DriveFixtureBase {
  driveType?: M365DriveType;
  rootId?: string;
  webUrl?: string;
  tenantId?: string;
}

export interface GoogleDriveFixture extends DriveFixtureBase {
  kind?: GoogleDriveKind;
  /** My Drive only: id of the root folder (a shared drive's root folder id is the drive id). */
  rootId?: string;
}

export interface M365CertificateCredential {
  kind: 'm365_certificate';
  tenantId: string;
  clientId: string;
  certificatePem: string;
  displayName?: string;
  /** Other names of the tenant accepted in the token URL, such as "contoso.onmicrosoft.com". */
  tenantAliases?: string[];
}

export interface GoogleServiceAccountCredential {
  kind: 'google_service_account';
  clientEmail: string;
  publicKeyPem?: string;
  certificatePem?: string;
  /** When set, the assertion header `kid` must equal it. */
  privateKeyId?: string;
  displayName?: string;
}

export interface GoogleOAuthClientCredential {
  kind: 'google_oauth_client';
  clientId: string;
  clientSecret: string;
  redirectUris?: string[];
  /** Account that the authorization endpoint signs in when the request has no `login_hint`. */
  defaultAccount?: { email: string; displayName?: string };
}

export interface GoogleRefreshTokenCredential {
  kind: 'google_refresh_token';
  clientId: string;
  refreshToken: string;
  account: { email: string; displayName?: string };
  scope?: string;
  /** A revoked or expired refresh token: the token endpoint answers `invalid_grant`. */
  revoked?: boolean;
}

export type CredentialFixture =
  | M365CertificateCredential
  | GoogleServiceAccountCredential
  | GoogleOAuthClientCredential
  | GoogleRefreshTokenCredential;

export interface FixtureDocument {
  version?: 1;
  description?: string;
  settings?: Partial<MockSettings>;
  credentials?: CredentialFixture[];
  m365?: { drives?: M365DriveFixture[] };
  google?: { drives?: GoogleDriveFixture[] };
}

export class FixtureError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid fixtures: ${problems.join('; ')}`);
    this.name = 'FixtureError';
  }
}

const MAX_CONTENT_BYTES = 256 * 1024 * 1024;
const M365_FORBIDDEN_NAME = /["*:<>?/\\|]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const QUICK_XOR = /^[A-Za-z0-9+/]{27}=$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MD5_HEX = /^[0-9a-f]{32}$/;

type Json = Record<string, unknown>;

class Checker {
  readonly problems: string[] = [];

  fail(path: string, message: string): void {
    this.problems.push(`${path}: ${message}`);
  }

  object(value: unknown, path: string, allowed: readonly string[]): Json | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.fail(path, 'must be an object');
      return undefined;
    }
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) this.fail(`${path}.${key}`, 'is not a known key');
    }
    return value as Json;
  }

  array(value: unknown, path: string): unknown[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      this.fail(path, 'must be an array');
      return [];
    }
    return value;
  }

  string(
    obj: Json,
    key: string,
    path: string,
    options: { required?: boolean; test?: (v: string) => boolean; hint?: string; allowEmpty?: boolean } = {},
  ): string | undefined {
    const value = obj[key];
    if (value === undefined) {
      if (options.required) this.fail(`${path}.${key}`, 'is required');
      return undefined;
    }
    if (typeof value !== 'string' || (!options.allowEmpty && value.length === 0)) {
      this.fail(`${path}.${key}`, 'must be a non-empty string');
      return undefined;
    }
    if (options.test && !options.test(value)) {
      this.fail(`${path}.${key}`, options.hint ?? 'has an invalid value');
      return undefined;
    }
    return value;
  }

  boolean(obj: Json, key: string, path: string): boolean | undefined {
    const value = obj[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') {
      this.fail(`${path}.${key}`, 'must be true or false');
      return undefined;
    }
    return value;
  }

  integer(obj: Json, key: string, path: string, min: number, max: number): number | undefined {
    const value = obj[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      this.fail(`${path}.${key}`, `must be an integer from ${min} to ${max}`);
      return undefined;
    }
    return value;
  }

  date(obj: Json, key: string, path: string): string | undefined {
    return this.string(obj, key, path, {
      test: (v) => /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v)),
      hint: 'must be an ISO 8601 date-time such as 2026-09-28T02:00:00Z',
    });
  }

  stringList(obj: Json, key: string, path: string): string[] | undefined {
    const value = obj[key];
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.length === 0)) {
      this.fail(`${path}.${key}`, 'must be an array of non-empty strings');
      return undefined;
    }
    return value as string[];
  }

  person(obj: Json, key: string, path: string): PersonFixture | undefined {
    if (obj[key] === undefined) return undefined;
    const person = this.object(obj[key], `${path}.${key}`, ['displayName', 'email']);
    if (!person) return undefined;
    const displayName = this.string(person, 'displayName', `${path}.${key}`, { required: true });
    const email = this.string(person, 'email', `${path}.${key}`, { test: (v) => EMAIL.test(v), hint: 'must be an email address' });
    if (displayName === undefined) return undefined;
    return email ? { displayName, email } : { displayName };
  }
}

const isName = (provider: Provider) => (value: string) =>
  value !== '.' &&
  value !== '..' &&
  value.trim().length > 0 &&
  value.length <= 255 &&
  !CONTROL_CHARACTERS.test(value) &&
  !(provider === 'm365' ? M365_FORBIDDEN_NAME : /\//).test(value);

const idTest = (provider: Provider) => (provider === 'm365' ? isGraphId : isDriveId);

function pathSegments(path: string): string[] {
  return path === '' ? [] : path.split('/');
}

const VERSION_KEYS = ['id', 'modifiedAt', 'modifiedBy', 'content', 'contentBase64', 'size', 'quickXorHash', 'sha256', 'md5', 'keepForever'] as const;
const FILE_KEYS = [
  'id', 'name', 'path', 'parentId', 'mimeType', 'description', 'createdAt', 'createdBy', 'trashed', 'versions',
  'versionId', 'modifiedAt', 'modifiedBy', 'content', 'contentBase64', 'size', 'quickXorHash', 'sha256', 'md5',
] as const;

function checkVersionFields(check: Checker, obj: Json, path: string, provider: Provider, idKey = 'id'): VersionFixture {
  const version: VersionFixture = {};
  const id = check.string(obj, idKey, path, {
    test: provider === 'm365' ? isGraphVersionId : isDriveId,
    hint: provider === 'm365' ? 'must match [A-Za-z0-9._-]+' : 'must match [A-Za-z0-9_-]+',
  });
  if (id !== undefined) version.id = id;
  const modifiedAt = check.date(obj, 'modifiedAt', path);
  if (modifiedAt !== undefined) version.modifiedAt = modifiedAt;
  const modifiedBy = check.person(obj, 'modifiedBy', path);
  if (modifiedBy) version.modifiedBy = modifiedBy;
  const content = check.string(obj, 'content', path, { allowEmpty: true });
  const contentBase64 = check.string(obj, 'contentBase64', path, {
    allowEmpty: true,
    test: (v) => BASE64.test(v) && v.length % 4 === 0,
    hint: 'must be standard base64',
  });
  if (content !== undefined && contentBase64 !== undefined) check.fail(path, 'give content or contentBase64, not both');
  if (content !== undefined) version.content = content;
  if (contentBase64 !== undefined) version.contentBase64 = contentBase64;
  const size = check.integer(obj, 'size', path, 0, MAX_CONTENT_BYTES);
  if (size !== undefined) {
    const actual = content !== undefined ? Buffer.byteLength(content) : contentBase64 !== undefined ? Buffer.from(contentBase64, 'base64').length : size;
    if (actual !== size) check.fail(`${path}.size`, `is ${size} but the content has ${actual} bytes`);
    version.size = size;
  }
  const quickXorHash = check.string(obj, 'quickXorHash', path, { test: (v) => QUICK_XOR.test(v), hint: 'must be 20 bytes in base64 (28 characters)' });
  if (quickXorHash !== undefined) version.quickXorHash = quickXorHash;
  const sha256 = check.string(obj, 'sha256', path, { test: (v) => SHA256_HEX.test(v), hint: 'must be 64 lower-case hex characters' });
  if (sha256 !== undefined) version.sha256 = sha256;
  const md5 = check.string(obj, 'md5', path, { test: (v) => MD5_HEX.test(v), hint: 'must be 32 lower-case hex characters' });
  if (md5 !== undefined) version.md5 = md5;
  return version;
}

function checkFile(check: Checker, value: unknown, path: string, provider: Provider): FileFixture | undefined {
  const obj = check.object(value, path, FILE_KEYS);
  if (!obj) return undefined;
  const name = check.string(obj, 'name', path, { required: true, test: isName(provider), hint: 'is not a valid file name' });
  const file: FileFixture = { name: name ?? '' };
  const id = check.string(obj, 'id', path, { test: idTest(provider), hint: 'does not match the id pattern of D.5' });
  if (id) file.id = id;
  const folderPath = checkFolderPath(check, obj, 'path', path, provider, true);
  if (folderPath !== undefined) file.path = folderPath;
  const parentId = check.string(obj, 'parentId', path, { test: idTest(provider), hint: 'does not match the id pattern of D.5' });
  if (parentId) file.parentId = parentId;
  if (obj.path !== undefined && obj.parentId !== undefined) check.fail(path, 'give path or parentId, not both');
  const mimeType = check.string(obj, 'mimeType', path, { test: (v) => /^[\w.+-]+\/[\w.+-]+$/.test(v), hint: 'must be a MIME type' });
  if (mimeType) file.mimeType = mimeType;
  const description = check.string(obj, 'description', path, { allowEmpty: true });
  if (description !== undefined) file.description = description;
  const createdAt = check.date(obj, 'createdAt', path);
  if (createdAt) file.createdAt = createdAt;
  const createdBy = check.person(obj, 'createdBy', path);
  if (createdBy) file.createdBy = createdBy;
  const trashed = check.boolean(obj, 'trashed', path);
  if (trashed !== undefined) file.trashed = trashed;
  if (obj.versions !== undefined) {
    const shorthand = ['versionId', 'modifiedAt', 'modifiedBy', 'content', 'contentBase64', 'size', 'quickXorHash', 'sha256', 'md5'].filter((k) => obj[k] !== undefined);
    if (shorthand.length > 0) check.fail(path, `with versions, move ${shorthand.join(', ')} into a version`);
    const versions = check.array(obj.versions, `${path}.versions`);
    if (versions.length === 0) check.fail(`${path}.versions`, 'must list at least one version');
    file.versions = [];
    versions.forEach((entry, index) => {
      const vPath = `${path}.versions[${index}]`;
      const vObj = check.object(entry, vPath, VERSION_KEYS);
      if (!vObj) return;
      const version = checkVersionFields(check, vObj, vPath, provider);
      const keepForever = check.boolean(vObj, 'keepForever', vPath);
      if (keepForever !== undefined) version.keepForever = keepForever;
      file.versions?.push(version);
    });
    const ids = file.versions.map((v) => v.id).filter(Boolean);
    if (new Set(ids).size !== ids.length) check.fail(`${path}.versions`, 'version ids must be unique');
  } else {
    const { id: versionId, ...single } = checkVersionFields(check, obj, path, provider, 'versionId');
    Object.assign(file, single);
    if (versionId !== undefined) file.versionId = versionId;
  }
  return file;
}

function checkFolderPath(check: Checker, obj: Json, key: string, path: string, provider: Provider, allowRoot: boolean): string | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || (!allowRoot && value === '')) {
    check.fail(`${path}.${key}`, allowRoot ? 'must be a string' : 'must be a non-empty string');
    return undefined;
  }
  const normalised = value.replace(/^\/+|\/+$/g, '');
  if (!allowRoot && normalised === '') {
    check.fail(`${path}.${key}`, 'must name a folder below the root');
    return undefined;
  }
  for (const segment of pathSegments(normalised)) {
    if (!isName(provider)(segment) || segment.includes('/')) {
      check.fail(`${path}.${key}`, `has an invalid folder name "${segment}"`);
      return undefined;
    }
  }
  return normalised;
}

function checkDrive(check: Checker, value: unknown, path: string, provider: Provider): M365DriveFixture | GoogleDriveFixture | undefined {
  const common = ['id', 'name', 'createdAt', 'owner', 'forbidden', 'allowedPrincipals', 'folders', 'items'];
  const allowed = provider === 'm365' ? [...common, 'driveType', 'rootId', 'webUrl', 'tenantId'] : [...common, 'kind', 'rootId'];
  const obj = check.object(value, path, allowed);
  if (!obj) return undefined;
  const id = check.string(obj, 'id', path, { required: true, test: idTest(provider), hint: 'does not match the id pattern of D.5' });
  const drive: M365DriveFixture & GoogleDriveFixture = { id: id ?? '' };
  const name = check.string(obj, 'name', path);
  if (name) drive.name = name;
  const createdAt = check.date(obj, 'createdAt', path);
  if (createdAt) drive.createdAt = createdAt;
  const owner = check.person(obj, 'owner', path);
  if (owner) drive.owner = owner;
  const forbidden = check.boolean(obj, 'forbidden', path);
  if (forbidden !== undefined) drive.forbidden = forbidden;
  const allowedPrincipals = check.stringList(obj, 'allowedPrincipals', path);
  if (allowedPrincipals) drive.allowedPrincipals = allowedPrincipals;
  const rootId = check.string(obj, 'rootId', path, { test: idTest(provider), hint: 'does not match the id pattern of D.5' });
  if (rootId) drive.rootId = rootId;
  if (provider === 'm365') {
    const driveType = check.string(obj, 'driveType', path, {
      test: (v) => ['documentLibrary', 'business', 'personal'].includes(v),
      hint: 'must be documentLibrary, business or personal',
    });
    if (driveType) drive.driveType = driveType as M365DriveType;
    const webUrl = check.string(obj, 'webUrl', path, { test: (v) => URL.canParse(v), hint: 'must be an absolute URL' });
    if (webUrl) drive.webUrl = webUrl.replace(/\/+$/, '');
    const tenantId = check.string(obj, 'tenantId', path, { test: isTenant, hint: 'must be a tenant id or domain' });
    if (tenantId) drive.tenantId = tenantId;
  } else {
    const kind = check.string(obj, 'kind', path, { test: (v) => v === 'shared_drive' || v === 'my_drive', hint: 'must be shared_drive or my_drive' });
    if (kind) drive.kind = kind as GoogleDriveKind;
    if (drive.rootId && drive.kind !== 'my_drive') check.fail(`${path}.rootId`, 'applies to my_drive only (a shared drive root id is the drive id)');
  }
  drive.folders = [];
  check.array(obj.folders, `${path}.folders`).forEach((entry, index) => {
    const fPath = `${path}.folders[${index}]`;
    const fObj = check.object(entry, fPath, ['id', 'path', 'description', 'createdAt', 'createdBy']);
    if (!fObj) return;
    const folderPath = checkFolderPath(check, fObj, 'path', fPath, provider, false);
    if (fObj.path === undefined) check.fail(`${fPath}.path`, 'is required');
    const folder: FolderFixture = { path: folderPath ?? '' };
    const folderId = check.string(fObj, 'id', fPath, { test: idTest(provider), hint: 'does not match the id pattern of D.5' });
    if (folderId) folder.id = folderId;
    const description = check.string(fObj, 'description', fPath, { allowEmpty: true });
    if (description !== undefined) folder.description = description;
    const folderCreatedAt = check.date(fObj, 'createdAt', fPath);
    if (folderCreatedAt) folder.createdAt = folderCreatedAt;
    const createdBy = check.person(fObj, 'createdBy', fPath);
    if (createdBy) folder.createdBy = createdBy;
    drive.folders?.push(folder);
  });
  drive.items = [];
  check.array(obj.items, `${path}.items`).forEach((entry, index) => {
    const file = checkFile(check, entry, `${path}.items[${index}]`, provider);
    if (file) drive.items?.push(file);
  });
  return drive;
}

function checkCredential(check: Checker, value: unknown, path: string): CredentialFixture | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    check.fail(path, 'must be an object');
    return undefined;
  }
  const kind = (value as Json).kind;
  switch (kind) {
    case 'm365_certificate': {
      const obj = check.object(value, path, ['kind', 'tenantId', 'clientId', 'certificatePem', 'displayName', 'tenantAliases']);
      if (!obj) return undefined;
      const tenantId = check.string(obj, 'tenantId', path, { required: true, test: isTenant, hint: 'must be a tenant id or domain' });
      const clientId = check.string(obj, 'clientId', path, { required: true, test: (v) => /^[A-Za-z0-9._-]{1,128}$/.test(v), hint: 'must be an application (client) id' });
      const certificatePem = check.string(obj, 'certificatePem', path, { required: true });
      if (certificatePem) {
        try {
          inspectCertificate(certificatePem);
        } catch (error) {
          check.fail(`${path}.certificatePem`, `is not an X.509 certificate (${(error as Error).message})`);
        }
      }
      const displayName = check.string(obj, 'displayName', path);
      const tenantAliases = check.stringList(obj, 'tenantAliases', path);
      if (tenantAliases?.some((alias) => !isTenant(alias))) check.fail(`${path}.tenantAliases`, 'must hold tenant ids or domains');
      if (!tenantId || !clientId || !certificatePem) return undefined;
      return { kind, tenantId, clientId, certificatePem, ...(displayName ? { displayName } : {}), ...(tenantAliases ? { tenantAliases } : {}) };
    }
    case 'google_service_account': {
      const obj = check.object(value, path, ['kind', 'clientEmail', 'publicKeyPem', 'certificatePem', 'privateKeyId', 'displayName']);
      if (!obj) return undefined;
      const clientEmail = check.string(obj, 'clientEmail', path, { required: true, test: (v) => EMAIL.test(v), hint: 'must be an email address' });
      const publicKeyPem = check.string(obj, 'publicKeyPem', path);
      const certificatePem = check.string(obj, 'certificatePem', path);
      if ((publicKeyPem === undefined) === (certificatePem === undefined)) check.fail(path, 'give exactly one of publicKeyPem and certificatePem');
      const pem = publicKeyPem ?? certificatePem;
      if (pem) {
        try {
          createPublicKey(pem);
        } catch (error) {
          check.fail(`${path}.${publicKeyPem ? 'publicKeyPem' : 'certificatePem'}`, `is not a public key or certificate (${(error as Error).message})`);
        }
      }
      const privateKeyId = check.string(obj, 'privateKeyId', path);
      const displayName = check.string(obj, 'displayName', path);
      if (!clientEmail || !pem) return undefined;
      return {
        kind,
        clientEmail,
        ...(publicKeyPem ? { publicKeyPem } : {}),
        ...(certificatePem ? { certificatePem } : {}),
        ...(privateKeyId ? { privateKeyId } : {}),
        ...(displayName ? { displayName } : {}),
      };
    }
    case 'google_oauth_client': {
      const obj = check.object(value, path, ['kind', 'clientId', 'clientSecret', 'redirectUris', 'defaultAccount']);
      if (!obj) return undefined;
      const clientId = check.string(obj, 'clientId', path, { required: true });
      const clientSecret = check.string(obj, 'clientSecret', path, { required: true });
      const redirectUris = check.stringList(obj, 'redirectUris', path);
      if (redirectUris?.some((uri) => !URL.canParse(uri))) check.fail(`${path}.redirectUris`, 'must hold absolute URLs');
      const account = checkAccount(check, obj, 'defaultAccount', path, false);
      if (!clientId || !clientSecret) return undefined;
      return { kind, clientId, clientSecret, ...(redirectUris ? { redirectUris } : {}), ...(account ? { defaultAccount: account } : {}) };
    }
    case 'google_refresh_token': {
      const obj = check.object(value, path, ['kind', 'clientId', 'refreshToken', 'account', 'scope', 'revoked']);
      if (!obj) return undefined;
      const clientId = check.string(obj, 'clientId', path, { required: true });
      const refreshToken = check.string(obj, 'refreshToken', path, { required: true });
      const account = checkAccount(check, obj, 'account', path, true);
      const scope = check.string(obj, 'scope', path);
      const revoked = check.boolean(obj, 'revoked', path);
      if (!clientId || !refreshToken || !account) return undefined;
      return { kind, clientId, refreshToken, account, ...(scope ? { scope } : {}), ...(revoked !== undefined ? { revoked } : {}) };
    }
    default:
      check.fail(`${path}.kind`, 'must be m365_certificate, google_service_account, google_oauth_client or google_refresh_token');
      return undefined;
  }
}

function checkAccount(check: Checker, obj: Json, key: string, path: string, required: boolean): { email: string; displayName?: string } | undefined {
  if (obj[key] === undefined) {
    if (required) check.fail(`${path}.${key}`, 'is required');
    return undefined;
  }
  const account = check.object(obj[key], `${path}.${key}`, ['email', 'displayName']);
  if (!account) return undefined;
  const email = check.string(account, 'email', `${path}.${key}`, { required: true, test: (v) => EMAIL.test(v), hint: 'must be an email address' });
  const displayName = check.string(account, 'displayName', `${path}.${key}`);
  if (!email) return undefined;
  return displayName ? { email, displayName } : { email };
}

const SETTING_LIMITS: Record<keyof MockSettings, [number, number]> = {
  tokenLifetimeSeconds: [1, 86400],
  graphSimpleUploadMaxBytes: [1, MAX_CONTENT_BYTES],
  copyPendingPolls: [0, 100],
  graphPageSize: [1, 1000],
  drivePageSize: [1, 1000],
};

function checkSettings(check: Checker, value: unknown, path: string): Partial<MockSettings> {
  const obj = check.object(value, path, Object.keys(SETTING_LIMITS));
  const settings: Partial<MockSettings> = {};
  if (obj) {
    for (const [key, [min, max]] of Object.entries(SETTING_LIMITS) as [keyof MockSettings, [number, number]][]) {
      const parsed = check.integer(obj, key, path, min, max);
      if (parsed !== undefined) settings[key] = parsed;
    }
  }
  return settings;
}

/** Validates a settings object (`POST /_admin/settings`); throws `FixtureError` listing every problem. */
export function parseSettings(value: unknown): Partial<MockSettings> {
  const check = new Checker();
  const settings = checkSettings(check, value, 'settings');
  if (check.problems.length > 0) throw new FixtureError(check.problems);
  return settings;
}

/** Validates an untrusted fixture document; throws `FixtureError` listing every problem. */
export function parseFixtureDocument(input: unknown): FixtureDocument {
  const check = new Checker();
  const obj = check.object(input, 'fixtures', ['$schema', 'version', 'description', 'settings', 'credentials', 'm365', 'google']);
  if (!obj) throw new FixtureError(check.problems);
  const doc: FixtureDocument = {};
  if (obj.version !== undefined && obj.version !== 1) check.fail('fixtures.version', 'must be 1');
  if (obj.version === 1) doc.version = 1;
  const description = check.string(obj, 'description', 'fixtures', { allowEmpty: true });
  if (description !== undefined) doc.description = description;
  if (obj.settings !== undefined) doc.settings = checkSettings(check, obj.settings, 'fixtures.settings');
  doc.credentials = [];
  check.array(obj.credentials, 'fixtures.credentials').forEach((entry, index) => {
    const credential = checkCredential(check, entry, `fixtures.credentials[${index}]`);
    if (credential) doc.credentials?.push(credential);
  });
  for (const provider of ['m365', 'google'] as const) {
    if (obj[provider] === undefined) continue;
    const section = check.object(obj[provider], `fixtures.${provider}`, ['drives']);
    if (!section) continue;
    const drives: (M365DriveFixture | GoogleDriveFixture)[] = [];
    check.array(section.drives, `fixtures.${provider}.drives`).forEach((entry, index) => {
      const drive = checkDrive(check, entry, `fixtures.${provider}.drives[${index}]`, provider);
      if (drive) drives.push(drive);
    });
    if (provider === 'm365') doc.m365 = { drives: drives as M365DriveFixture[] };
    else doc.google = { drives: drives as GoogleDriveFixture[] };
  }
  if (check.problems.length > 0) throw new FixtureError(check.problems);
  return doc;
}

export interface CredentialSummary {
  kind: CredentialFixture['kind'];
  id: string;
  thumbprintSha256?: string;
  thumbprintSha1?: string;
  keyId?: string | null;
}

/** Registers (or adds a key to) a credential the token endpoints trust. Re-registering clears a revocation. */
export function registerCredential(state: MockState, credential: CredentialFixture): CredentialSummary {
  switch (credential.kind) {
    case 'm365_certificate': {
      const info = inspectCertificate(credential.certificatePem);
      let app = state.findApp(credential.tenantId, credential.clientId);
      if (!app) {
        app = { tenantId: credential.tenantId, tenantAliases: [], clientId: credential.clientId, displayName: credential.clientId, certificates: [], revoked: false };
        state.apps.set(state.appKey(credential.tenantId, credential.clientId), app);
      }
      if (credential.displayName) app.displayName = credential.displayName;
      for (const alias of credential.tenantAliases ?? []) if (!app.tenantAliases.includes(alias)) app.tenantAliases.push(alias);
      if (!app.certificates.some((c) => c.thumbprintSha256 === info.thumbprintSha256)) {
        app.certificates.push({
          pem: credential.certificatePem,
          thumbprintSha256: info.thumbprintSha256,
          thumbprintSha1: info.thumbprintSha1,
          publicKey: info.publicKey,
          notBefore: info.notBefore,
          notAfter: info.notAfter,
        });
      }
      app.revoked = false;
      return { kind: credential.kind, id: `${app.tenantId}/${app.clientId}`, thumbprintSha256: info.thumbprintSha256, thumbprintSha1: info.thumbprintSha1 };
    }
    case 'google_service_account': {
      const key = createPublicKey((credential.publicKeyPem ?? credential.certificatePem) as string);
      const email = credential.clientEmail.toLowerCase();
      let account = state.serviceAccounts.get(email);
      if (!account) {
        account = { clientEmail: credential.clientEmail, displayName: credential.clientEmail.split('@')[0], keys: [], revoked: false };
        state.serviceAccounts.set(email, account);
      }
      if (credential.displayName) account.displayName = credential.displayName;
      account.keys.push({ keyId: credential.privateKeyId ?? null, publicKey: key });
      account.revoked = false;
      return { kind: credential.kind, id: credential.clientEmail, keyId: credential.privateKeyId ?? null };
    }
    case 'google_oauth_client': {
      state.oauthClients.set(credential.clientId, {
        clientId: credential.clientId,
        clientSecret: credential.clientSecret,
        redirectUris: credential.redirectUris ?? null,
        defaultAccount: credential.defaultAccount
          ? { email: credential.defaultAccount.email, displayName: credential.defaultAccount.displayName ?? credential.defaultAccount.email }
          : null,
        revoked: false,
      });
      return { kind: credential.kind, id: credential.clientId };
    }
    case 'google_refresh_token': {
      state.refreshTokens.set(credential.refreshToken, {
        token: credential.refreshToken,
        clientId: credential.clientId,
        account: { email: credential.account.email, displayName: credential.account.displayName ?? credential.account.email },
        scope: credential.scope ?? 'https://www.googleapis.com/auth/drive.file',
        revoked: credential.revoked ?? false,
      });
      return { kind: credential.kind, id: `${credential.clientId}/${credential.account.email}` };
    }
  }
}

export function toPerson(person: PersonFixture | undefined): Person | undefined {
  if (!person) return undefined;
  return person.email ? { displayName: person.displayName, email: person.email } : { displayName: person.displayName };
}

function versionInput(version: VersionFixture): NewVersionInput {
  const input: NewVersionInput = {};
  if (version.id !== undefined) input.id = version.id;
  if (version.modifiedAt !== undefined) input.modifiedAt = new Date(version.modifiedAt).toISOString();
  const modifiedBy = toPerson(version.modifiedBy);
  if (modifiedBy) input.modifiedBy = modifiedBy;
  if (version.content !== undefined) input.content = Buffer.from(version.content, 'utf8');
  if (version.contentBase64 !== undefined) input.content = Buffer.from(version.contentBase64, 'base64');
  if (version.size !== undefined) input.size = version.size;
  if (version.quickXorHash !== undefined) input.quickXorHash = version.quickXorHash;
  if (version.sha256 !== undefined) input.sha256 = version.sha256;
  if (version.md5 !== undefined) input.md5 = version.md5;
  if (version.keepForever !== undefined) input.keepForever = version.keepForever;
  return input;
}

function defaultDriveName(fixture: M365DriveFixture | GoogleDriveFixture, provider: Provider): string {
  if (fixture.name) return fixture.name;
  if (provider === 'm365') return (fixture as M365DriveFixture).driveType === 'personal' ? 'OneDrive' : 'Documents';
  return (fixture as GoogleDriveFixture).kind === 'my_drive' ? 'My Drive' : fixture.id;
}

function defaultWebUrl(fixture: M365DriveFixture, name: string): string {
  if (fixture.webUrl) return fixture.webUrl;
  if (fixture.driveType === 'personal') {
    const owner = (fixture.owner?.email ?? fixture.id).toLowerCase().replace(/[^a-z0-9]/g, '_');
    return `https://mock-my.sharepoint.invalid/personal/${owner}/Documents`;
  }
  return `https://mock.sharepoint.invalid/sites/${encodeURIComponent(name.replace(/\s+/g, ''))}/Shared%20Documents`;
}

function stableId(provider: Provider, seed: string): string {
  return provider === 'm365' ? stableGraphItemId(seed) : stableDriveFileId(seed);
}

function folderKey(provider: Provider, path: string): string {
  return provider === 'm365' ? path.toLowerCase() : path;
}

export interface ApplySummary {
  credentials: CredentialSummary[];
  drives: number;
  folders: number;
  items: number;
}

/**
 * Merges a validated fixture document into the state. Every id is checked before anything changes, so a
 * conflicting document leaves the state as it was.
 */
export function applyFixtures(state: MockState, doc: FixtureDocument): ApplySummary {
  const drives = [
    ...(doc.m365?.drives ?? []).map((fixture) => ({ provider: 'm365' as const, fixture })),
    ...(doc.google?.drives ?? []).map((fixture) => ({ provider: 'google' as const, fixture })),
  ];
  checkIds(state, drives);
  if (doc.settings) Object.assign(state.settings, doc.settings);
  const credentials = (doc.credentials ?? []).map((credential) => registerCredential(state, credential));
  const summary: ApplySummary = { credentials, drives: 0, folders: 0, items: 0 };
  for (const { provider, fixture } of drives) applyDrive(state, provider, fixture, summary);
  return summary;
}

function plannedFileId(provider: Provider, driveId: string, parent: string, file: FileFixture): string {
  return file.id ?? stableId(provider, `${driveId}:file:${parent}/${file.name}`);
}

function checkIds(state: MockState, drives: { provider: Provider; fixture: M365DriveFixture | GoogleDriveFixture }[]): void {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  const claim = (id: string, what: string) => {
    const previous = seen.get(id);
    if (previous) problems.push(`${what}: id ${id} is also used by ${previous}`);
    else seen.set(id, what);
  };
  for (const { provider, fixture } of drives) {
    const existing = state.drives.get(fixture.id);
    if (existing && existing.provider !== provider) problems.push(`drive ${fixture.id}: already exists as a ${existing.provider} drive`);
    claim(`drive:${fixture.id}`, `drive ${fixture.id}`);
    const rootId = provider === 'google' && (fixture as GoogleDriveFixture).kind !== 'my_drive' ? fixture.id : fixture.rootId;
    if (!existing && rootId) {
      if (state.items.has(rootId)) problems.push(`drive ${fixture.id}: root id ${rootId} is already used`);
      claim(rootId, `root of drive ${fixture.id}`);
    }
    const folderIds = new Set<string>();
    for (const folder of fixture.folders ?? []) {
      if (!folder.id) continue;
      folderIds.add(folder.id);
      claim(folder.id, `folder ${fixture.id}:${folder.path}`);
      const current = state.items.get(folder.id);
      if (current && (current.driveId !== fixture.id || !current.isFolder || folderKey(provider, state.pathNames(current).join('/')) !== folderKey(provider, folder.path))) {
        problems.push(`folder ${fixture.id}:${folder.path}: id ${folder.id} is already used by another item`);
      }
    }
    for (const file of fixture.items ?? []) {
      const parent = file.parentId ?? folderKey(provider, file.path ?? '');
      const id = plannedFileId(provider, fixture.id, parent, file);
      claim(id, `file ${fixture.id}:${file.path ?? file.parentId ?? ''}/${file.name}`);
      if (state.items.has(id)) problems.push(`file ${file.name} in drive ${fixture.id}: id ${id} is already used`);
      if (file.parentId && !folderIds.has(file.parentId)) {
        const parentItem = state.items.get(file.parentId);
        const isRoot = (provider === 'google' && file.parentId === fixture.id) || file.parentId === fixture.rootId;
        if (!isRoot && (!parentItem || !parentItem.isFolder || parentItem.driveId !== fixture.id)) {
          problems.push(`file ${file.name} in drive ${fixture.id}: parent ${file.parentId} is not a folder of the drive`);
        }
      }
    }
  }
  if (problems.length > 0) throw new FixtureError(problems);
}

function applyDrive(state: MockState, provider: Provider, fixture: M365DriveFixture | GoogleDriveFixture, summary: ApplySummary): void {
  let drive = state.drives.get(fixture.id);
  if (!drive) {
    const name = defaultDriveName(fixture, provider);
    const createdAt = fixture.createdAt ? new Date(fixture.createdAt).toISOString() : new Date().toISOString();
    const owner = toPerson(fixture.owner) ?? null;
    let rootId: string;
    let driveType: DriveState['driveType'];
    let webUrl: string;
    if (provider === 'm365') {
      const m365 = fixture as M365DriveFixture;
      rootId = m365.rootId ?? stableGraphItemId(`${fixture.id}:root`);
      driveType = m365.driveType ?? 'documentLibrary';
      webUrl = defaultWebUrl({ ...m365, driveType }, name);
    } else {
      const google = fixture as GoogleDriveFixture;
      driveType = google.kind ?? 'shared_drive';
      rootId = driveType === 'my_drive' ? (google.rootId ?? stableDriveFileId(`${fixture.id}:root`)) : fixture.id;
      webUrl = driveType === 'my_drive' ? 'https://drive.google.com/drive/my-drive' : `https://drive.google.com/drive/folders/${fixture.id}`;
    }
    drive = {
      id: fixture.id,
      provider,
      name,
      driveType,
      rootId,
      webUrl,
      owner,
      tenantId: provider === 'm365' ? ((fixture as M365DriveFixture).tenantId ?? null) : null,
      createdAt,
      forbidden: fixture.forbidden ?? false,
      allowedPrincipals: fixture.allowedPrincipals ?? null,
    };
    state.drives.set(drive.id, drive);
    state.createFolder(drive, null, provider === 'm365' ? 'root' : name, { id: rootId, createdAt, createdBy: owner ?? SYSTEM_PERSON });
    summary.drives += 1;
  } else {
    if (fixture.name) drive.name = fixture.name;
    if (fixture.forbidden !== undefined) drive.forbidden = fixture.forbidden;
    if (fixture.allowedPrincipals) drive.allowedPrincipals = fixture.allowedPrincipals;
    if (fixture.owner) drive.owner = toPerson(fixture.owner) ?? drive.owner;
  }
  const target = drive;
  const folders = [...(fixture.folders ?? [])].sort((a, b) => pathSegments(a.path).length - pathSegments(b.path).length);
  for (const folder of folders) {
    const before = state.items.size;
    ensureFolderPath(state, target, pathSegments(folder.path), folder);
    summary.folders += state.items.size - before;
  }
  for (const file of fixture.items ?? []) {
    let parentId: string;
    let parentKey: string;
    if (file.parentId) {
      parentId = file.parentId;
      parentKey = file.parentId;
    } else {
      const before = state.items.size;
      parentId = ensureFolderPath(state, target, pathSegments(file.path ?? ''), undefined).id;
      summary.folders += state.items.size - before;
      parentKey = folderKey(provider, file.path ?? '');
    }
    if (provider === 'm365' && state.findChild(parentId, file.name, 'm365')) {
      throw new FixtureError([`file ${file.name} in drive ${target.id}: a file or folder with that name already exists in ${file.path ?? parentId}`]);
    }
    const versions = (file.versions ?? [{ ...file, id: file.versionId }]).map(versionInput);
    const createdBy = toPerson(file.createdBy);
    const item = state.createFile(target, parentId, file.name, {
      id: plannedFileId(provider, target.id, parentKey, file),
      mimeType: file.mimeType ?? mimeTypeFromName(file.name),
      description: file.description ?? null,
      ...(file.createdAt ? { createdAt: new Date(file.createdAt).toISOString() } : {}),
      ...(createdBy ? { createdBy } : {}),
      versions,
    });
    item.trashed = file.trashed ?? false;
    summary.items += 1;
  }
}

/** Walks (and creates where missing) a folder path from the drive root; returns the last folder. */
export function ensureFolderPath(
  state: MockState,
  drive: DriveState,
  segments: string[],
  last: FolderFixture | undefined,
  createdBy?: Person,
): ItemState {
  let current = state.item(drive.rootId) as ItemState;
  segments.forEach((segment, index) => {
    const existing = state.findChild(current.id, segment, drive.provider);
    const isLast = index === segments.length - 1;
    if (existing) {
      if (!existing.isFolder) throw new FixtureError([`drive ${drive.id}: ${segments.slice(0, index + 1).join('/')} is a file, not a folder`]);
      if (isLast && last?.id && existing.id !== last.id) {
        throw new FixtureError([`drive ${drive.id}: folder ${last.path} already exists with id ${existing.id}`]);
      }
      if (isLast && last?.description !== undefined) existing.description = last.description;
      current = existing;
      return;
    }
    const subPath = segments.slice(0, index + 1).join('/');
    const folderCreatedBy = (isLast ? toPerson(last?.createdBy) : undefined) ?? createdBy ?? drive.owner ?? SYSTEM_PERSON;
    current = state.createFolder(drive, current.id, segment, {
      id: (isLast ? last?.id : undefined) ?? stableId(drive.provider, `${drive.id}:folder:${folderKey(drive.provider, subPath)}`),
      createdAt: isLast && last?.createdAt ? new Date(last.createdAt).toISOString() : drive.createdAt,
      createdBy: folderCreatedBy,
      description: isLast ? (last?.description ?? null) : null,
    });
  });
  return current;
}
