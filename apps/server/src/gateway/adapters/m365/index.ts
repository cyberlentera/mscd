// Microsoft 365 adapter of the storage gateway (WP-15). The registry (`../index.ts`) adds `m365AdapterFactory`.
export {
  DEFAULT_GRAPH_BASE_URL,
  DEFAULT_LOGIN_BASE_URL,
  GRAPH_FRAGMENT_MULTIPLE,
  M365Adapter,
  m365AdapterFactory,
  m365SettingsFromConfig,
  type M365AdapterSettings,
} from './m365-adapter';
export { QuickXorHash } from './quickxor';
export type { ProviderAdapterOptions } from './provider/options';
