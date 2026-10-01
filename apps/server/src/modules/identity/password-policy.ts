// Password policy (build plan F.4): 12 to 256 characters, not equal to the account's email or handle, and not one of
// the 10,000 most common passwords in `common-passwords.txt` (shipped next to the compiled module; the source copy
// in src/ is used when running from the repository).
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

let loaded: ReadonlySet<string> | undefined;

/** The common password list, lower-cased. Throws when the file is missing, so a broken image fails at start. */
export function commonPasswords(): ReadonlySet<string> {
  if (loaded) return loaded;
  const file = commonPasswordFileCandidates().find((candidate) => existsSync(candidate));
  if (!file) {
    throw new Error(`The common password list ${LIST_NAME} is missing (looked in ${commonPasswordFileCandidates().join(', ')}); it must be shipped next to the identity module (F.4)`);
  }
  const words = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line !== '');
  if (words.length < 1000) throw new Error(`The common password list ${file} has only ${words.length} entries`);
  loaded = new Set(words);
  return loaded;
}

/** Length in characters (code points), as people count them. */
function characters(text: string): number {
  return [...text].length;
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
  if (commonPasswords().has(lower)) errors.push({ path: field, message: 'This password is too common; choose another one' });
  return errors;
}
