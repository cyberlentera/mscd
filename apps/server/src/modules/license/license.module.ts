import { Global, Module } from '@nestjs/common';
import { LICENCE_GATE } from '../../common/tokens';
import { PermissiveLicenceGate } from './defaults';

/**
 * Licence verification, derived licence state and the LicenceGate (D-15, D-32). Built by WP-12; until then
 * `LICENCE_GATE` is permissive (WP-08).
 */
@Global()
@Module({
  providers: [{ provide: LICENCE_GATE, useClass: PermissiveLicenceGate }],
  exports: [LICENCE_GATE],
})
export class LicenseModule {}
