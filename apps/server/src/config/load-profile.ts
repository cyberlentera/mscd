import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import type { z } from 'zod';
import {
  profileRules,
  profileSchema,
  releaseFlavourIssues,
  REMOVED_KEYS,
  type Profile,
  type ProfileIssue,
} from './profile.schema';
import type { BuildFlavor } from '../generated/build-info';

/** Prefix of profile overrides: `MSCD__<SECTION>__<KEY>=value` sets `section.key` (I.1). */
export const OVERRIDE_PREFIX = 'MSCD__';

export type Env = Readonly<Record<string, string | undefined>>;

export class ProfileError extends Error {
  constructor(
    readonly file: string | undefined,
    readonly issues: ProfileIssue[],
  ) {
    super(`Invalid deployment profile${file ? ` ${file}` : ''}: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
    this.name = 'ProfileError';
  }

  /** Multi-line text listing every issue, printed on exit. */
  format(): string {
    const lines = this.issues.map((i) => `  - ${i.path ? `${i.path}: ` : ''}${i.message}`);
    return `Invalid deployment profile${this.file ? ` ${this.file}` : ''}:\n${lines.join('\n')}\n`;
  }
}

export interface LoadedProfile {
  profile: Profile;
  /** Absolute path of the profile file. */
  file: string;
}

/**
 * Loads `MSCD_PROFILE_FILE`, applies `MSCD__A__B` overrides, validates against the strict schema, the
 * cross-field rules and (for release builds) the release restrictions, then resolves relative file paths
 * against the folder of the profile file. Throws `ProfileError` listing every problem.
 */
export function loadProfile(options: { env: Env; flavor: BuildFlavor; cwd?: string }): LoadedProfile {
  const { env, flavor } = options;
  const fileSetting = env.MSCD_PROFILE_FILE;
  if (!fileSetting) {
    throw new ProfileError(undefined, [
      { path: 'MSCD_PROFILE_FILE', message: 'is not set; point it to a deployment profile YAML file (I.1)' },
    ]);
  }
  const file = path.resolve(options.cwd ?? process.cwd(), fileSetting);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new ProfileError(file, [{ path: '', message: `cannot read the file (${(error as Error).message})` }]);
  }
  let raw: unknown;
  try {
    raw = parseYaml(text, { uniqueKeys: true, prettyErrors: true });
  } catch (error) {
    const message = error instanceof YAMLParseError ? error.message : String(error);
    throw new ProfileError(file, [{ path: '', message: `is not valid YAML: ${message}` }]);
  }
  if (!isPlainObject(raw)) {
    throw new ProfileError(file, [{ path: '', message: 'must be a YAML mapping of sections' }]);
  }
  const profile = validateProfile(applyOverrides(raw, env), flavor, file);
  return { profile: resolveProfilePaths(profile, path.dirname(file)), file };
}

/** Validates a raw profile object (after overrides). Exported for tests and tooling. */
export function validateProfile(raw: Record<string, unknown>, flavor: BuildFlavor, file?: string): Profile {
  const issues: ProfileIssue[] = [];
  const input = structuredClone(raw);
  for (const [dotted, message] of Object.entries(REMOVED_KEYS)) {
    if (deleteKey(input, dotted.split('.'))) issues.push({ path: dotted, message });
  }
  const parsed = profileSchema.safeParse(input, { reportInput: true });
  if (!parsed.success) {
    issues.push(...parsed.error.issues.flatMap(toProfileIssues));
    throw new ProfileError(file, issues);
  }
  issues.push(...profileRules(parsed.data));
  if (flavor === 'release') issues.push(...releaseFlavourIssues(parsed.data));
  if (issues.length > 0) throw new ProfileError(file, issues);
  return parsed.data;
}

/**
 * Applies `MSCD__<SECTION>__<KEY>[__<KEY>...]=value` environment overrides. Segments are lower-cased; values are
 * parsed as YAML, so `true`, `3000`, `null` and `[a, b]` keep their types and `cloud_kms` stays a string.
 */
export function applyOverrides(raw: Record<string, unknown>, env: Env): Record<string, unknown> {
  const result = structuredClone(raw);
  const errors: ProfileIssue[] = [];
  const names = Object.keys(env)
    .filter((name) => name.startsWith(OVERRIDE_PREFIX))
    .sort();
  for (const name of names) {
    const value = env[name];
    if (value === undefined) continue;
    const segments = name.slice(OVERRIDE_PREFIX.length).split('__');
    if (segments.some((s) => !/^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*$/.test(s))) {
      errors.push({ path: name, message: 'is not a valid override name; use MSCD__<SECTION>__<KEY>' });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = value === '' ? null : parseYaml(value);
    } catch (error) {
      errors.push({ path: name, message: `value is not valid YAML (${(error as Error).message})` });
      continue;
    }
    setKey(result, segments.map((s) => s.toLowerCase()), parsed);
  }
  if (errors.length > 0) throw new ProfileError(undefined, errors);
  return result;
}

/** Fields that hold file or folder paths; relative values are resolved against the profile's folder. */
const PATH_FIELDS: readonly (readonly string[])[] = [
  ['packs', 'dir'],
  ['kms', 'file', 'path'],
  ['mail', 'smtp', 'password_file'],
  ['storage', 'gateway', 'token_file'],
  ['storage', 'gateway', 'tls', 'ca_file'],
  ['storage', 'gateway', 'tls', 'cert_file'],
  ['storage', 'gateway', 'tls', 'key_file'],
  ['database', 'url_file'],
  ['database', 'migrator_url_file'],
  ['database', 'pack_installer_url_file'],
  ['database', 'admin_url_file'],
  ['audit', 'anchor_key_file'],
  ['demo', 'keycloak', 'client_secret_file'],
  ['test', 'admin_database_url_file'],
  ['gateway', 'kms', 'file', 'path'],
  ['gateway', 'tls', 'ca_file'],
  ['gateway', 'tls', 'cert_file'],
  ['gateway', 'tls', 'key_file'],
  ['gateway', 'vault', 'access_key_file'],
  ['gateway', 'vault', 'secret_key_file'],
];
const PATH_LIST_FIELDS: readonly (readonly string[])[] = [
  ['kms', 'file', 'previous_paths'],
  ['gateway', 'kms', 'file', 'previous_paths'],
  ['gateway', 'token_files'],
];

export function resolveProfilePaths(profile: Profile, baseDir: string): Profile {
  const result = structuredClone(profile) as unknown as Record<string, unknown>;
  const resolve = (p: unknown) => (typeof p === 'string' ? path.resolve(baseDir, p) : p);
  for (const field of PATH_FIELDS) {
    const parent = getParent(result, field);
    const key = field[field.length - 1]!;
    if (parent && key in parent) parent[key] = resolve(parent[key]);
  }
  for (const field of PATH_LIST_FIELDS) {
    const parent = getParent(result, field);
    const key = field[field.length - 1]!;
    if (parent && Array.isArray(parent[key])) parent[key] = (parent[key] as unknown[]).map(resolve);
  }
  return result as unknown as Profile;
}

function toProfileIssues(issue: z.core.$ZodIssue): ProfileIssue[] {
  const base = issue.path.map(String).join('.');
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => ({ path: base ? `${base}.${key}` : key, message: 'unknown key' }));
  }
  // With reportInput, an issue on a missing key carries the key in `input` as undefined.
  if ('input' in issue && issue.input === undefined && issue.code !== 'custom') {
    return [{ path: base, message: 'is required' }];
  }
  return [{ path: base, message: issue.message }];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getParent(root: Record<string, unknown>, field: readonly string[]): Record<string, unknown> | undefined {
  let node: unknown = root;
  for (const segment of field.slice(0, -1)) {
    if (!isPlainObject(node)) return undefined;
    node = node[segment];
  }
  return isPlainObject(node) ? node : undefined;
}

function setKey(root: Record<string, unknown>, segments: string[], value: unknown): void {
  let node = root;
  for (const segment of segments.slice(0, -1)) {
    if (!isPlainObject(node[segment])) node[segment] = {};
    node = node[segment] as Record<string, unknown>;
  }
  node[segments[segments.length - 1]!] = value;
}

function deleteKey(root: Record<string, unknown>, segments: string[]): boolean {
  const parent = getParent(root, segments);
  const key = segments[segments.length - 1]!;
  if (!parent || !(key in parent)) return false;
  delete parent[key];
  return true;
}
