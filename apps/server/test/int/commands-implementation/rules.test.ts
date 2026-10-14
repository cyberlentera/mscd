// The rule engine (build plan K.2 WP-20, digest 6.1): implementations found through `@BusinessRule`, activation per
// framework version from `ref.rule_activation` (BR-02 only in ISO 27001 and ISO 37001; BR-03 parameters from the
// pack), evaluation for every linked system of a shared entity (a violation in one system rejects), severities, and
// the message catalogue of every rule in English and Indonesian.
import { RULE_IDS } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BusinessRuleError } from '../../../src/common/problems';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { RULE_MESSAGES, RuleActivationService, RuleEngine, ruleMessages } from '../../../src/modules/rules';
import { useTestDatabase } from '../../setup/test-db';
import { createCommandsApp, inOrg, ORG_IDS, type CommandsApp } from './helpers';

const SYSTEM = '00000000-0000-0000-0000-000000000001';

describe('rule engine', () => {
  const db = useTestDatabase('demo');
  let ctx: CommandsApp;
  let engine: RuleEngine;
  let ms: Record<string, string>;

  const inNdt = <T>(fn: (trx: Parameters<Parameters<TenantScope['withTenant']>[1]>[0]) => Promise<T>) =>
    ctx.moduleRef.get(TenantScope).withTenant({ orgId: ORG_IDS.ndt, schema: 'org_ndt', userId: SYSTEM }, fn);

  beforeAll(async () => {
    ctx = await createCommandsApp(db);
    engine = ctx.moduleRef.get(RuleEngine);
    ms = await inOrg(db, 'ndt', async (trx) =>
      Object.fromEntries((await sql<{ slug: string; id: string }>`select slug, id from management_system`.execute(trx)).rows.map((r) => [r.slug, r.id])),
    );
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('finds the implementations of the implementation module through @BusinessRule', () => {
    expect(engine.registered()).toEqual(expect.arrayContaining(['BR-01', 'BR-02', 'BR-03', 'BR-12', 'BR-39', 'BR-40', 'BR-46', 'BR-47', 'VERIFY-SELF']));
  });

  it('reads activation per framework version: BR-02 in ISO 27001 and ISO 37001 only, platform rules everywhere', async () => {
    const activation = ctx.moduleRef.get(RuleActivationService);
    await inNdt(async (trx) => {
      expect(await activation.isActive(trx, 'BR-02', ms.isms!)).toBe(true);
      expect(await activation.isActive(trx, 'BR-02', ms.abms!)).toBe(true);
      expect(await activation.isActive(trx, 'BR-02', ms.qms!)).toBe(false);
      expect(await activation.isActive(trx, 'BR-02', ms.bcms!)).toBe(false);
      expect(await activation.isActive(trx, 'BR-01', ms.qms!)).toBe(true);
      expect(await activation.isActive(trx, 'VERIFY-SELF', ms.qms!)).toBe(true);
      // BR-05 waits for the A-33 risk profile format and is not activated by the packs (A.5 A-01).
      expect(await activation.isActive(trx, 'BR-05', ms.isms!)).toBe(false);
      const params = await activation.paramsOf(trx, 'BR-03', ms.isms!);
      expect(params).toMatchObject({ phrases: { en: expect.arrayContaining(['n/a', 'not applicable']), id: expect.arrayContaining(['tidak berlaku']) } });
    });
  });

  it('evaluates a shared entity for every linked system: one violation rejects, inactive systems are skipped', async () => {
    await inNdt(async (trx) => {
      const input = { applicable: true, riskCount: 0 };
      expect(await engine.evaluate(trx, 'BR-02', input, { msIds: [ms.qms!, ms.bcms!] })).toEqual([]);
      const findings = await engine.evaluate(trx, 'BR-02', input, { msIds: [ms.qms!, ms.isms!, ms.abms!] });
      expect(findings.map((f) => f.msId)).toEqual([ms.isms, ms.abms]);
      await expect(engine.enforce(trx, 'BR-02', input, { msIds: [ms.qms!, ms.isms!] })).rejects.toBeInstanceOf(BusinessRuleError);
      await expect(engine.enforce(trx, 'BR-02', { applicable: true, riskCount: 2 }, { msIds: [ms.isms!] })).resolves.toEqual([]);
    });
  });

  it('turns warning findings into one D.1 warning per message and flags into findings only', async () => {
    await inNdt(async (trx) => {
      const warnings = await engine.enforce(trx, 'BR-03', { justification: 'n/a' }, { msIds: [ms.isms!, ms.qms!] });
      expect(warnings).toEqual([{ rule: 'BR-03', messages: ruleMessages('BR-03') }]);
      expect(await engine.enforce(trx, 'BR-03', { justification: 'No development of software takes place in scope' }, { msIds: [ms.isms!] })).toEqual([]);
      expect(await engine.enforce(trx, 'BR-46', { blockedActivities: 1, openGateItems: 3 }, { msIds: [ms.isms!] })).toEqual([]);
      const flags = await engine.evaluate(trx, 'BR-46', { blockedActivities: 1, openGateItems: 3 }, { msIds: [ms.isms!] });
      expect(flags).toEqual([expect.objectContaining({ rule: 'BR-46', severity: 'flag', data: { blockedActivities: 1, openGateItems: 3 } })]);
    });
  });

  it('a rule without an implementation is a programming error', async () => {
    await inNdt(async (trx) => {
      await expect(engine.evaluate(trx, 'BR-27', {}, { msIds: [ms.isms!] })).rejects.toThrow(/No implementation of BR-27/);
    });
  });

  it('has a message in English and Indonesian for every rule, without the forbidden characters', () => {
    for (const rule of RULE_IDS) {
      const template = RULE_MESSAGES[rule];
      expect(template.en.length, rule).toBeGreaterThan(10);
      expect(template.id.length, rule).toBeGreaterThan(10);
      const filled = ruleMessages(rule);
      for (const text of [filled.en, filled.id, template.en, template.id]) {
        expect(text, rule).not.toMatch(/[\u2013\u2014\u00b7\u2018\u2019\u201c\u201d\u2190\u2192]/);
      }
      expect(filled.en, rule).not.toMatch(/[{}]/);
      expect(filled.id, rule).not.toMatch(/[{}]/);
    }
    expect(ruleMessages('BR-29', { name: 'SharePoint QMS' })).toEqual({
      en: 'Repository SharePoint QMS cannot be reached. Try again later or contact your administrator.',
      id: 'Repositori SharePoint QMS tidak dapat dijangkau. Coba lagi nanti atau hubungi administrator Anda.',
    });
    expect(ruleMessages('BR-22', {}, { systems: { en: 'QMS and BCMS', id: 'QMS dan BCMS' } }).id).toBe('Perubahan ini juga berlaku untuk: QMS dan BCMS. Lanjutkan?');
    expect(ruleMessages('NOT-A-MEMBER').en).toBe('The person is not a member of this organisation.');
  });
});
