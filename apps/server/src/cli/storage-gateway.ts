import { Logger } from '@nestjs/common';
import type { Command } from 'commander';
import { GatewayModule } from '../app/gateway.module';
import { exitOnConfigError, loadConfigOrExit } from '../config/run-context';
import { createGatewayApplication } from '../gateway/gateway-app';
import { BUILD_FLAVOR, VERSION } from '../generated/build-info';

/** Run mode `storage-gateway` (D.4, D.5): the `/v1` protocol on `gateway.port`, metrics on `observability.metrics_port`. */
export function register(program: Command): void {
  program
    .command('storage-gateway')
    .description('Run the storage gateway (port gateway.port, mTLS) that holds storage.key and talks to the storage providers')
    .action(runStorageGateway);
}

export async function runStorageGateway(): Promise<void> {
  const config = loadConfigOrExit('storage-gateway');
  const app = await createGatewayApplication(GatewayModule.forRoot(config), config).catch(exitOnConfigError);
  const { port, tls } = config.profile.gateway;
  await app.listen(port, '0.0.0.0').catch(exitOnConfigError);
  new Logger('storage-gateway').log(
    `MSCD storage-gateway ${VERSION} (${BUILD_FLAVOR} build) listening on port ${port} (${tls.mode === 'mtls' ? 'HTTPS with client certificates' : 'plain HTTP, demo only'}) with profile ${config.profileFile}`,
  );
}
