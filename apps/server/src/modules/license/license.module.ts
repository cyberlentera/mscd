import { Global, Module } from '@nestjs/common';
import { LICENCE_GATE } from '../../common/tokens';
import { LicenseCheckJob } from './license-check.job';
import { LicenseController } from './license.controller';
import { LicenceGateService } from './licence-gate';
import { LicenceService } from './licence.service';
import { TRUST_ANCHORS, compiledTrustAnchors } from './trust-anchors';

/**
 * Licence verification with the compiled trust anchors, derived licence state and the real `LICENCE_GATE` (D-15,
 * D-16, D-32, BR-37), `GET /license`, `PUT /admin/license` and the `license.check` job. Global: the guard and every
 * module that checks a limit or feature inject `LICENCE_GATE`; the pack installer uses `TRUST_ANCHORS`.
 */
@Global()
@Module({
  controllers: [LicenseController],
  providers: [
    { provide: TRUST_ANCHORS, useFactory: compiledTrustAnchors },
    LicenceService,
    LicenceGateService,
    { provide: LICENCE_GATE, useExisting: LicenceGateService },
    LicenseCheckJob,
  ],
  exports: [LICENCE_GATE, LicenceService, TRUST_ANCHORS],
})
export class LicenseModule {}
