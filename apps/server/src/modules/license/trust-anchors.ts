// Trust anchors of this build (D-16): the Ed25519 public keys that may sign licences and packs, compiled into
// `src/generated/build-info.ts` by `scripts/gen-build-info.mjs`. There is no profile key or environment variable
// for them. A release-flavour build additionally refuses every key id listed in
// `packages/pack-tools/dev-keys/dev-key-ids.json` (`DEV_KEY_IDS`), even if such a key were compiled in.
import { DEV_KEY_IDS } from '@mscd/pack-tools';
import { BUILD_FLAVOR, TRUSTED_KEYS, type BuildFlavor, type TrustedKey } from '../../generated/build-info';

export interface TrustAnchors {
  readonly flavor: BuildFlavor;
  /** Every compiled key with its kind; a licence key never verifies a pack (A-17). */
  readonly keys: readonly TrustedKey[];
  /** Key ids refused even when trusted: the development keys in a release build, nothing in a dev build. */
  readonly rejectKeyIds: readonly string[];
}

/** Injection token of the trust anchors (tests replace them with the anchors of a rehearsal release build). */
export const TRUST_ANCHORS = Symbol.for('mscd.trustAnchors');

/** The parts of a generated build info module the anchors are made of. */
export interface BuildInfoTrust {
  readonly BUILD_FLAVOR: BuildFlavor;
  readonly TRUSTED_KEYS: readonly TrustedKey[];
}

/**
 * Trust anchors of a build info module. In release flavour the development key ids are refused and dropped from the
 * key list (defence in depth behind `gen-build-info.mjs`, which already refuses to compile them).
 */
export function trustAnchorsOf(info: BuildInfoTrust, devKeyIds: readonly string[] = DEV_KEY_IDS): TrustAnchors {
  const release = info.BUILD_FLAVOR === 'release';
  const rejected = release ? [...new Set(devKeyIds)] : [];
  const refused = new Set(rejected);
  return {
    flavor: info.BUILD_FLAVOR,
    keys: info.TRUSTED_KEYS.filter((key) => !refused.has(key.keyId)),
    rejectKeyIds: rejected,
  };
}

/** The anchors compiled into this build. */
export function compiledTrustAnchors(): TrustAnchors {
  return trustAnchorsOf({ BUILD_FLAVOR, TRUSTED_KEYS });
}
