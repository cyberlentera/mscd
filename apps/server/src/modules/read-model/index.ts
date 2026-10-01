// What other modules use from the read model (B.4: modules import exported services and pure functions, never
// internals). Commands (WP-20) and jobs (WP-22, WP-23) share the E.3 and drift derivations with the read model.
export { ReadModelModule } from './read-model.module';
export { ReadModelService } from './read-model.service';
export * from './derive/freshness';
export * from './derive/integrity';
export * from './derive/drift';
export * from './derive/tasks';
export * from './derive/portfolio';
export * from './derive/overview';
export { chainItemStatus, dueAfterAudit, deriveChain } from './derive/chain';
export { deriveGateItems } from './derive/gates';
export { derivePhases, currentPhaseNo, phaseVerified } from './derive/phases';
export { buildSystemSnapshot, systemFields, systemStages, stageRecords, stageRecordCount } from './build/system';
export { loadOrgData, loadOpenTasks, type OrgData, type SystemData, type SystemCore } from './load/loader';
