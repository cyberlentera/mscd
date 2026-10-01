import type { Type } from '@nestjs/common';
import { AdminIdpModule } from '../modules/admin-idp/admin-idp.module';
import { AdminUsersModule } from '../modules/admin-users/admin-users.module';
import { AuditModule } from '../modules/audit/audit.module';
import { AuditRegistersModule } from '../modules/audit-registers/audit-registers.module';
import { AuditorAccessModule } from '../modules/auditor-access/auditor-access.module';
import { AuthzModule } from '../modules/authz/authz.module';
import { DriftModule } from '../modules/drift/drift.module';
import { EvidencePacksModule } from '../modules/evidence-packs/evidence-packs.module';
import { ExportsModule } from '../modules/exports/exports.module';
import { FilesModule } from '../modules/files/files.module';
import { FreshnessModule } from '../modules/freshness/freshness.module';
import { IdentityModule } from '../modules/identity/identity.module';
import { ImplementationModule } from '../modules/implementation/implementation.module';
import { IntegrityModule } from '../modules/integrity/integrity.module';
import { JobsModule } from '../modules/jobs/jobs.module';
import { KeysModule } from '../modules/keys/keys.module';
import { LicenseModule } from '../modules/license/license.module';
import { LinkHealthModule } from '../modules/link-health/link-health.module';
import { ManagementSystemsModule } from '../modules/management-systems/management-systems.module';
import { NotificationsModule } from '../modules/notifications/notifications.module';
import { ObservabilityModule } from '../modules/observability/observability.module';
import { OpsModule } from '../modules/ops/ops.module';
import { PacksModule } from '../modules/packs/packs.module';
import { ReadModelModule } from '../modules/read-model/read-model.module';
import { ReadModelApiModule } from '../modules/read-model-api/read-model-api.module';
import { RegistersModule } from '../modules/registers/registers.module';
import { RemindersModule } from '../modules/reminders/reminders.module';
import { RiskRegistersModule } from '../modules/risk-registers/risk-registers.module';
import { RulesModule } from '../modules/rules/rules.module';
import { StorageModule } from '../modules/storage/storage.module';
import { TenancyModule } from '../modules/tenancy/tenancy.module';
import { TestSupportModule } from '../modules/test-support/test-support.module';
import { UiModule } from '../modules/ui/ui.module';

/**
 * Business and infrastructure modules of the api and worker run modes (B.4, D.4). Every module of
 * `src/modules` except `platform` (configured per run mode) is listed here, so later work packages add
 * providers, controllers and job handlers inside their own module and never edit the app modules.
 */
const CORE_MODULES: readonly Type<unknown>[] = [
  TenancyModule,
  AuditModule,
  KeysModule,
  IdentityModule,
  AuthzModule,
  LicenseModule,
  PacksModule,
  ManagementSystemsModule,
  StorageModule,
  JobsModule,
  ObservabilityModule,
];

const DOMAIN_MODULES: readonly Type<unknown>[] = [
  AdminUsersModule,
  AdminIdpModule,
  FilesModule,
  ReadModelModule,
  RulesModule,
  ImplementationModule,
  RegistersModule,
  RemindersModule,
  RiskRegistersModule,
  AuditRegistersModule,
  FreshnessModule,
  LinkHealthModule,
  DriftModule,
  IntegrityModule,
  NotificationsModule,
  ExportsModule,
  EvidencePacksModule,
  AuditorAccessModule,
  OpsModule,
];

/** Modules that only serve HTTP reads or test routes; the worker does not load them. */
const API_ONLY_MODULES: readonly Type<unknown>[] = [UiModule, ReadModelApiModule, TestSupportModule];

/** Run mode `api`: every route of `/api/v1` (D.4). */
export const API_FEATURE_MODULES: readonly Type<unknown>[] = [...CORE_MODULES, ...DOMAIN_MODULES, ...API_ONLY_MODULES];

/** Run mode `worker`: every module that holds job handlers or the services they use (E.1, E.2). */
export const WORKER_FEATURE_MODULES: readonly Type<unknown>[] = [...CORE_MODULES, ...DOMAIN_MODULES];
