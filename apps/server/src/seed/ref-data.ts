// Framework content the demo seed needs from `ref` (installed packs, D-14): the framework versions of the demo
// systems and the rows the seeded records point at.
import type { Kysely } from 'kysely';
import type { DB } from '../db/types';
import type { ChainStageDef, DriftRuleDef } from './plan';

/** Packs of each demo system: the active edition first, then a transition target (G.7, D-14). */
export const SYSTEM_PACKS: Readonly<Record<string, { active: string; target?: string }>> = {
  isms: { active: 'ISO27001-2022' },
  qms: { active: 'ISO9001-2015', target: 'ISO9001-2026' },
  bcms: { active: 'ISO22301-2019' },
  abms: { active: 'ISO37001-2025' },
};

/** Every pack of the demo (D-14), including the withdrawn ISO 37001:2016 shown on the ABMS pack card. */
export const DEMO_PACK_IDS = ['ISO27001-2022', 'ISO9001-2026', 'ISO9001-2015', 'ISO22301-2019', 'ISO37001-2025', 'ISO37001-2016'] as const;

export interface FrameworkVersionRef {
  id: string;
  packId: string;
  packVersion: string;
  edition: string;
  status: 'current' | 'transition' | 'withdrawn';
  applicabilityTarget: 'catalogue_item' | 'requirement';
}

export interface ActivityTemplateRef {
  id: string;
  phaseNo: number;
  activityNo: number;
  title: string;
  clauseRef: string | null;
  outputDocumentCode: string | null;
  expectedOutcome: string | null;
  isGatePhase: boolean;
}

export interface VersionContent {
  version: FrameworkVersionRef;
  /** Catalogue items by item code (`A.5.1`), in sort order. */
  catalogue: Map<string, string>;
  /** Requirements by requirement code (`4.1`), in sort order. */
  requirements: Map<string, string>;
  stages: ChainStageDef[];
  drift: (DriftRuleDef & { id: string })[];
  /** Activity templates by `<phase>.<activity>`. */
  activities: Map<string, ActivityTemplateRef>;
  prepTemplates: { code: string; title: string }[];
  cycleDefs: { id: string; code: string; title: string; requirementCode: string | null }[];
  /** `doc_type` lookup codes by English label (`Policy` gives `policy`). */
  docTypes: Map<string, string>;
  frequencies: Set<string>;
}

/** Loads the installed version of a pack and its content. Throws when the pack is not installed. */
export async function loadVersionContent(db: Kysely<DB>, packId: string): Promise<VersionContent> {
  const row = await db
    .selectFrom('ref.framework_version')
    .select(['id', 'pack_id', 'pack_version', 'edition', 'status', 'applicability_target'])
    .where('pack_id', '=', packId)
    .executeTakeFirst();
  if (!row) throw new Error(`Pack ${packId} is not installed (run node tools/scripts/ensure-built.mjs, then seed demo again)`);
  const id = row.id;
  const [catalogue, requirements, stages, drift, activities, prep, cycle, lookups, frequencies] = await Promise.all([
    db.selectFrom('ref.catalogue_item').select(['id', 'item_code']).where('framework_version_id', '=', id).orderBy('sort_order').execute(),
    db.selectFrom('ref.requirement').select(['id', 'requirement_code']).where('framework_version_id', '=', id).orderBy('sort_order').execute(),
    db
      .selectFrom('ref.traceability_chain_def')
      .select(['stage_key', 'position', 'source', 'entity_type', 'risk_profile_code'])
      .where('framework_version_id', '=', id)
      .orderBy('position')
      .execute(),
    db.selectFrom('ref.drift_rule_def').select(['id', 'code', 'source_stage', 'source_kind']).where('framework_version_id', '=', id).orderBy('sort_order').execute(),
    db
      .selectFrom('ref.activity_template')
      .select(['id', 'phase_no', 'activity_no', 'title', 'clause_ref', 'output_document_code', 'expected_outcome', 'is_gate_phase'])
      .where('framework_version_id', '=', id)
      .execute(),
    db.selectFrom('ref.prep_task_template').select(['code', 'title']).where('framework_version_id', '=', id).orderBy('sort_order').execute(),
    db
      .selectFrom('ref.cycle_requirement_def')
      .select(['id', 'code', 'title', 'requirement_code'])
      .where('framework_version_id', '=', id)
      .orderBy('sort_order')
      .execute(),
    db.selectFrom('ref.lookup_value').select(['code', 'label_en']).where('framework_version_id', '=', id).where('domain', '=', 'doc_type').execute(),
    db.selectFrom('ref.evidence_frequency_rule').select(['code']).where('framework_version_id', '=', id).execute(),
  ]);
  return {
    version: {
      id,
      packId: row.pack_id,
      packVersion: row.pack_version,
      edition: row.edition,
      status: row.status,
      applicabilityTarget: row.applicability_target,
    },
    catalogue: new Map(catalogue.map((c) => [c.item_code, c.id])),
    requirements: new Map(requirements.map((r) => [r.requirement_code, r.id])),
    stages: stages.map((s) => ({
      stageKey: s.stage_key,
      position: s.position,
      source: s.source,
      entityType: s.entity_type,
      riskProfileCode: s.risk_profile_code,
    })),
    drift: drift.map((d) => ({ id: d.id, code: d.code, sourceStage: d.source_stage, sourceKind: d.source_kind })),
    activities: new Map(
      activities.map((a) => [
        `${a.phase_no}.${a.activity_no}`,
        {
          id: a.id,
          phaseNo: a.phase_no,
          activityNo: a.activity_no,
          title: a.title,
          clauseRef: a.clause_ref,
          outputDocumentCode: a.output_document_code,
          expectedOutcome: a.expected_outcome,
          isGatePhase: a.is_gate_phase,
        },
      ]),
    ),
    prepTemplates: prep,
    cycleDefs: cycle.map((c) => ({ id: c.id, code: c.code, title: c.title, requirementCode: c.requirement_code })),
    docTypes: new Map(lookups.map((l) => [l.label_en, l.code])),
    frequencies: new Set(frequencies.map((f) => f.code)),
  };
}
