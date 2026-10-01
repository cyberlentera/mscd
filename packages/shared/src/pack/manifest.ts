// Pack manifest (E.8): `manifest.json` of a pack source folder (without `datasets`) and of a built pack archive
// (with `datasets`, the SHA-256 of every dataset file).
import { z } from 'zod';
import { ApplicabilityTarget, FrameworkVersionStatus } from '../enums.js';
import { IsoDate, named } from '../api/common.js';

export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

export const SemVer = named('SemVer', z.string().max(20).regex(SEMVER_RE), 'Semantic version MAJOR.MINOR.PATCH with an optional pre-release suffix', {
  valid: ['1.2.0', '0.9.0', '1.0.0-rc.1'],
  invalid: ['1.2', 'v1.2.0', '01.2.0'],
});
export type SemVer = z.infer<typeof SemVer>;

/**
 * Compares two semantic versions (`-1`, `0`, `1`). A pre-release sorts before its release; pre-release identifiers
 * compare numerically when both are numbers, else as text (semver 2.0.0 rule 11).
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = SEMVER_RE.exec(a);
  const pb = SEMVER_RE.exec(b);
  if (!pa || !pb) throw new Error(`Not a semantic version: ${!pa ? a : b}`);
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  const preA = a.includes('-') ? a.slice(a.indexOf('-') + 1).split('.') : [];
  const preB = b.includes('-') ? b.slice(b.indexOf('-') + 1).split('.') : [];
  if (preA.length === 0 || preB.length === 0) return preA.length === preB.length ? 0 : preA.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(preA.length, preB.length); i += 1) {
    const x = preA[i];
    const y = preB[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) < Number(y) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export const FrameworkCode = named('FrameworkCode', z.string().regex(/^[A-Z][A-Z0-9]{1,19}$/), 'Framework code (ref.framework.code), for example ISO27001', {
  valid: ['ISO27001', 'ISO9001'],
  invalid: ['iso27001', 'ISO 27001', 'I'],
});
export type FrameworkCode = z.infer<typeof FrameworkCode>;

export const PackId = named('PackId', z.string().max(40).regex(/^[A-Z][A-Z0-9]{1,19}-[A-Za-z0-9.]{1,19}$/), 'Pack id <framework_code>-<edition>, for example ISO27001-2022', {
  valid: ['ISO27001-2022', 'ISO37001-2025'],
  invalid: ['ISO27001', 'iso27001-2022', 'ISO27001_2022'],
});
export type PackId = z.infer<typeof PackId>;

export const PackEdition = named('PackEdition', z.string().regex(/^[A-Za-z0-9.]{1,20}$/), 'Framework edition (ref.framework_version.edition), for example 2022', {
  valid: ['2022', '2015'],
  invalid: ['', '2022 ed', 'a'.repeat(21)],
});
export type PackEdition = z.infer<typeof PackEdition>;

/** Every dataset file of a pack besides `manifest.json` (E.8), in E.8 order; `mappings/*.csv` files are optional. */
export const PACK_DATASET_FILES = [
  'requirements.csv', 'catalogue.csv', 'chain.csv', 'activities.csv', 'frequencies.csv', 'labels.en.json', 'labels.id.json',
  'cycle_requirements.csv', 'drift_rules.json', 'prep_tasks.csv', 'review_inputs.csv', 'finding_conditions.csv',
  'document_templates.csv', 'audit_activities.csv', 'lookups.csv', 'rules.json', 'risk_profiles.json',
] as const;
export type PackDatasetFile = (typeof PACK_DATASET_FILES)[number];

/** Name of an optional mapping dataset (`mappings/<name>.csv`). */
export const MAPPING_FILE_RE = /^mappings\/[A-Za-z0-9][A-Za-z0-9._-]*\.csv$/;

const manifestShape = {
  pack_id: PackId,
  pack_version: SemVer,
  framework_code: FrameworkCode,
  framework_name: z.string().min(1).max(150),
  edition: PackEdition,
  status: FrameworkVersionStatus,
  pre_release: z.boolean(),
  supersedes: z.strictObject({ edition: PackEdition, transition_ends: IsoDate }).optional(),
  engine_min_version: SemVer,
  modules: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/)),
  applicability_target: ApplicabilityTarget,
  catalogue: z.boolean(),
};

function packIdMatches(m: { pack_id: string; framework_code: string; edition: string }): boolean {
  return m.pack_id === `${m.framework_code}-${m.edition}`;
}
const PACK_ID_MESSAGE = { message: 'pack_id must equal <framework_code>-<edition>', path: ['pack_id'] };

const EXAMPLE_SOURCE_MANIFEST = {
  pack_id: 'ISO9001-2026', pack_version: '0.9.0', framework_code: 'ISO9001', framework_name: 'ISO 9001', edition: '2026',
  status: 'current', pre_release: false, supersedes: { edition: '2015', transition_ends: '2029-09-15' }, engine_min_version: '1.0.0',
  modules: [], applicability_target: 'requirement', catalogue: false,
} as const;

export const PackSourceManifest = named(
  'PackSourceManifest',
  z.strictObject(manifestShape).refine(packIdMatches, PACK_ID_MESSAGE),
  'manifest.json of a pack source folder: every field except datasets, which the builder fills (E.8, WP-04)',
  {
    valid: [EXAMPLE_SOURCE_MANIFEST, { ...EXAMPLE_SOURCE_MANIFEST, pack_id: 'ISO27001-2022', framework_code: 'ISO27001', edition: '2022', supersedes: undefined, catalogue: true, applicability_target: 'catalogue_item' }],
    invalid: [
      { ...EXAMPLE_SOURCE_MANIFEST, pack_id: 'ISO9001-2015' },
      { ...EXAMPLE_SOURCE_MANIFEST, datasets: {} },
      { ...EXAMPLE_SOURCE_MANIFEST, status: 'beta' },
      { ...EXAMPLE_SOURCE_MANIFEST, pack_version: '0.9' },
    ],
  },
);
export type PackSourceManifest = z.infer<typeof PackSourceManifest>;

export const DatasetChecksum = named('DatasetChecksum', z.string().regex(/^sha256:[0-9a-f]{64}$/), 'Checksum of a dataset file: sha256:<64 lowercase hex>', {
  valid: ['sha256:' + 'ab'.repeat(32)],
  invalid: ['sha256:' + 'AB'.repeat(32), 'md5:abc', 'ab'.repeat(32)],
});

export const PackManifest = named(
  'PackManifest',
  z.strictObject({
    ...manifestShape,
    datasets: z.record(z.string().regex(/^(?:[a-z_]+(?:\.[a-z]{2})?\.(?:csv|json)|mappings\/[A-Za-z0-9][A-Za-z0-9._-]*\.csv)$/), DatasetChecksum),
  }).refine(packIdMatches, PACK_ID_MESSAGE),
  'manifest.json of a built pack archive, with the checksum of every dataset file (E.8)',
  {
    valid: [{ ...EXAMPLE_SOURCE_MANIFEST, datasets: { 'requirements.csv': 'sha256:' + '0f'.repeat(32), 'labels.en.json': 'sha256:' + '1e'.repeat(32), 'mappings/ISO9001-2015.csv': 'sha256:' + '2d'.repeat(32) } }],
    invalid: [EXAMPLE_SOURCE_MANIFEST, { ...EXAMPLE_SOURCE_MANIFEST, datasets: { '../etc/passwd': 'sha256:' + '0f'.repeat(32) } }],
  },
);
export type PackManifest = z.infer<typeof PackManifest>;
