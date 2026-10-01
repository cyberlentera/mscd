// RecordResolver and ScopePolicy on fixture data (build plan D.1, D-04, D-34, F.7, G.5): records of another system
// and unknown entity types are 404; owner scoping keeps own records (counts untouched); classification hides
// restricted and confidential items from the right readers; the external auditor projection; file access through
// `canReadObject`; and the organisation snapshot filter.
import { UiMsSnapshot, UiOrgSnapshot, type Pair } from '@mscd/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError, NotFoundError } from '../../../src/common/problems';
import { RECORD_RESOLVER, SCOPE_POLICY, type Principal, type RecordResolver, type Trx } from '../../../src/common/tokens';
import { ScopePolicyService } from '../../../src/modules/authz/scope-policy';
import { TenantScope, tenantContextOf } from '../../../src/modules/tenancy/tenant-scope';
import { useTestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import { addOrg, addUser, createAuthzApp, grantRole, principalOf, type AuthzApp, type Org, type User } from './helpers';

const P: Pair = ['x', 'x'];

function ref(entityType: string, code: string) {
  return { module: 'implementation' as const, entityType, id: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b', code };
}

/** A small `GET /ui/ms/isms` snapshot whose records belong to `owner` (handle) or `other`. */
function snapshotOf(owner: string, other: string): UiMsSnapshot {
  const req = (id: string, who: string) => ({ id, key: id, title: `Control ${id}`, theme: 'A.5 Org', st: 'implemented' as const, owner: who, doc: 'DOC-1', freq: 'monthly', note: 'n', gate: false, just: '', risks: [], by: who });
  const doc = (id: string, who: string) => ({ id, title: `Doc ${id}`, tier: 'Policy', ver: '1.0', st: 'approved' as const, appr: '2026-01-01', rev: '2027-01-01', owner: who, shared: false, ms: 'isms', approver: other, path: '/Compliance/ISMS' });
  const ev = (code: string, who: string) => ({ code, ctrl: 'A.5.1', ctrlKey: '5.1', title: `Evidence ${code}`, freq: 'monthly', p: 30, prod: '2026-09-01', next: '2026-10-01', fresh: 'fresh' as const, integ: 'ok' as const, loc: 'vault', owner: who, ver: '1', hashAlg: 'SHA-256', path: '/Compliance/ISMS', hash: 'ab12' });
  const item = (key: string, kind: 'x' | 'doc' | 'ev', id: string, who: string) => ({ key, stage: 'risk', kind, id, title: P, act: P, h: who, due: '2026-10-20', st: 'pending' as const, after: false, gate: false, up: [], down: [], q: 'q' });
  const act = (no: string, who: string) => ({ key: `isms:act:${no}`, no, title: `Activity ${no}`, st: 'ns' as const, blocker: null, owner: who, out: null, docId: null, date: null, pno: 1 });
  const x = (id: string, who: string, up: string[] = []) => ({ id, t: `Risk ${id}`, act: 'Treat', h: who, due: '2026-10-20', up, down: [] });
  return {
    ms: 'isms',
    bundle: {
      reqs: [req('A.5.1', owner), req('A.5.2', other)],
      docs: [doc('DOC-1', owner), doc('DOC-R', owner), doc('DOC-C', other)],
      evs: [ev('EV-1', owner), ev('EV-2', other), ev('EV-3', other), ev('EV-R', other)],
      chain: { items: [item('isms:x:R-1', 'x', 'R-1', owner), item('isms:doc:DOC-C', 'doc', 'DOC-C', other), item('isms:x:R-2', 'x', 'R-2', other)], recs: { risk: 7 } },
      gates: [
        { id: 'R-1', type: ['Risk', 'Risiko'], why: P, h: owner, due: null, key: 'x:R-1' },
        { id: 'R-2', type: ['Risk', 'Risiko'], why: P, h: other, due: null, key: 'x:R-2' },
      ],
      phases: [{ no: 1, n: 'Phase 1', gate: false, acts: [act('4.1', owner), act('4.2', other)], total: 2, c: { verified: 0, complete: 0, progress: 0, blocked: 0, ns: 2, locked: 0 } }],
    },
    X: { risk: [x('R-1', owner, ['A.5.1']), x('R-2', other)] },
    EVENTS: [{ t: P, d: '2026-11-12', days: 2, next: true }],
    FOCUS: '-',
    PREP: [['Approve SoA', owner, '2026-10-15', 'open'], ['Book rooms', other, '2026-10-16', 'open']],
    PAST: [['NC-1', 'Minor', '8.8', 'Finding', 'open', '']],
    CYCLE_ITEMS: [['9.3', 'Review', owner, '2026-10-28', 'open', ''], ['9.2', 'Audit', other, '2026-10-28', 'open', '']],
    DRIFT: [
      { id: 'stale', l: P, rows: [['R-1', 'Risk R-1', owner, '2026-10-30'], ['R-2', 'Risk R-2', other, '2026-10-30']] },
      { id: 'unverif', l: P, src: 'unverif' },
    ],
    refs: {
      'isms:req:A.5.1': ref('applicability_entry', 'A.5.1'),
      'isms:soa:A.5.1': ref('applicability_entry', 'A.5.1'),
      'isms:req:A.5.2': ref('applicability_entry', 'A.5.2'),
      'isms:doc:DOC-1': ref('document', 'DOC-1'),
      'isms:doc:DOC-R': ref('document', 'DOC-R'),
      'isms:doc:DOC-C': ref('document', 'DOC-C'),
      'isms:ev:EV-1': ref('evidence', 'EV-1'),
      'isms:ev:EV-2': ref('evidence', 'EV-2'),
      'isms:ev:EV-3': ref('evidence', 'EV-3'),
      'isms:ev:EV-R': ref('evidence', 'EV-R'),
      'isms:x:R-1': ref('risk', 'R-1'),
      'isms:x:R-2': ref('risk', 'R-2'),
      'isms:act:4.1': ref('implementation_activity_progress', '4.1'),
      'isms:act:4.2': ref('implementation_activity_progress', '4.2'),
      'isms:prep:Approve SoA': ref('audit_prep_task', 'Approve SoA'),
      'isms:prep:Book rooms': ref('audit_prep_task', 'Book rooms'),
      'isms:cycle:9.3': ref('cycle_requirement_status', '9.3'),
      'isms:cycle:9.2': ref('cycle_requirement_status', '9.2'),
      'isms:drift:R-1': ref('drift_result', 'R-1'),
      'isms:drift:R-2': ref('drift_result', 'R-2'),
    },
  };
}

describe('WP-39 RecordResolver and ScopePolicy (D.1, D-04, D-34, F.7, G.5)', () => {
  const db = useTestDatabase('empty');
  let ctx: AuthzApp;
  let ndt: Org;
  let bsd: Org;
  let scope: TenantScope;
  let policy: ScopePolicyService;
  const u: Record<string, User> = {};
  const objects: Record<string, string> = {};
  const records: Record<string, string> = {};

  const inNdt = <T>(principal: Principal, fn: (trx: Trx) => Promise<T>) => scope.withTenant(tenantContextOf(principal), fn);

  beforeAll(async () => {
    ndt = await addOrg(db, 'ndt', ['isms', 'qms']);
    bsd = await addOrg(db, 'bsd', ['isms']);
    u.mm = await addUser(db, 'rina', [{ org: ndt }], { jobTitle: 'ISMS Manager' });
    u.owner = await addUser(db, 'bagus', [{ org: ndt }], { jobTitle: 'IT Lead' });
    u.ia = await addUser(db, 'maya', [{ org: ndt }]);
    u.tm = await addUser(db, 'hendra', [{ org: ndt }]);
    u.ea = await addUser(db, 'ext.auditor', [{ org: ndt }], { kind: 'guest' });
    u.qmsOnly = await addUser(db, 'sari', [{ org: ndt }]);
    u.ta = await addUser(db, 'tenant.admin', [{ org: ndt, adminRoles: ['tenant_admin'] }]);
    await grantRole(db, ndt, u.mm, 'isms', 'ms_manager');
    await grantRole(db, ndt, u.owner, 'isms', 'domain_owner');
    await grantRole(db, ndt, u.ia, 'isms', 'internal_auditor');
    await grantRole(db, ndt, u.tm, 'isms', 'top_management');
    await grantRole(db, ndt, u.ea, 'isms', 'external_auditor');
    await grantRole(db, ndt, u.qmsOnly, 'qms', 'ms_manager');

    await inScope(db.migrator, { orgId: ndt.tenant.id, schema: ndt.tenant.schemaName }, async (trx) => {
      const object = async (name: string) => {
        const row = await trx
          .insertInto('storage_object')
          .values({ storage_repository_id: ndt.tenant.vaultRepositoryId, external_item_id: `item-${name}`, hash_source: 'none', display_name: name })
          .returning('id')
          .executeTakeFirstOrThrow();
        objects[name] = row.id;
        return row.id;
      };
      const evidence = async (code: string, owner: User, classification: string, object: string) => {
        const row = await trx
          .insertInto('evidence')
          .values({ evidence_code: code, title: code, owner_user_id: owner.id, frequency_code: 'monthly', classification: classification as 'internal', storage_object_id: object })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx.insertInto('entity_ms_link').values({ entity_type: 'evidence', entity_id: row.id, management_system_id: ndt.systems.isms!, is_primary: true }).execute();
        records[code] = row.id;
        return row.id;
      };
      const document = async (code: string, owner: User, classification: string, object: string) => {
        const row = await trx
          .insertInto('document')
          .values({ doc_code: code, title: code, doc_type: 'policy', classification: classification as 'internal', owner_user_id: owner.id })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx.insertInto('entity_ms_link').values({ entity_type: 'document', entity_id: row.id, management_system_id: ndt.systems.isms!, is_primary: true }).execute();
        await trx.insertInto('document_version').values({ document_id: row.id, version_label: '1.0', storage_object_id: object, status: 'approved' }).execute();
        records[code] = row.id;
      };
      await evidence('EV-1', u.owner!, 'internal', await object('ev1'));
      await evidence('EV-2', u.mm!, 'confidential', await object('ev2'));
      await evidence('EV-3', u.mm!, 'internal', await object('ev3'));
      await evidence('EV-R', u.mm!, 'restricted', await object('evr'));
      await document('DOC-1', u.owner!, 'internal', await object('doc1'));
      await document('DOC-R', u.owner!, 'restricted', await object('docr'));
      await document('DOC-C', u.mm!, 'confidential', await object('docc'));
      const pack = await trx
        .insertInto('evidence_pack')
        .values({ management_system_id: ndt.systems.isms!, status: 'ready', manifest_pdf_object_id: await object('manifest') })
        .returning('id')
        .executeTakeFirstOrThrow();
      for (const [code, copy] of [['EV-2', 'ev2copy'], ['EV-R', 'evrcopy']] as const) {
        await trx
          .insertInto('evidence_pack_item')
          .values({ evidence_pack_id: pack.id, evidence_id: records[code]!, evidence_code: code, requirement_codes: ['A.5.1'], copy_storage_object_id: await object(copy) })
          .execute();
      }
      const building = await trx.insertInto('evidence_pack').values({ management_system_id: ndt.systems.isms!, status: 'building' }).returning('id').executeTakeFirstOrThrow();
      await trx
        .insertInto('evidence_pack_item')
        .values({ evidence_pack_id: building.id, evidence_id: records['EV-3']!, evidence_code: 'EV-3', requirement_codes: ['A.5.1'], copy_storage_object_id: await object('ev3copy') })
        .execute();
      const risk = await trx.insertInto('risk').values({ code: 'R-1', title: 'Risk', owner_user_id: u.owner!.id, risk_profile_code: 'default' }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('entity_ms_link').values({ entity_type: 'risk', entity_id: risk.id, management_system_id: ndt.systems.isms!, is_primary: true }).execute();
      records['R-1'] = risk.id;
    });
    ctx = await createAuthzApp(db);
    scope = ctx.moduleRef.get(TenantScope);
    policy = ctx.moduleRef.get(ScopePolicyService);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('provides the scope policy as SCOPE_POLICY', () => {
    expect(ctx.moduleRef.get(SCOPE_POLICY)).toBe(policy);
  });

  it('resolves records only in the system of the path; another system, another organisation and unknown types are 404 (D.1)', async () => {
    const resolver = ctx.moduleRef.get<RecordResolver>(RECORD_RESOLVER);
    const mm = principalOf(u.mm!, ndt);
    await inNdt(mm, async (trx) => {
      expect((await resolver.resolve(trx, 'isms', 'risk', records['R-1']!)).row.code).toBe('R-1');
      expect((await resolver.resolve(trx, 'isms', 'evidence', records['EV-1']!, { forUpdate: true })).ms.slug).toBe('isms');
      await expect(resolver.resolve(trx, 'qms', 'risk', records['R-1']!)).rejects.toBeInstanceOf(NotFoundError);
      await expect(resolver.resolve(trx, 'qms', 'document', records['DOC-1']!)).rejects.toBeInstanceOf(NotFoundError);
      await expect(resolver.resolve(trx, 'isms', 'platform_role', records['R-1']!)).rejects.toBeInstanceOf(NotFoundError);
      await expect(resolver.resolve(trx, 'isms', 'storage_credential', records['R-1']!)).rejects.toBeInstanceOf(NotFoundError);
      await expect(resolver.resolve(trx, 'isms', 'risk; drop table risk', records['R-1']!)).rejects.toBeInstanceOf(NotFoundError);
      await expect(resolver.resolve(trx, 'isms', 'risk', 'R-1')).rejects.toBeInstanceOf(NotFoundError);
      await expect(resolver.resolve(trx, 'nope', 'risk', records['R-1']!)).rejects.toBeInstanceOf(NotFoundError);
    });
    await scope.withTenant(tenantContextOf(principalOf(u.mm!, bsd)), async (trx) => {
      await expect(resolver.resolve(trx, 'isms', 'risk', records['R-1']!)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('derives the read scope from the roles in the system', async () => {
    const kinds: Record<string, string> = {};
    for (const key of ['mm', 'owner', 'ia', 'tm', 'ea'] as const) {
      const principal = principalOf(u[key]!, ndt);
      kinds[key] = await inNdt(principal, async (trx) => (await policy.readScope(trx, principal, 'isms', null)).kind);
    }
    expect(kinds).toEqual({ mm: 'full', owner: 'own', ia: 'full', tm: 'top_management', ea: 'external_auditor' });
    const qms = principalOf(u.qmsOnly!, ndt);
    await expect(inNdt(qms, (trx) => policy.readScope(trx, qms, 'isms', null))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(inNdt(qms, (trx) => policy.scopeContext(trx, qms, 'nope'))).rejects.toBeInstanceOf(NotFoundError);
    const owner = principalOf(u.owner!, ndt);
    const scoped = await inNdt(owner, (trx) => policy.readScope(trx, owner, 'isms', null));
    expect(policy.filter(scoped, [{ ownerUserId: u.owner!.id }, { ownerUserId: u.mm!.id }, { holderUserId: u.owner!.id }])).toHaveLength(2);
  });

  it('keeps only own records for an owner-scoped role, with counts as computed on the full data (D-04)', async () => {
    const owner = principalOf(u.owner!, ndt);
    const context = await inNdt(owner, (trx) => policy.scopeContext(trx, owner, 'isms'));
    const out = policy.projectSnapshot(context, snapshotOf('bagus', 'rina'));
    expect(UiMsSnapshot.safeParse(out).success).toBe(true);
    expect(out.bundle.reqs.map((r) => r.id)).toEqual(['A.5.1']);
    // DOC-R is restricted and owned by the owner: visible to its owner.
    expect(out.bundle.docs.map((d) => d.id)).toEqual(['DOC-1', 'DOC-R']);
    expect(out.bundle.evs.map((e) => e.code)).toEqual(['EV-1']);
    expect(out.bundle.chain.items.map((i) => i.id)).toEqual(['R-1']);
    expect(out.bundle.chain.recs).toEqual({ risk: 7 });
    expect(out.bundle.gates.map((g) => g.id)).toEqual(['R-1']);
    expect(out.bundle.phases[0]!.acts.map((a) => a.no)).toEqual(['4.1']);
    expect(out.bundle.phases[0]!.total).toBe(2);
    expect(out.X.risk!.map((x) => [x.id, x.up])).toEqual([['R-1', ['A.5.1']]]);
    expect(out.PREP.map((p) => p[0])).toEqual(['Approve SoA']);
    expect(out.CYCLE_ITEMS.map((c) => c[0])).toEqual(['9.3']);
    expect(out.DRIFT[0]!.rows!.map((r) => r[0])).toEqual(['R-1']);
    expect(out.DRIFT[1]).toEqual({ id: 'unverif', l: P, src: 'unverif' });
    expect(out.EVENTS).toHaveLength(1);
    expect(out.PAST).toHaveLength(1);
    expect(Object.keys(out.refs).sort()).toEqual(
      ['isms:act:4.1', 'isms:cycle:9.3', 'isms:doc:DOC-1', 'isms:doc:DOC-R', 'isms:drift:R-1', 'isms:ev:EV-1', 'isms:prep:Approve SoA', 'isms:req:A.5.1', 'isms:soa:A.5.1', 'isms:x:R-1'].sort(),
    );
  });

  it('hides restricted items from full readers who are not owners or managers, and keeps everything for the MS Manager', async () => {
    const mm = principalOf(u.mm!, ndt);
    const mmOut = policy.projectSnapshot(await inNdt(mm, (trx) => policy.scopeContext(trx, mm, 'isms')), snapshotOf('bagus', 'rina'));
    expect(mmOut.bundle.docs.map((d) => d.id)).toEqual(['DOC-1', 'DOC-R', 'DOC-C']);
    expect(mmOut.bundle.evs).toHaveLength(4);
    expect(Object.keys(mmOut.refs)).toHaveLength(20);

    const ia = principalOf(u.ia!, ndt);
    const iaOut = policy.projectSnapshot(await inNdt(ia, (trx) => policy.scopeContext(trx, ia, 'isms')), snapshotOf('bagus', 'rina'));
    expect(iaOut.bundle.docs.map((d) => d.id)).toEqual(['DOC-1', 'DOC-C']);
    expect(iaOut.bundle.evs.map((e) => e.code)).toEqual(['EV-1', 'EV-2', 'EV-3']);
    expect(iaOut.bundle.reqs).toHaveLength(2);
    expect(iaOut.refs['isms:doc:DOC-R']).toBeUndefined();
    expect(iaOut.refs['isms:ev:EV-R']).toBeUndefined();

    const tm = principalOf(u.tm!, ndt);
    const tmOut = policy.projectSnapshot(await inNdt(tm, (trx) => policy.scopeContext(trx, tm, 'isms')), snapshotOf('bagus', 'rina'));
    expect(tmOut.bundle.chain.items).toHaveLength(3);
    expect(tmOut.bundle.docs.map((d) => d.id)).toEqual(['DOC-1', 'DOC-C']);
  });

  it('returns the external auditor projection of G.5 (D-34)', async () => {
    const ea = principalOf(u.ea!, ndt);
    const context = await inNdt(ea, (trx) => policy.scopeContext(trx, ea, 'isms'));
    expect([...context.auditorPack.evidenceCodes].sort()).toEqual(['EV-2', 'EV-R']);
    const out = policy.projectSnapshot(context, snapshotOf('bagus', 'rina'));
    expect(UiMsSnapshot.safeParse(out).success).toBe(true);
    expect(out.bundle.reqs.map((r) => r.id)).toEqual(['A.5.1', 'A.5.2']);
    for (const r of out.bundle.reqs) {
      expect(r).not.toHaveProperty('owner');
      expect(r).not.toHaveProperty('by');
      expect(r).not.toHaveProperty('note');
    }
    // Confidential and restricted documents are not in packs: hidden. Fields owner, approver and path removed.
    expect(out.bundle.docs.map((d) => d.id)).toEqual(['DOC-1']);
    expect(out.bundle.docs[0]).not.toHaveProperty('owner');
    expect(out.bundle.docs[0]).not.toHaveProperty('approver');
    expect(out.bundle.docs[0]).not.toHaveProperty('path');
    // Only evidence of ready packs; the restricted one stays hidden; no owner, path or hash.
    expect(out.bundle.evs.map((e) => e.code)).toEqual(['EV-2']);
    expect(out.bundle.evs[0]).not.toHaveProperty('owner');
    expect(out.bundle.evs[0]).not.toHaveProperty('path');
    expect(out.bundle.evs[0]).not.toHaveProperty('hash');
    expect(out.bundle.chain).toEqual({ items: [], recs: { risk: 7 } });
    expect(out.bundle.gates).toEqual([]);
    expect(out.bundle.phases).toEqual([]);
    expect(out.X).toEqual({});
    expect(out.PREP).toEqual([]);
    expect(out.CYCLE_ITEMS).toEqual([]);
    expect(out.DRIFT).toEqual([]);
    expect(out.EVENTS).toHaveLength(1);
    expect(out.PAST).toHaveLength(1);
    expect(Object.keys(out.refs).sort()).toEqual(['isms:doc:DOC-1', 'isms:ev:EV-2', 'isms:req:A.5.1', 'isms:req:A.5.2']);
  });

  it('opens storage objects only as F.7 allows: pack copies for auditors, never for Top Management, own records for owners', async () => {
    const can = async (key: string, object: string) => {
      const principal = principalOf(u[key]!, ndt);
      return inNdt(principal, (trx) => policy.canReadObject(trx, principal, 'isms', objects[object]!, null));
    };
    expect(await can('mm', 'ev1')).toBe(true);
    expect(await can('mm', 'evr')).toBe(true);
    expect(await can('mm', 'manifest')).toBe(true);
    expect(await can('mm', 'ev2copy')).toBe(true);
    expect(await can('mm', 'doc1')).toBe(true);
    expect(await can('ia', 'evr')).toBe(false);
    expect(await can('ia', 'docr')).toBe(false);
    expect(await can('ia', 'ev3')).toBe(true);
    expect(await can('owner', 'ev1')).toBe(true);
    expect(await can('owner', 'ev3')).toBe(false);
    expect(await can('owner', 'docr')).toBe(true);
    expect(await can('owner', 'manifest')).toBe(false);
    expect(await can('tm', 'ev1')).toBe(false);
    expect(await can('ea', 'ev2')).toBe(false);
    expect(await can('ea', 'ev2copy')).toBe(true);
    expect(await can('ea', 'evrcopy')).toBe(true);
    expect(await can('ea', 'ev3copy')).toBe(false);
    expect(await can('ea', 'manifest')).toBe(false);
    // An object of ISMS read through QMS by the QMS manager: not referenced by a QMS record.
    const qms = principalOf(u.qmsOnly!, ndt);
    expect(await inNdt(qms, (trx) => policy.canReadObject(trx, qms, 'qms', objects.ev1!, null))).toBe(false);
  });

  it('filters records by owner, classification and auditor packs (filterRecords)', async () => {
    const owner = principalOf(u.owner!, ndt);
    const ownerCtx = await inNdt(owner, (trx) => policy.scopeContext(trx, owner, 'isms'));
    const list = [
      { code: 'a', ownerUserId: u.owner!.id },
      { code: 'b', ownerUserId: u.mm!.id, holderUserId: u.owner!.id },
      { code: 'c', ownerUserId: u.mm!.id },
      { code: 'd', ownerUserId: u.owner!.id, classification: 'restricted' as const },
    ];
    expect(policy.filterRecords(ownerCtx, list).map((r) => r.code)).toEqual(['a', 'b', 'd']);
    const ia = principalOf(u.ia!, ndt);
    const iaCtx = await inNdt(ia, (trx) => policy.scopeContext(trx, ia, 'isms'));
    expect(policy.filterRecords(iaCtx, list).map((r) => r.code)).toEqual(['a', 'b', 'c']);
    const ea = principalOf(u.ea!, ndt);
    const eaCtx = await inNdt(ea, (trx) => policy.scopeContext(trx, ea, 'isms'));
    const evidence = [
      { code: 'EV-1', ownerUserId: u.owner!.id, evidenceId: records['EV-1']!, classification: 'internal' as const },
      { code: 'EV-2', ownerUserId: u.mm!.id, evidenceId: records['EV-2']!, classification: 'confidential' as const },
      { code: 'DOC-C', ownerUserId: u.mm!.id, classification: 'confidential' as const },
      { code: 'REQ', ownerUserId: u.mm!.id },
    ];
    expect(policy.filterRecords(eaCtx, evidence).map((r) => r.code)).toEqual(['EV-2', 'REQ']);
  });

  it('limits the organisation snapshot to systems with a role, and applies the auditor projection to it (G.5)', async () => {
    const org: UiOrgSnapshot = {
      today: '2026-09-29',
      generatedAt: '2026-09-29T03:00:00Z',
      orgs: [{ id: 'ndt', name: 'NDT', ms: ['isms', 'qms'], deploy: 'onprem', sites: 1 }],
      MS: [],
      PEOPLE: { rina: ['Rina', 'ISMS Manager'], bagus: ['Bagus', 'IT Lead'], sari: ['Sari', 'Quality'], 'tenant.admin': ['TA', 'Admin'], none: ['Unassigned', '-'] },
      ROLES: {},
      LOC: {},
      REPOS: [],
      ROUTING: [['QMS', 'Managed Vault', 'Upload', '-']],
      PACKS: { isms: { v: '1.2.0', installed: '02 Feb 2026', eds: '2022', update: null, status: 'current' } },
      LICENCE: { org: 'NDT', to: '31 Mar 2027', fw: '2 of 4', ms: '2 of 10', users: '7 of 150', adapters: 'Managed Vault', features: [], sig: 'Ed25519, verified' },
      STAGES: { isms: [{ id: 'risk', l: P, q: 'q' }], qms: [{ id: 'process', l: P, q: 'q' }] },
      CHAINS: { isms: [{ id: 'R-1', nodes: [['risk', 'R-1'], ['control', 'A.5.1'], ['doc', 'DOC-9']] }, { id: 'R-2', nodes: [['risk', 'R-2']] }], qms: [{ id: 'P-1', nodes: [['process', 'P-1']] }] },
      TITLES: { 'R-1': 'Risk 1', 'R-2': 'Risk 2', 'DOC-9': 'Doc 9', 'P-1': 'Process 1' },
      CLAUSE_AT_RISK: { risk: '6.1', process: '4.4' },
      EXAMPLES: { '5.1': 'Policy' },
      FREQ: {},
      FREQ_ORDER: [],
      permissions: { org: [], ms: {} },
    };
    const filtered = async (key: string, sources = {}) => {
      const principal = principalOf(u[key]!, ndt);
      const context = await inNdt(principal, (trx) => policy.orgScopeContext(trx, principal));
      const out = policy.filterOrgSnapshot(context, org, sources);
      expect(UiOrgSnapshot.safeParse(out).success).toBe(true);
      return out;
    };
    const mm = await filtered('mm');
    expect(Object.keys(mm.CHAINS)).toEqual(['isms']);
    expect(mm.TITLES).toEqual({ 'R-1': 'Risk 1', 'R-2': 'Risk 2', 'DOC-9': 'Doc 9' });
    expect(mm.CLAUSE_AT_RISK).toEqual({ risk: '6.1' });
    expect(Object.keys(mm.PEOPLE).sort()).toEqual(['bagus', 'none', 'rina']);
    expect(mm.LICENCE).not.toBeNull();

    // Owner scope: chains with visible codes only, other nodes hidden; without the codes, nothing of the system.
    const owner = await filtered('owner', { visibleCodesByMs: { isms: new Set(['R-1', 'A.5.1']) } });
    expect(owner.CHAINS).toEqual({ isms: [{ id: 'R-1', nodes: [['risk', 'R-1'], ['control', 'A.5.1'], ['doc', null]] }] });
    expect(owner.TITLES).toEqual({ 'R-1': 'Risk 1' });
    expect((await filtered('owner')).CHAINS).toEqual({});

    // A Tenant Admin without business roles sees no chains, titles or people.
    const ta = await filtered('ta');
    expect(ta.CHAINS).toEqual({});
    expect(ta.TITLES).toEqual({});
    expect(ta.PEOPLE).toEqual({ none: ['Unassigned', '-'] });
    expect(ta.EXAMPLES).toEqual({});

    const ea = await filtered('ea');
    expect(ea.PEOPLE).toEqual({ rina: ['Rina', '-'], bagus: ['Bagus', '-'], none: ['Unassigned', '-'] });
    expect(ea.REPOS).toEqual([]);
    expect(ea.ROUTING).toEqual([]);
    expect(ea.PACKS).toEqual({});
    expect(ea.LICENCE).toBeNull();
    expect(Object.keys(ea.STAGES)).toEqual(['isms']);
  });
});
