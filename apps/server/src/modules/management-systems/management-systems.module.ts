import { Module } from '@nestjs/common';
import { ManagementSystemsController } from './management-systems.controller';
import { ManagementSystemsService } from './management-systems.service';

/**
 * Management system administration, activation and edition transitions (TS 6.2, C.13, D-30): the routes of
 * `/admin/management-systems` and `POST /ms/{ms}/transitions`. Uses the licence module (BR-21, `LIC-MS`,
 * `LIC-FEATURE`).
 */
@Module({
  controllers: [ManagementSystemsController],
  providers: [ManagementSystemsService],
  exports: [ManagementSystemsService],
})
export class ManagementSystemsModule {}
