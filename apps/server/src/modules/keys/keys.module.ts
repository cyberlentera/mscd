import { Global, Logger, Module } from '@nestjs/common';
import { MscdConfig } from '../../config/mscd-config';
import { FileKeyProvider, keyFileTooOpen } from './file-key-provider';
import { PLATFORM_KEY_PROVIDER, SecretBox } from './secret-box';

/**
 * KeyProvider (file driver) and SecretBox for the api and worker, sealed with `platform.key` (D-09, F.11). The key
 * files are read once at start, so a missing or malformed key stops the process before it serves anything.
 */
@Global()
@Module({
  providers: [
    {
      provide: PLATFORM_KEY_PROVIDER,
      inject: [MscdConfig],
      useFactory: (config: MscdConfig) => {
        const { path, previous_paths: previous } = config.profile.kms.file;
        for (const file of [path, ...previous]) {
          if (keyFileTooOpen(file)) new Logger('Keys').warn(`Key file ${file} can be read by other users; use mode 0400 (F.11)`);
        }
        return FileKeyProvider.fromFiles(path, previous);
      },
    },
    SecretBox,
  ],
  exports: [PLATFORM_KEY_PROVIDER, SecretBox],
})
export class KeysModule {}
