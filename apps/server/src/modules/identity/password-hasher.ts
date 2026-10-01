// Password and recovery code hashing (build plan F.4, F.5): argon2id through @node-rs/argon2 with the OWASP minimum
// parameters (19,456 KiB memory, 2 iterations, parallelism 1, 32 byte output). Hashes made with other parameters
// are re-made at the next successful sign-in.
import { hash, parseOptions, verify, type Algorithm } from '@node-rs/argon2';

/** `Algorithm.Argon2id` (a const enum in the typings, so the value is written here). */
const ARGON2ID = 2 as Algorithm;

export const ARGON2_PARAMETERS = { memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;

const OPTIONS = { algorithm: ARGON2ID, ...ARGON2_PARAMETERS };

/** Hashes a secret (password or recovery code) as an argon2id PHC string. */
export async function hashSecret(secret: string): Promise<string> {
  return hash(secret, OPTIONS);
}

/** True when `secret` matches the PHC string; false for a wrong secret or a malformed hash. */
export async function verifySecret(hashed: string, secret: string): Promise<boolean> {
  try {
    return await verify(hashed, secret);
  } catch {
    return false;
  }
}

/** True when the hash was made with other parameters than the current ones (rehash on sign-in, F.4). */
export function needsRehash(hashed: string): boolean {
  try {
    const o = parseOptions(hashed);
    return (
      o.algorithm !== ARGON2ID ||
      o.memoryCost !== ARGON2_PARAMETERS.memoryCost ||
      o.timeCost !== ARGON2_PARAMETERS.timeCost ||
      o.parallelism !== ARGON2_PARAMETERS.parallelism ||
      o.outputLen !== ARGON2_PARAMETERS.outputLen
    );
  } catch {
    return true;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Spends the time of one verification without an account, so an unknown email answers as slowly as a wrong
 * password (no account enumeration by timing).
 */
export async function verifyAgainstNothing(secret: string): Promise<void> {
  dummyHash ??= hashSecret('mscd-no-such-account');
  await verifySecret(await dummyHash, secret);
}
