import { Module } from '@nestjs/common';
import { GATEWAY_CLIENT } from '../../common/tokens';
import { HttpGatewayClient } from './gateway-client';
import { StorageGatewayContext } from './gateway-context';
import { RepositoriesService } from './repositories.service';
import { RoutingService } from './routing.service';
import { StorageController } from './storage.controller';

/**
 * Storage on the api and worker side (D.5, D-08, F.8): the storage gateway client (`GATEWAY_CLIENT`), the gateway
 * call descriptors, repositories, credentials, OAuth consent, move requests, routing rules and `RoutingService`.
 */
@Module({
  controllers: [StorageController],
  providers: [
    HttpGatewayClient,
    { provide: GATEWAY_CLIENT, useExisting: HttpGatewayClient },
    StorageGatewayContext,
    RepositoriesService,
    RoutingService,
  ],
  exports: [GATEWAY_CLIENT, StorageGatewayContext, RoutingService, RepositoriesService],
})
export class StorageModule {}
