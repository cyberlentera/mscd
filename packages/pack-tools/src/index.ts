// Library entry of `@mscd/pack-tools`: framework pack archives, licences and their Ed25519 keys (build plan E.8,
// D-15, D-16). Used by the CLI `mscd-pack`, the server's pack installer and licence service, and the demo seed.
export { canonicalJson, canonicalJsonWithout } from '@mscd/shared';
export { DEV_KEY_IDS } from './dev-key-ids.js';
export { keyId } from './key-id.js';
export {
  generateSigningKeyPair, loadPublicKey, loadSigningKey, trustedKeysById,
  type GeneratedKeyPair, type SigningKey, type SigningKeyInput, type TrustedKeyInput, type TrustedKeyKind,
} from './keys.js';
export { LicenceError, PackError, type LicenceErrorCode, type PackErrorCode } from './errors.js';
export {
  DEFAULT_PACK_LIMITS, MANIFEST_FILE, SIGNATURE_FILE, normaliseEntryPath, readPack, resolvePackLimits, type PackArchive,
  type PackLimits,
} from './archive.js';
export { datasetCounts, parsePackDatasets, type DatasetManifestFields, type PackDatasets } from './datasets.js';
export {
  PACK_MTIME, buildPack, buildPackFromSource, formatSignatureFile, packFileName, parseSignatureFile, readPackSource, sha256Hex,
  verifyPack, type BuildPackOptions, type BuiltPack, type PackSource, type VerifiedPack, type VerifyPackOptions,
} from './pack.js';
export { DEFAULT_SOURCES_DIR, buildAllPacks, writeFileAtomic, type BuildAllResult } from './build-all.js';
export {
  signLicence, verifyLicence, type SignLicenceOptions, type SignedLicence, type VerifiedLicence, type VerifyLicenceOptions,
} from './licence.js';
export {
  TarFormatError, readTar, writeTar, type TarEntryType, type TarReadEntry, type TarReadOptions, type TarWriteEntry,
  type TarWriteOptions,
} from './tar.js';
