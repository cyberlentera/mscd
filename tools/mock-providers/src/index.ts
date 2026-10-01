// Mock servers for the provider APIs MSCD calls (build plan J.7 and D.5): the Microsoft identity platform token
// endpoint, the Microsoft Graph drive item API, and the Google OAuth 2.0 and Drive v3 APIs, with an admin API for
// fixtures and fault switches. Tests and the demo only; never part of a release.

export { buildMockProviders, startMockProviders, type MockProvidersOptions, type RunningMockProviders, type StartOptions } from './app.js';
export { createSelfSignedCertificate, inspectCertificate, type CertificateInfo, type SelfSignedCertificate, type SelfSignedCertificateOptions } from './certs.js';
export { createGoogleServiceAccountAssertion, createM365ClientAssertion, type GoogleAssertionInput, type M365AssertionInput } from './client.js';
export { hashContent, type ContentHashes } from './content.js';
export {
  FixtureError,
  parseFixtureDocument,
  type CredentialFixture,
  type FileFixture,
  type FixtureDocument,
  type FolderFixture,
  type GoogleDriveFixture,
  type GoogleOAuthClientCredential,
  type GoogleRefreshTokenCredential,
  type GoogleServiceAccountCredential,
  type M365CertificateCredential,
  type M365DriveFixture,
  type PersonFixture,
  type VersionFixture,
} from './fixtures.js';
export { DRIVE_ID_PATTERN, GRAPH_ID_PATTERN } from './ids.js';
export { QuickXorHash, quickXorHash } from './quickxor.js';
export { runSelfTest } from './self-test.js';
export { DEFAULT_SETTINGS, type MockSettings } from './state.js';
