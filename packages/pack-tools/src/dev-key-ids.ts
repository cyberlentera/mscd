import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Key ids of every development key (rule R-11), read from `dev-keys/dev-key-ids.json` (a JSON array of
 * strings). Release builds reject anything signed with one of them (D-16). WP-09 creates the file together with
 * the development keys; until then the list is empty.
 */
export const DEV_KEY_IDS: readonly string[] = Object.freeze(loadDevKeyIds());

function loadDevKeyIds(): string[] {
  const file = fileURLToPath(new URL('../dev-keys/dev-key-ids.json', import.meta.url));
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === 'string' && /^[0-9a-f]{16}$/.test(id))) {
    throw new Error(`${file} must be a JSON array of 16-character hexadecimal key ids`);
  }
  return parsed as string[];
}
