// Signing and verifying licences (D-15, E.8). A licence is a JSON document with the TS 2.5 fields, a binding
// (`organization_id` or `installation_id`, or `"trial": true` for at most 90 days) and `key_id`. The signature is
// Ed25519 over the canonical JSON of the document without `signature` (keys sorted recursively, no whitespace),
// stored as `"signature": "ed25519:<base64>"`.
import { sign, verify } from 'node:crypto';
import { LicenceDocument, licenceBinding, licenceSigningPayload, type LicenceBinding } from '@mscd/shared';
import { LicenceError } from './errors.js';
import { loadSigningKey, trustedKeysById, type SigningKeyInput, type TrustedKeyInput } from './keys.js';

export type SignedLicence = LicenceDocument & Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Reads a licence given as JSON text, a buffer of JSON or an already parsed object. */
function asDocument(input: unknown): Record<string, unknown> {
  let value = input;
  if (typeof input === 'string' || Buffer.isBuffer(input)) {
    try {
      // TextDecoder drops a leading byte order mark; a string may still start with one.
      const text = typeof input === 'string' ? input.replace(/^\uFEFF/, '') : new TextDecoder('utf-8', { fatal: true }).decode(input);
      value = JSON.parse(text);
    } catch (error) {
      throw new LicenceError('format', `licence is not valid JSON (${(error as Error).message})`);
    }
  }
  if (!isPlainObject(value)) throw new LicenceError('format', 'licence is not a JSON object');
  return value;
}

function schemaIssues(doc: Record<string, unknown>): string[] {
  const result = LicenceDocument.safeParse(doc);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
}

/** Canonical signing payload; a member without a JSON form (only possible in a parsed object) is a format error. */
function payloadOf(doc: Record<string, unknown>): Buffer {
  try {
    return Buffer.from(licenceSigningPayload(doc), 'utf8');
  } catch (error) {
    throw new LicenceError('format', `licence has no canonical JSON form (${(error as Error).message})`);
  }
}

function bindingProblem(binding: LicenceBinding): string | null {
  if (binding.kind !== 'unbound') return null;
  return binding.reason === 'not_trial'
    ? 'licence binds to no installation or organisation and is not a trial'
    : 'trial licence is valid for more than 90 days';
}

export interface SignLicenceOptions {
  /** Refuse to sign with these key ids (D-16). */
  readonly rejectKeyIds?: Iterable<string>;
}

/**
 * Signs a licence document: sets `key_id` to the signing key's id, replaces any `signature`, and checks the result
 * against the licence schema and the binding rule. Members keep their order, with `key_id` and `signature` last.
 * Throws `LicenceError`.
 */
export function signLicence(doc: unknown, signingKey: SigningKeyInput, options: SignLicenceOptions = {}): SignedLicence {
  const input = asDocument(doc);
  let key;
  try {
    key = loadSigningKey(signingKey);
  } catch (error) {
    throw new LicenceError('signing_key', `licence signing key: ${(error as Error).message}`);
  }
  if (new Set(options.rejectKeyIds ?? []).has(key.keyId)) {
    throw new LicenceError('signing_key', `licence signing key ${key.keyId} is a development key; it is refused here`);
  }
  const unsigned: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(input)) if (name !== 'signature' && name !== 'key_id') unsigned[name] = value;
  unsigned.key_id = key.keyId;
  const signed = { ...unsigned, signature: `ed25519:${sign(null, payloadOf(unsigned), key.privateKey).toString('base64')}` };
  const issues = schemaIssues(signed);
  if (issues.length > 0) throw new LicenceError('format', 'licence does not match the licence schema', issues);
  const problem = bindingProblem(licenceBinding(signed as unknown as LicenceDocument));
  if (problem) throw new LicenceError('binding', problem);
  return signed as SignedLicence;
}

export interface VerifyLicenceOptions {
  /** Key ids to refuse even when trusted (a release build passes `DEV_KEY_IDS`, D-16). */
  readonly rejectKeyIds?: Iterable<string>;
}

export interface VerifiedLicence {
  /** The document as given (unknown members kept; the signature covers them). */
  readonly document: SignedLicence;
  readonly keyId: string;
  /** `installation`, `organization` or `trial`; the caller checks the bound id against its own (D-15). */
  readonly binding: Exclude<LicenceBinding, { kind: 'unbound' }>;
}

/**
 * Verifies a licence given as JSON text, a buffer or a parsed object: the licence schema, the key id (refused when
 * listed in `rejectKeyIds`, then looked up among the trusted licence keys; entries of another `kind` are ignored),
 * the Ed25519 signature over the canonical document without `signature`, and the binding rule (an unbound licence
 * must be a trial of at most 90 days). Validity dates are not judged here: the server derives the state from the
 * document and its clock. Throws `LicenceError`.
 */
export function verifyLicence(doc: unknown, trustedKeys: Iterable<TrustedKeyInput>, options: VerifyLicenceOptions = {}): VerifiedLicence {
  const document = asDocument(doc);
  const issues = schemaIssues(document);
  if (issues.length > 0) throw new LicenceError('format', 'licence does not match the licence schema', issues);
  const licence = document as SignedLicence;
  const keyId = licence.key_id;
  if (new Set(options.rejectKeyIds ?? []).has(keyId)) {
    throw new LicenceError('rejected_key', `licence ${licence.license_id} is signed with development key ${keyId}, which this build does not accept`);
  }
  const publicKey = trustedKeysById(trustedKeys, 'licence').get(keyId);
  if (!publicKey) throw new LicenceError('untrusted_key', `licence ${licence.license_id} names key ${keyId}, which is not a trusted licence key`);
  const signature = Buffer.from(licence.signature.slice('ed25519:'.length), 'base64');
  if (!verify(null, payloadOf(document), publicKey, signature)) {
    throw new LicenceError('signature', `licence ${licence.license_id}: the signature does not match the document`);
  }
  const binding = licenceBinding(licence);
  const problem = bindingProblem(binding);
  if (problem || binding.kind === 'unbound') throw new LicenceError('binding', problem ?? 'licence is unbound');
  return { document: licence, keyId, binding };
}
