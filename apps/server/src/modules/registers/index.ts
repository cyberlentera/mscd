// What other modules use from the register commands (B.4).
export { RegistersModule } from './registers.module';
export { RecordCommandsService, businessCodeOf } from './records.service';
export { DocumentCommandsService } from './documents.service';
export { AuditEventCommandsService } from './audit-events.service';
export { SharedChangeGuard } from './shared-change';
export { type Br16Input, type Br22Input, type Br41Input, type Br42Input, type Br43Input } from './register.rules';
export { commandResult, enqueueFreshness, nextAuditDate, orgOf, refOf, todayOf } from './command-support';
