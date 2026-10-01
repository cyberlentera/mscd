import { Global, Module } from '@nestjs/common';
import { AUDIT_WRITER } from '../../common/tokens';
import { compiledAnchorKeys } from './anchors';
import { ChainedAuditWriter } from './audit-writer';
import { AuditTrailController } from './audit-trail.controller';
import { AuditTrailService } from './audit-trail.service';
import { AUDIT_ANCHOR_KEYS, AuditChainVerifier } from './chain-verifier';

/**
 * Audit trail writer, readers and chain verification for `platform.audit_log` and every tenant `audit_trail`, and
 * the signed anchors (F.11). The anchor job itself is WP-22's `audit.verify-chain`.
 */
@Global()
@Module({
  controllers: [AuditTrailController],
  providers: [
    ChainedAuditWriter,
    { provide: AUDIT_WRITER, useExisting: ChainedAuditWriter },
    { provide: AUDIT_ANCHOR_KEYS, useFactory: () => compiledAnchorKeys() },
    AuditChainVerifier,
    AuditTrailService,
  ],
  exports: [AUDIT_WRITER, AUDIT_ANCHOR_KEYS, AuditChainVerifier, AuditTrailService],
})
export class AuditModule {}
