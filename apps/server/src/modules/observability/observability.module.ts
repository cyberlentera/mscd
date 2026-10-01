import { Module } from '@nestjs/common';

/** Metric definitions and the OpenTelemetry bootstrap; also loaded by storage-gateway, so it must not depend on the database. Built by WP-34. */
@Module({})
export class ObservabilityModule {}
