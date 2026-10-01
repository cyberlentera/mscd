// Google Drive adapter of the storage gateway (WP-15). The registry (`../index.ts`) adds `googleDriveAdapterFactory`.
export {
  DEFAULT_API_BASE_URL,
  DEFAULT_TOKEN_URL,
  DRIVE_CHUNK_MULTIPLE,
  GoogleDriveAdapter,
  googleDriveAdapterFactory,
  googleDriveSettingsFromConfig,
  type GoogleDriveAdapterSettings,
} from './drive-adapter';
export { DRIVE_SCOPE } from './google-token';
