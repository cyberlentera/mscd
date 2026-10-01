// Nest wiring of the pack installer (E.8, D-17): a lazily opened pool of role `mscd_pack_installer` (only the worker's
// `pack.install` and `packs.lifecycle` jobs use it; the api never opens it unless a job runs in its process) and the
// `PackInstaller` on it.
import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { AUDIT_WRITER, type AuditWriter } from '../../common/tokens';
import { MscdConfig } from '../../config/mscd-config';
import { createGuardedKysely, poolGuardMode } from '../../db/kysely';
import type { DB } from '../../db/types';
import { VERSION } from '../../generated/build-info';
import { TRUST_ANCHORS, type TrustAnchors } from '../license/trust-anchors';
import { PackInstaller } from './pack-installer';
import { verifyPackForServer } from './pack-verification';
import type { VerifiedPack } from '@mscd/pack-tools';

/** The pool of role `mscd_pack_installer`, opened on first use (D-17). */
@Injectable()
export class PackInstallerDatabase implements OnApplicationShutdown {
  private db: Kysely<DB> | null = null;

  constructor(private readonly config: MscdConfig) {}

  get(): Kysely<DB> {
    if (!this.db) {
      this.db = createGuardedKysely<DB>({
        connectionString: this.config.databaseUrl('pack_installer'),
        max: 2,
        applicationName: `mscd-${this.config.runMode}-packs`,
        guardMode: poolGuardMode(this.config),
      }).db;
    }
    return this.db;
  }

  async onApplicationShutdown(): Promise<void> {
    const db = this.db;
    this.db = null;
    await db?.destroy();
  }
}

@Injectable()
export class PackInstallService {
  private readonly logger = new Logger('PackInstaller');
  private installer: PackInstaller | null = null;

  constructor(
    private readonly database: PackInstallerDatabase,
    @Inject(TRUST_ANCHORS) private readonly trust: TrustAnchors,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  /** E.8 steps 1 to 3 with the compiled trust anchors; no database access. */
  verify(bytes: Buffer): VerifiedPack {
    return verifyPackForServer(bytes, this.trust, VERSION);
  }

  /** The installer on the pack installer pool. */
  get(): PackInstaller {
    this.installer ??= new PackInstaller({
      db: this.database.get(),
      audit: this.audit,
      trust: this.trust,
      serverVersion: VERSION,
      logger: { warn: (message) => this.logger.warn(message) },
    });
    return this.installer;
  }
}
