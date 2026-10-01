import { Module } from '@nestjs/common';
import { ReadModelModule } from '../read-model/read-model.module';
import { AuditEventCommandsService } from './audit-events.service';
import { DocumentCommandsService } from './documents.service';
import { RecordCommandsService } from './records.service';
import { REGISTER_RULES } from './register.rules';
import { RegistersController } from './registers.controller';
import { SharedChangeGuard } from './shared-change';

/**
 * Documents, assignment, complete-action, soft delete, audit events, preparation tasks, cycle items and task
 * completion (D.3, C.13, WP-35), with the rules they trigger (BR-16, BR-22, BR-41, BR-42, BR-43) registered with
 * `@BusinessRule` for the global `RuleEngine`. `SharedChangeGuard` (BR-22) is exported for the register edits of
 * WP-36 and WP-37.
 */
@Module({
  imports: [ReadModelModule],
  controllers: [RegistersController],
  providers: [RecordCommandsService, DocumentCommandsService, AuditEventCommandsService, SharedChangeGuard, ...REGISTER_RULES],
  exports: [RecordCommandsService, DocumentCommandsService, AuditEventCommandsService, SharedChangeGuard],
})
export class RegistersModule {}
