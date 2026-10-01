// Diagnostics archive of the platform operator (D.3 `POST /ops/diagnostics`, ARCHITECTURE 12, PRD 10.1): a
// `.tar.gz` the customer reviews before sending it to support. It holds the profile without secrets, versions,
// migration state, queue statistics, installation health, the last 1,000 log lines of the ring buffer (already
// redacted by pino, F.12) and a metric snapshot. Every file is scrubbed once more by `SecretScrubber`.
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Injectable } from '@nestjs/common';
import { writeTar } from '@mscd/pack-tools';
import { MscdConfig } from '../../config/mscd-config';
import { BUILD_FLAVOR, MIGRATIONS_BY_FOLDER, REVISION, VERSION } from '../../generated/build-info';
import { LOG_RING, type LogRing } from '../observability/log-ring';
import { MetricsService } from '../platform/metrics';
import { OpsService } from './ops.service';
import { SecretScrubber } from './secret-scrubber';

export interface DiagnosticsArchive {
  fileName: string;
  /** The gzip-compressed tar archive. */
  data: Buffer;
  /** Paths inside the archive. */
  files: string[];
  logLines: number;
  sha256: string;
}

/** Credentials in URLs never leave the process, even before the scrubber runs. */
function withoutUrlCredentials(value: unknown): unknown {
  if (typeof value === 'string') {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
    try {
      const url = new URL(value);
      if (url.password || url.username) {
        url.password = '';
        url.username = '';
        return url.toString();
      }
    } catch {
      // Not a URL after all.
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(withoutUrlCredentials);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, withoutUrlCredentials(v)]));
  }
  return value;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Runs a part of the archive; a failing part becomes an `{error}` file instead of failing the export. */
async function part(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

@Injectable()
export class DiagnosticsService {
  /** The ring buffer the archive reads (tests replace it). */
  ring: LogRing = LOG_RING;

  constructor(
    private readonly config: MscdConfig,
    private readonly ops: OpsService,
    private readonly metrics: MetricsService,
  ) {}

  async build(now: Date = new Date()): Promise<DiagnosticsArchive> {
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const folder = `mscd-diagnostics-${stamp}`;
    const scrubber = SecretScrubber.forConfig(this.config);
    const logLines = this.ring.lines();

    const [health, queues, migrations, metricsText] = await Promise.all([
      part(() => this.ops.health()),
      part(() => this.ops.queues()),
      part(() => this.ops.migrations()),
      this.metrics.registry.metrics().catch((error: unknown) => `# metrics unavailable: ${error instanceof Error ? error.message : String(error)}\n`),
    ]);

    const contents: { name: string; text: string }[] = [
      {
        name: 'README.txt',
        text: [
          'MSCD diagnostics archive',
          '',
          `Created ${now.toISOString()} by run mode ${this.config.runMode} of mscd-server ${VERSION}.`,
          'Review every file before you send this archive to support. It contains no secret values: the profile',
          'names secret files but not their contents, log lines were redacted when they were written and the',
          'whole archive was scrubbed of the configured secret values, passwords in URLs and token query values.',
          '',
          'profile.json      deployment profile (secrets removed)',
          'versions.json     server, build and runtime versions',
          'migrations.json   newest applied and expected migration per schema',
          'queues.json       job queue statistics',
          'health.json       installation health as GET /api/v1/ops/health reports it',
          `logs.ndjson       the last ${logLines.length} log lines of this process (at most ${this.ring.capacity})`,
          'metrics.txt       Prometheus metric snapshot of this process',
          '',
        ].join('\n'),
      },
      { name: 'profile.json', text: json({ file: this.config.profileFile, profile: withoutUrlCredentials(this.config.profile) }) },
      {
        name: 'versions.json',
        text: json({
          server: VERSION,
          revision: REVISION,
          flavor: BUILD_FLAVOR,
          runMode: this.config.runMode,
          deploy: this.config.deploy,
          node: process.version,
          platform: `${process.platform} ${process.arch}`,
          uptimeSeconds: Math.round(process.uptime()),
          migrationsInBuild: MIGRATIONS_BY_FOLDER,
        }),
      },
      { name: 'migrations.json', text: json(migrations) },
      { name: 'queues.json', text: json(queues) },
      { name: 'health.json', text: json(health) },
      { name: 'logs.ndjson', text: logLines.length > 0 ? `${logLines.join('\n')}\n` : '' },
      { name: 'metrics.txt', text: metricsText },
    ];

    const entries = contents.map((c) => ({ path: `${folder}/${c.name}`, data: Buffer.from(scrubber.scrub(c.text), 'utf8') }));
    const tar = writeTar([{ path: `${folder}/`, type: 'directory' }, ...entries], { mtime: now });
    const data = gzipSync(tar);
    return {
      fileName: `${folder}.tar.gz`,
      data,
      files: entries.map((e) => e.path),
      logLines: logLines.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    };
  }
}
