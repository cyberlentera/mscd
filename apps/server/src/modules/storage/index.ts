// What other modules use from the storage module (B.4: modules import exported services, never internals).
export { StorageModule } from './storage.module';
export { HttpGatewayClient, GatewayProblemError, GatewayUnavailableError, checkGatewayEndpoint } from './gateway-client';
export { StorageGatewayContext, repositoryConfigSha256 } from './gateway-context';
export { HttpDataKeyIssuer, httpDataKeyIssuer } from './http-data-key-issuer';
export { RoutingService, type RoutingDecision } from './routing.service';
export { RepositoriesService, nextRepositoryCheck } from './repositories.service';
export {
  MODE_LABELS,
  REPOSITORY_TYPE,
  activeCredential,
  listRepositoryViews,
  repositoryActions,
  repositoryModesText,
  repositoryStatus,
  repositorySummary,
  repositoryUsage,
  routingModeLabel,
  toRepositoryView,
  type CredentialRow,
  type RepositoryRow,
} from './repository-view';
