import { Logger } from '@nestjs/common';
import type { Command } from 'commander';
import { ApiModule } from '../app/api.module';
import { exitOnConfigError, loadConfigOrExit } from '../config/run-context';
import { BUILD_FLAVOR, VERSION } from '../generated/build-info';
import { createHttpApplication } from '../modules/platform/http-app';

/** Run mode `api` (D.4): every `/api/v1` route on `http.port`, metrics on `observability.metrics_port`. */
export function register(program: Command): void {
  program
    .command('api')
    .description('Run the HTTP API (port http.port; health, readiness and metrics included)')
    .action(runApi);
}

export async function runApi(): Promise<void> {
  const config = loadConfigOrExit('api');
  const app = await createHttpApplication(ApiModule.forRoot(config), config).catch(exitOnConfigError);
  const { port } = config.profile.http;
  await app.listen(port, '0.0.0.0');
  new Logger('api').log(
    `MSCD api ${VERSION} (${BUILD_FLAVOR} build) listening on port ${port} with profile ${config.profileFile}`,
  );
}
