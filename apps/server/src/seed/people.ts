// Organisations, users, memberships and business roles of the demo (build plan G.3).
import { createHmac } from 'node:crypto';
import type { SampleOrgSnapshot } from './snapshot';

/** Password of every demo and test user that can sign in (G.3). */
export const DEMO_PASSWORD = 'Mscd-Demo-2026!';
/** HMAC key of the demo TOTP secrets (G.3; `tools/scripts/demo-totp.mjs` computes the codes). */
export const DEMO_TOTP_KEY = 'mscd-demo-totp';

/** The 20-byte TOTP secret of a demo handle: the first 20 bytes of HMAC-SHA256(key "mscd-demo-totp", handle). */
export function demoTotpSecret(handle: string): Buffer {
  return createHmac('sha256', DEMO_TOTP_KEY).update(handle, 'utf8').digest().subarray(0, 20);
}

export type DemoOrgSlug = 'ndt' | 'bsd' | 'rmn' | 'tst';

export interface DemoOrg {
  slug: DemoOrgSlug;
  /** Fixed id, so the development licences bind to it (G.3, D-15). */
  id: string;
  name: string;
  /** The sample organisation whose snapshot holds the data (tst reuses the ISMS data of rmn). */
  source: 'ndt' | 'bsd' | 'rmn';
  demoDeployLabel: 'saas' | 'onprem' | null;
  siteCount: number;
  position: number;
  /** Systems of the organisation, in display order. */
  systems: string[];
}

/** The four organisations of G.3 with their fixed ids. */
export function demoOrgs(snapshotOrgs: readonly { id: string; name: string; ms: string[]; deploy: 'saas' | 'onprem'; sites: number }[]): DemoOrg[] {
  const ids: Record<DemoOrgSlug, string> = {
    ndt: '00000000-0000-4000-8000-00000000a001',
    bsd: '00000000-0000-4000-8000-00000000a002',
    rmn: '00000000-0000-4000-8000-00000000a003',
    tst: '00000000-0000-4000-8000-00000000a004',
  };
  const sample = (['ndt', 'bsd', 'rmn'] as const).map((slug, position): DemoOrg => {
    const org = snapshotOrgs.find((o) => o.id === slug);
    if (!org) throw new Error(`The demo snapshot has no organisation ${slug}`);
    return { slug, id: ids[slug], name: org.name, source: slug, demoDeployLabel: org.deploy, siteCount: org.sites, position, systems: [...org.ms] };
  });
  return [
    ...sample,
    { slug: 'tst', id: ids.tst, name: 'Test Organisation', source: 'rmn', demoDeployLabel: null, siteCount: 1, position: 3, systems: ['isms'] },
  ];
}

export type BusinessRole =
  | 'ms_manager'
  | 'programme_owner'
  | 'domain_owner'
  | 'risk_owner'
  | 'internal_auditor'
  | 'top_management'
  | 'external_auditor'
  | 'compliance_investigator';

export interface DemoMembership {
  org: DemoOrgSlug;
  adminRoles: ('tenant_admin' | 'storage_admin')[];
}

export interface DemoUser {
  handle: string;
  displayName: string;
  jobTitle: string | null;
  email: string;
  kind: 'person' | 'guest';
  /** Gets the demo password (G.3); staff and the guest auditor have none. */
  password: boolean;
  /** Gets a confirmed TOTP factor with the demo secret. */
  totp: boolean;
  platformOperator: boolean;
  memberships: DemoMembership[];
  /** Business roles in one system of an organisation; `primary` marks the primary MS Manager. */
  roles(org: DemoOrgSlug, system: string): { role: BusinessRole; primary: boolean }[];
}

const SAMPLE_ORGS: DemoOrgSlug[] = ['ndt', 'bsd', 'rmn'];
const ALL_ORGS: DemoOrgSlug[] = ['ndt', 'bsd', 'rmn', 'tst'];
/** System whose primary MS Manager each manager is (G.3). */
const PRIMARY_MANAGER: Record<string, string> = { rina: 'isms', sari: 'qms', tono: 'bcms', lina: 'abms' };
/**
 * Sample people who own or hold ISMS records but are not tst members in G.3. `tst` holds the ISMS data too, and the
 * `assert_member` trigger requires every person column to name a member, so they are members of tst as well.
 */
const ISMS_RECORD_HOLDERS_IN_TST = new Set(['dewi', 'fajar', 'andi', 'yusuf', 'lina']);

/** `<first>.<last>@nusantaradigital.co.id` from a sample display name (G.3). */
export function sampleEmail(displayName: string): string {
  return `${displayName.toLowerCase().split(/\s+/).join('.')}@nusantaradigital.co.id`;
}

/** Every demo and test user of G.3, in a fixed order. */
export function demoUsers(people: SampleOrgSnapshot['PEOPLE']): DemoUser[] {
  const sample = (handle: string, orgs: DemoOrgSlug[], roles: DemoUser['roles'], adminRoles: (org: DemoOrgSlug) => DemoMembership['adminRoles'] = () => []): DemoUser => {
    const entry = people[handle];
    if (!entry) throw new Error(`The demo snapshot has no person ${handle}`);
    return {
      handle,
      displayName: entry[0],
      jobTitle: entry[1] === '-' ? null : entry[1],
      email: sampleEmail(entry[0]),
      kind: 'person',
      password: true,
      totp: true,
      platformOperator: false,
      memberships: orgs.map((org) => ({ org, adminRoles: adminRoles(org) })),
      roles,
    };
  };
  const only = (role: BusinessRole): DemoUser['roles'] => () => [{ role, primary: false }];
  const manager = (handle: string): DemoUser['roles'] => (_org, system) =>
    PRIMARY_MANAGER[handle] === system ? [{ role: 'ms_manager', primary: true }] : [{ role: 'domain_owner', primary: false }];
  const orgsOf = (handle: string): DemoOrgSlug[] => (ISMS_RECORD_HOLDERS_IN_TST.has(handle) ? ALL_ORGS : SAMPLE_ORGS);
  const testUser = (handle: string, displayName: string, jobTitle: string | null, extra: Partial<DemoUser>): DemoUser => ({
    handle,
    displayName,
    jobTitle,
    email: `${handle}@mscd.test`,
    kind: 'person',
    password: true,
    totp: true,
    platformOperator: false,
    memberships: [],
    roles: () => [],
    ...extra,
  });
  const users: DemoUser[] = [
    sample('rina', ALL_ORGS, (_org, system) => [{ role: 'ms_manager', primary: PRIMARY_MANAGER.rina === system }], () => ['tenant_admin', 'storage_admin']),
    sample('bagus', ALL_ORGS, only('domain_owner')),
    sample('maya', ALL_ORGS, only('internal_auditor')),
    sample('hendra', ALL_ORGS, only('top_management')),
    sample('sari', SAMPLE_ORGS, manager('sari')),
    sample('tono', SAMPLE_ORGS, manager('tono')),
    sample('lina', orgsOf('lina'), manager('lina')),
    ...['dewi', 'fajar', 'andi', 'yusuf'].map((handle) => sample(handle, orgsOf(handle), only('domain_owner'))),
    testUser('tenant.admin', 'Tenant Admin', 'IT Administrator', { memberships: [{ org: 'tst', adminRoles: ['tenant_admin'] }] }),
    // The external auditor's role comes with the seeded auditor access grant (F.14), not from this list.
    testUser('ext.auditor', 'Eko Santoso', 'Lead Auditor', { kind: 'guest', password: false, memberships: [{ org: 'tst', adminRoles: [] }] }),
    testUser('mfa.tester', 'MFA Tester', 'Analyst', { totp: false, memberships: [{ org: 'tst', adminRoles: [] }], roles: only('domain_owner') }),
    testUser('ops', 'Platform Operator', null, { platformOperator: true }),
  ];
  for (let n = 1; n <= 75; n++) {
    const number = String(n).padStart(2, '0');
    users.push({
      handle: `staff${number}`,
      displayName: `Staff ${number}`,
      jobTitle: 'Employee',
      email: `staff${number}@nusantaradigital.co.id`,
      kind: 'person',
      password: false,
      totp: false,
      platformOperator: false,
      memberships: SAMPLE_ORGS.map((org) => ({ org, adminRoles: [] })),
      roles: () => [],
    });
  }
  const known = new Set(users.map((u) => u.handle));
  const missing = Object.keys(people).filter((handle) => handle !== 'none' && !known.has(handle));
  if (missing.length > 0) throw new Error(`The demo snapshot has people the seed does not know: ${missing.join(', ')}`);
  return users;
}

/** Keycloak user ids of the pre-registered subjects (G.3; fixed in deploy/compose/dev/keycloak/realm-mscd.json). */
export const KEYCLOAK_SUBJECTS: Readonly<Record<string, string>> = {
  rina: '00000000-0000-4000-8000-0000000000c1',
  bagus: '00000000-0000-4000-8000-0000000000c2',
  maya: '00000000-0000-4000-8000-0000000000c3',
  hendra: '00000000-0000-4000-8000-0000000000c4',
};
/** Organisations that get the Keycloak provider when `demo.keycloak` is set (G.3). */
export const KEYCLOAK_ORGS: readonly DemoOrgSlug[] = ['ndt', 'tst'];
