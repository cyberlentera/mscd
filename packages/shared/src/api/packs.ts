// Area `packs` (owner from wave 5: WP-12): installed framework packs, offline import and update checks (D.2
// `PackSummary`, D.3, E.8, D-17).
import { z } from 'zod';
import { PackInstallStatus } from '../enums.js';
import { BinaryBody, CommandResult, Instant, IsoDate, Pair, commandResultWith, defineRoute, named } from './common.js';
import type { RouteDef } from './common.js';

/** Largest pack bundle the import accepts (F.12: 50 MiB). */
export const MAX_PACK_IMPORT_BYTES = 50 * 1024 * 1024;

export const PackSummary = named(
  'PackSummary',
  z.object({
    packId: z.string(), version: z.string(), frameworkCode: z.string(), edition: z.string(), status: PackInstallStatus, preRelease: z.boolean(),
    installedAt: Instant.nullable(), checksum: z.string().regex(/^[0-9a-f]{64}$/), signatureKeyId: z.string(),
  }),
  'Installed pack (platform.pack_install)',
  {
    valid: [{ packId: 'ISO27001-2022', version: '1.2.0', frameworkCode: 'ISO27001', edition: '2022', status: 'installed', preRelease: false, installedAt: '2026-02-02T03:00:00Z', checksum: 'ab'.repeat(32), signatureKeyId: '0a1b2c3d4e5f6789' }],
    invalid: [{ packId: 'ISO27001-2022', version: '1.2.0', frameworkCode: 'ISO27001', edition: '2022', status: 'active', preRelease: false, installedAt: null, checksum: 'x', signatureKeyId: 'k' }],
  },
);
export type PackSummary = z.infer<typeof PackSummary>;

export const PackImportForm = named('PackImportForm', z.object({ bundle: BinaryBody }), 'POST /admin/packs/import multipart form: the signed .pack file in field bundle (at most 50 MiB)', {
  valid: [{ bundle: new Uint8Array([0x1f, 0x8b]) }],
  invalid: [{}, { bundle: 'not bytes' }],
});

export const PackUpdate = named(
  'PackUpdate',
  z.object({ packId: z.string(), version: z.string(), note: Pair, publishedAt: IsoDate.nullable() }),
  'A newer pack version offered by the update channel',
  { valid: [{ packId: 'ISO9001-2026', version: '1.0.0', note: ['Subclause numbering verified against published text', 'Penomoran subklausul diverifikasi terhadap teks terbitan'], publishedAt: '2026-09-25' }], invalid: [{ packId: 'x', version: '1', note: 'x' }] },
);
export type PackUpdate = z.infer<typeof PackUpdate>;

export const CheckUpdatesResult = named(
  'CheckUpdatesResult',
  commandResultWith(z.object({ available: z.array(PackUpdate) })),
  'Result of an update check; nothing is stored (D.3)',
  { valid: [{ ok: true, changed: [], message: ['2 updates available', '2 pembaruan tersedia'], data: { available: [] } }], invalid: [{ ok: true, changed: [] }] },
);
export type CheckUpdatesResult = z.infer<typeof CheckUpdatesResult>;

export const packsListRoute = defineRoute({
  id: 'admin.packs.list',
  owner: 'WP-12',
  method: 'GET',
  path: '/api/v1/admin/packs',
  summary: 'Installed packs',
  auth: 'session',
  permission: 'pack.read',
  scope: 'org',
  response: z.array(PackSummary),
  errors: [],
});

export const packsImportRoute = defineRoute({
  id: 'admin.packs.import',
  owner: 'WP-12',
  method: 'POST',
  path: '/api/v1/admin/packs/import',
  summary: 'Import a signed pack bundle (Tenant Admin with tenancy.mode single, platform operator with multi); queues pack.install',
  auth: 'session',
  permission: 'pack.install',
  scope: 'org',
  body: PackImportForm,
  requestType: 'multipart/form-data',
  response: CommandResult,
  status: 202,
  errors: [413, 422],
  idempotent: true,
});

export const packsCheckUpdatesRoute = defineRoute({
  id: 'admin.packs.check-updates',
  owner: 'WP-12',
  method: 'POST',
  path: '/api/v1/admin/packs/check-updates',
  summary: 'Ask the update channel for newer pack versions (409 on the offline channel)',
  auth: 'session',
  permission: 'pack.read',
  scope: 'org',
  response: CheckUpdatesResult,
  errors: [409, 503],
});

export const routes: RouteDef[] = [packsListRoute, packsImportRoute, packsCheckUpdatesRoute];
