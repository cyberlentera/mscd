// Last line of defence of the diagnostics archive (D.3 `POST /ops/diagnostics`, F.12): before the archive is
// packed, every text in it is scrubbed of
//   - the values of the secret files this process is configured with (every `*_file`, `*_files`, `path` and
//     `previous_paths` entry of the profile, and every `MSCD_*_FILE` variable), line by line for multi-line keys;
//   - the values of secret environment variables (the database URL shorthands and any `MSCD_*` variable whose name
//     says password, secret, token or key);
//   - passwords inside URLs (`scheme://user:password@host`);
//   - the values of the F.12 query parameters (`token`, `code`, `state`, `t`, `SAMLResponse`, `RelayState`,
//     `invitation`) wherever a URL query appears;
//   - values of JSON members named like secrets (`"password": "..."`, `"clientSecret": "..."`, `"code": "..."`).
// The log lines are already redacted by pino; this pass catches what a log call may have put into a message text.
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { MscdConfig } from '../../config/mscd-config';
import { DATABASE_URL_ENV } from '../../config/mscd-config';
import { REDACTED, REDACTED_QUERY_PARAMETERS } from '../platform/logging';

/** Values shorter than this are not scrubbed as literal text (they would match ordinary words). */
export const MIN_SECRET_LENGTH = 6;

/** Secret files larger than this are not read (keys and tokens are small). */
const MAX_SECRET_FILE_BYTES = 256 * 1024;

const SECRET_ENV_NAME = /^MSCD_.*(PASSWORD|SECRET|TOKEN|_KEY)$/i;
const SECRET_JSON_MEMBER = /("(?:password|passwd|secret|clientSecret|client_secret|refreshToken|refresh_token|accessToken|access_token|token|code|sealedBlob|privateKeyPem|[A-Za-z_]*_sealed)"\s*:\s*)"(?:[^"\\]|\\.)*"/g;
const URL_PASSWORD = /([a-z][a-z0-9+.-]*:\/\/[^\s:/@"']*:)([^\s@/"']+)(@)/gi;

/** Every file path the profile names for a secret (relative paths resolved against the profile's folder). */
export function secretFilesOf(profile: unknown, profileFile: string): string[] {
  const base = path.dirname(profileFile);
  const files = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.trim() !== '') files.add(path.resolve(base, value));
  };
  const walk = (node: unknown, depth: number) => {
    if (depth > 8 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key.endsWith('_file') || key === 'path') add(value);
      else if ((key.endsWith('_files') || key === 'previous_paths') && Array.isArray(value)) value.forEach(add);
      else walk(value, depth + 1);
    }
  };
  walk(profile, 0);
  return [...files];
}

function readSecret(file: string): string | null {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_SECRET_FILE_BYTES) return null;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** The literal values to scrub from a secret text: the whole value, each line and a URL password inside it. */
function valuesOf(text: string): string[] {
  const out: string[] = [];
  const trimmed = text.replace(/\r?\n$/, '');
  out.push(trimmed, trimmed.trim());
  for (const line of trimmed.split(/\r?\n/)) {
    const value = line.trim();
    // PEM armour lines are public knowledge; everything else of a key file is secret.
    if (value.startsWith('-----')) continue;
    out.push(value);
  }
  for (const match of trimmed.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:([^\s@/]+)@/gi)) {
    out.push(match[1]!);
    try {
      out.push(decodeURIComponent(match[1]!));
    } catch {
      // Not percent-encoded.
    }
  }
  return out.filter((v) => v.length >= MIN_SECRET_LENGTH);
}

export class SecretScrubber {
  private readonly literals: string[];

  constructor(values: Iterable<string>) {
    // Longest first, so a value that contains another is replaced whole.
    this.literals = [...new Set(values)].filter((v) => v.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
  }

  /** Scrubber for the secrets of this process's configuration plus `extra` values. */
  static forConfig(config: MscdConfig, extra: Iterable<string> = []): SecretScrubber {
    const values: string[] = [...extra];
    for (const file of secretFilesOf(config.profile, config.profileFile)) {
      const text = readSecret(file);
      if (text !== null) values.push(...valuesOf(text));
    }
    const env = config.env;
    const secretVariables = new Set<string>(Object.values(DATABASE_URL_ENV));
    for (const name of Object.keys(env)) if (SECRET_ENV_NAME.test(name)) secretVariables.add(name);
    for (const name of secretVariables) {
      const direct = env[name];
      if (direct) values.push(...valuesOf(direct));
    }
    for (const [name, file] of Object.entries(env)) {
      if (!name.startsWith('MSCD') || !name.endsWith('_FILE') || !file) continue;
      const text = readSecret(path.resolve(file));
      if (text !== null) values.push(...valuesOf(text));
    }
    if (config.profile.jobs.bullmq.url) values.push(...valuesOf(config.profile.jobs.bullmq.url));
    return new SecretScrubber(values);
  }

  /** Number of literal values this scrubber removes. */
  get size(): number {
    return this.literals.length;
  }

  scrub(text: string): string {
    let out = text;
    for (const value of this.literals) if (out.includes(value)) out = out.split(value).join(REDACTED);
    out = out.replace(URL_PASSWORD, `$1${REDACTED}$3`);
    out = out.replace(SECRET_JSON_MEMBER, `$1"${REDACTED}"`);
    return redactQueryValues(out);
  }
}

const QUERY_NAMES = [...REDACTED_QUERY_PARAMETERS].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const QUERY_VALUE = new RegExp(`([?&](?:${QUERY_NAMES})=)([^&#\\s"'\\\\]*)`, 'g');

/** Replaces the values of the F.12 query parameters in any URL query inside `text`. */
export function redactQueryValues(text: string): string {
  return text.replace(QUERY_VALUE, (_match, prefix: string, value: string) => (value === REDACTED || value === '' ? `${prefix}${value}` : `${prefix}${REDACTED}`));
}
