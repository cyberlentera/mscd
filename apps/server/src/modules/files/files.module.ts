import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { FileCommandsService } from './file-commands.service';
import { FilesCommon } from './files-common';
import { FilesController } from './files.controller';
import { GatewayUpload } from './gateway-upload';
import { ObjectAccessService } from './object-access.service';
import { RedirectTokens } from './redirect-token';
import { UploadsService } from './uploads.service';

/**
 * Files (build plan D.3 file routes, D.5, F.13, WP-21): repository browse for the picker, upload intents, the
 * streamed content of stored and pass-through uploads, zero-transit registration, evidence files, document versions,
 * and `open`, `redirect` and `content` of storage objects through `FileResponder` and `ScopePolicy.canReadObject`.
 * Exported for other modules: `UploadsService` (intents), `FileCommandsService` (file attach commands).
 */
@Module({
  imports: [StorageModule],
  controllers: [FilesController],
  providers: [FilesCommon, GatewayUpload, RedirectTokens, UploadsService, FileCommandsService, ObjectAccessService],
  exports: [UploadsService, FileCommandsService],
})
export class FilesModule {}
