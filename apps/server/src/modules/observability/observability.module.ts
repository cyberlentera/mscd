import { Global, Module } from '@nestjs/common';
import { HttpObservability, LogRingTap, ObservabilityMetrics, TelemetryService } from './observability.service';

/**
 * Metric definitions and the OpenTelemetry bootstrap (ARCHITECTURE 12, WP-34): the catalogue metrics on the
 * registry of the process, the HTTP request metric and server spans, the log ring buffer of the diagnostics
 * archive. Loaded by api, worker and storage-gateway, so it must not depend on the database; the metrics read from
 * the database are collected by the ops module.
 */
@Global()
@Module({
  providers: [ObservabilityMetrics, TelemetryService, HttpObservability, LogRingTap],
  exports: [ObservabilityMetrics, TelemetryService],
})
export class ObservabilityModule {}
