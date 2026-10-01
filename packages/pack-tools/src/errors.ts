// Errors of the pack and licence tooling. Every rejection carries a stable `code` so callers (the server's pack
// installer and licence service, the CLI) can map it without parsing messages, plus the individual problems found.

/** Why a pack was rejected (E.8). */
export type PackErrorCode =
  /** The archive breaks an E.8 step 1 rule: gzip, tar structure, limits, entry types, paths, names, file set. */
  | 'archive'
  /** `manifest.json` is not valid JSON or does not match the manifest schema. */
  | 'manifest'
  /** The `signature` file is malformed, or the signature does not match `manifest.json`. */
  | 'signature'
  /** The pack is signed with a key that is not trusted. */
  | 'untrusted_key'
  /** The pack is signed with a key id the caller rejects (development keys in a release build, D-16). */
  | 'rejected_key'
  /** A dataset does not match its checksum in the manifest. */
  | 'checksum'
  /** A dataset breaks its schema or a reference between datasets. */
  | 'dataset'
  /** A pack source folder cannot be built (files that are not pack datasets, links, unreadable files). */
  | 'source'
  /** The signing key is not a usable Ed25519 private key, or the caller rejects its key id. */
  | 'signing_key';

export class PackError extends Error {
  constructor(
    readonly code: PackErrorCode,
    message: string,
    /** Every problem found, when there are several (dataset and source validation). */
    readonly issues: readonly string[] = [],
  ) {
    super(issues.length > 0 ? `${message}\n${formatIssues(issues)}` : message);
    this.name = 'PackError';
  }
}

/** Why a licence was rejected (D-15). The server answers 422 `LIC-BINDING` for `binding` and 400 otherwise. */
export type LicenceErrorCode =
  /** Not JSON, or the document does not match the licence schema. */
  | 'format'
  /** The signature does not match the canonical document. */
  | 'signature'
  /** The licence names a key id that is not trusted. */
  | 'untrusted_key'
  /** The licence is signed with a key id the caller rejects (development keys in a release build, D-16). */
  | 'rejected_key'
  /** The licence binds to nothing and is not a trial of at most 90 days (D-15). */
  | 'binding'
  /** The signing key is not a usable Ed25519 private key, or the caller rejects its key id. */
  | 'signing_key';

export class LicenceError extends Error {
  constructor(
    readonly code: LicenceErrorCode,
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(issues.length > 0 ? `${message}\n${formatIssues(issues)}` : message);
    this.name = 'LicenceError';
  }
}

/** Largest number of problems listed in an error message; the `issues` array keeps all of them. */
const MAX_LISTED = 50;

function formatIssues(issues: readonly string[]): string {
  const listed = issues.slice(0, MAX_LISTED).map((issue) => `  - ${issue}`);
  if (issues.length > MAX_LISTED) listed.push(`  - and ${issues.length - MAX_LISTED} more`);
  return listed.join('\n');
}
