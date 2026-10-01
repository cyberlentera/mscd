// The organisation snapshot (build plan G.5, D.2 `UiOrgSnapshot`) before `ScopePolicy.filterOrgSnapshot` (F.7):
// systems, people, storage, packs, licence, stages, chains, titles, clauses at risk, evidence examples and the
// frequencies of the organisation's systems.
import type { ChainInstance, LicenceCard, ManagementSystem, Organisation, PackCard, PermissionSet, RepoRow, RolesMap, RoutingRow, Stage, UiOrgSnapshot } from '@mscd/shared';
import { frequencyTable, locEntry, packCard, routingRow } from '../derive/org-formats';
import type { OrgData, SystemCore } from '../load/loader';
import { stageRecords, systemFields, systemStages } from './system';

/** A member holding a business role (G.5 `PEOPLE`). */
export interface PersonRow {
  handle: string;
  displayName: string;
  jobTitle: string | null;
}

/** A repository row for `LOC` (every repository of the organisation). */
export interface LocRepository {
  slug: string;
  name: string;
  adapter: Parameters<typeof locEntry>[0]['adapter'];
  ownershipType: Parameters<typeof locEntry>[0]['ownershipType'];
  display: Record<string, unknown>;
}

export interface OrgSnapshotInput {
  today: string;
  generatedAt: string;
  timeZone: string;
  orgs: Organisation[];
  roles: RolesMap;
  permissions: PermissionSet;
  people: readonly PersonRow[];
  repositories: readonly LocRepository[];
  /** `REPOS` (empty without `storage.repository.read`). */
  repos: RepoRow[];
  /** Whether `ROUTING` is shown (`storage.repository.read`). */
  routing: boolean;
  /** Whether `PACKS` entries are shown (`pack.read`). */
  packs: boolean;
  licence: LicenceCard | null;
}

/** G.5 `TITLES`: titles of the chain records by code (codes are unique per organisation within a table). */
export function recordTitles(systems: readonly Pick<SystemCore, 'records'>[]): Record<string, string> {
  const titles: Record<string, string> = {};
  for (const system of systems) for (const r of system.records) titles[r.code] ??= r.title;
  return titles;
}

/** G.5 `CLAUSE_AT_RISK`: the clause at risk of each stage key; the first system in position order wins. */
export function clausesAtRisk(systems: readonly Pick<SystemCore, 'stages'>[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const system of systems) for (const stage of system.stages) if (stage.clauseAtRisk && !(stage.key in out)) out[stage.key] = stage.clauseAtRisk;
  return out;
}

/** G.5 `EXAMPLES`: evidence examples by requirement key; the first system in position order wins. */
export function evidenceExamples(systems: readonly Pick<SystemCore, 'examples'>[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const system of systems) for (const [key, example] of Object.entries(system.examples)) out[key] ??= example;
  return out;
}

export function buildOrgSnapshot(data: OrgData, input: OrgSnapshotInput): UiOrgSnapshot {
  const MS: ManagementSystem[] = [];
  const STAGES: Record<string, Stage[]> = {};
  const CHAINS: Record<string, ChainInstance[]> = {};
  const PACKS: Record<string, PackCard> = {};
  const ROUTING: RoutingRow[] = [];
  for (const system of data.systems) {
    MS.push(systemFields(system, input.today));
    STAGES[system.slug] = systemStages(system);
    CHAINS[system.slug] = system.chains.map((c) => ({ id: c.id, nodes: c.nodes.map(([stage, code]) => [stage, code] as [string, string | null]) }));
    if (input.packs) {
      PACKS[system.slug] = packCard({
        active: system.active,
        target: system.target,
        installed: data.frameworkVersions.filter((v) => v.frameworkCode === system.active.frameworkCode),
        catalog: data.catalog,
        timeZone: input.timeZone,
      });
    }
    if (input.routing && system.defaultRoute) {
      ROUTING.push(
        routingRow({
          msCode: system.code,
          repositoryName: system.defaultRoute.repositoryName,
          mode: system.defaultRoute.mode,
          note: system.defaultRoute.note,
          displayNote: system.display.routingNote,
        }),
      );
    }
  }
  const PEOPLE: UiOrgSnapshot['PEOPLE'] = {};
  for (const person of input.people) PEOPLE[person.handle] = [person.displayName, person.jobTitle || '-'];
  PEOPLE.none = ['Unassigned', '-'];
  const LOC: UiOrgSnapshot['LOC'] = {};
  for (const repo of input.repositories) LOC[repo.slug] = locEntry(repo);
  const { FREQ, FREQ_ORDER } = frequencyTable(data.systems.flatMap((s) => s.frequencies));
  return {
    today: input.today,
    generatedAt: input.generatedAt,
    orgs: input.orgs,
    MS,
    PEOPLE,
    ROLES: input.roles,
    LOC,
    REPOS: input.repos,
    ROUTING,
    PACKS,
    LICENCE: input.licence,
    STAGES,
    CHAINS,
    TITLES: recordTitles(data.systems),
    CLAUSE_AT_RISK: clausesAtRisk(data.systems),
    EXAMPLES: evidenceExamples(data.systems),
    FREQ,
    FREQ_ORDER,
    permissions: input.permissions,
  };
}

/** Requirement keys of `EXAMPLES` per system (`ScopePolicy.filterOrgSnapshot` sources). */
export function exampleKeysByMs(systems: readonly Pick<SystemCore, 'slug' | 'examples'>[]): Record<string, string[]> {
  return Object.fromEntries(systems.map((s) => [s.slug, Object.keys(s.examples)]));
}

/** Codes of the chain records of a stage that a person holds (helper for owner-scoped chains). */
export function heldRecordCodes(system: SystemCore, handle: string): Set<string> {
  const codes = new Set<string>();
  for (const stage of system.stages) {
    for (const r of stageRecords(system, stage)) {
      if (r.holder !== handle) continue;
      codes.add(r.code);
      for (const c of [...r.up, ...r.down]) codes.add(c);
    }
  }
  return codes;
}
