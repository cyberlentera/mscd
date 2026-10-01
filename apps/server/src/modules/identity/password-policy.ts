// Password policy (build plan F.4): 12 to 256 characters, not equal to the account's email or handle, and not a
// common password. The list `common-passwords.txt` (shipped next to the compiled module; the source copy in src/ is
// used when running from the repository) holds the SecLists 10,000 most common passwords and the 10,000 most common
// ones of 12 or more characters. Because the 12-character minimum already rejects most short common passwords, the
// check also looks at normalised forms: digits and symbols around a common word (`password1234`, `2024summer!!`),
// common character swaps (`p@ssw0rd2024`), a repeated word (`passwordpassword`), and passwords made of very few
// repeated or consecutive characters (`111111111111`, `abcabcabcabc`, `123456789012`).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { FieldError } from '@mscd/shared';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

const LIST_NAME = 'common-passwords.txt';

/** Where the list is looked for: next to this module, then in the source tree (runs from `dist/`). */
export function commonPasswordFileCandidates(dir = __dirname): string[] {
  return [path.join(dir, LIST_NAME), path.resolve(dir, '../../../src/modules/identity', LIST_NAME)];
}

/**
 * The entries of a list file: the header (leading lines that start with `#`, with the source and the SecLists
 * licence) ends at the first empty line and is skipped; every other non-empty line is one password, lower-cased.
 */
export function parseCommonPasswordList(text: string): string[] {
  const lines = text.split(/\r?\n/);
  let start = 0;
  if (lines[0]?.startsWith('#')) {
    while (start < lines.length && lines[start] !== '') start += 1;
  }
  return lines
    .slice(start)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line !== '');
}

let loaded: ReadonlySet<string> | undefined;

/** The common password list, lower-cased. Throws when the file is missing, so a broken image fails at start. */
export function commonPasswords(): ReadonlySet<string> {
  if (loaded) return loaded;
  const file = commonPasswordFileCandidates().find((candidate) => existsSync(candidate));
  if (!file) {
    throw new Error(`The common password list ${LIST_NAME} is missing (looked in ${commonPasswordFileCandidates().join(', ')}); it must be shipped next to the identity module (F.4)`);
  }
  const words = parseCommonPasswordList(readFileSync(file, 'utf8'));
  if (words.length < 10_000) throw new Error(`The common password list ${file} has only ${words.length} entries`);
  loaded = new Set(words);
  return loaded;
}

/** Length in characters (code points), as people count them. */
function characters(text: string): number {
  return [...text].length;
}

/** Common character swaps, undone before a lookup (`p@ssw0rd` is `password`). */
const SWAPS: Readonly<Record<string, string>> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i' };

function unswap(text: string): string {
  return [...text].map((c) => SWAPS[c] ?? c).join('');
}

/** Shortest unit the text repeats (`abc` for `abcabcabc`), or the text itself. */
function repeatedUnit(text: string): string {
  const chars = [...text];
  for (let size = 1; size <= chars.length / 2; size += 1) {
    if (chars.length % size !== 0) continue;
    const unit = chars.slice(0, size).join('');
    if (unit.repeat(chars.length / size) === text) return unit;
  }
  return text;
}

/** True when every character follows the one before it, up or down (`123456789012`, `abcdefghijkl`, `987654321098`). */
function consecutive(text: string): boolean {
  const codes = [...text].map((c) => c.codePointAt(0)!);
  if (codes.length < 3) return false;
  const step = (a: number, b: number) => {
    const isDigit = (n: number) => n >= 48 && n <= 57;
    if (isDigit(a) && isDigit(b)) return ((b - a + 10) % 10 === 1 ? 1 : 0) || ((a - b + 10) % 10 === 1 ? -1 : 0);
    return b - a === 1 ? 1 : b - a === -1 ? -1 : 0;
  };
  const first = step(codes[0]!, codes[1]!);
  if (first === 0) return false;
  for (let i = 2; i < codes.length; i += 1) if (step(codes[i - 1]!, codes[i]!) !== first) return false;
  return true;
}

/** The common word a password is built on, when there is one (normalised forms, see the header). */
function commonCore(lower: string, list: ReadonlySet<string>): boolean {
  if (list.has(lower)) return true;
  // Digits and symbols after and before a common word, also with character swaps undone.
  const trailing = lower.replace(/[^\p{L}]+$/u, '');
  const both = trailing.replace(/^[^\p{L}]+/u, '');
  for (const form of new Set([trailing, both, unswap(trailing), unswap(both)])) {
    if (characters(form) >= 3 && list.has(form)) return true;
  }
  return false;
}

/** True when a password is common or built on a common password (F.4). */
export function isCommonPassword(password: string, list: ReadonlySet<string> = commonPasswords()): boolean {
  const lower = password.trim().toLowerCase();
  if (commonCore(lower, list)) return true;
  // Very few distinct characters, a short unit repeated, or a run of consecutive characters.
  if (new Set(lower).size < 4) return true;
  const unit = repeatedUnit(lower);
  if (unit !== lower && (characters(unit) <= 4 || commonCore(unit, list))) return true;
  return consecutive(lower);
}

/**
 * Problems of a new password for an account (empty when it is acceptable). `field` is the request member path
 * the errors name, for example `body.password`.
 */
export function passwordProblems(password: string, account: { email: string; handle: string }, field: string): FieldError[] {
  const errors: FieldError[] = [];
  const length = characters(password);
  if (length < PASSWORD_MIN_LENGTH) errors.push({ path: field, message: `Use at least ${PASSWORD_MIN_LENGTH} characters` });
  if (length > PASSWORD_MAX_LENGTH) errors.push({ path: field, message: `Use at most ${PASSWORD_MAX_LENGTH} characters` });
  const lower = password.trim().toLowerCase();
  if (lower === account.email.trim().toLowerCase() || lower === account.handle.toLowerCase()) {
    errors.push({ path: field, message: 'The password must not be your email address or user name' });
  }
  if (isCommonPassword(password)) errors.push({ path: field, message: 'This password is too common; choose another one' });
  return errors;
}
