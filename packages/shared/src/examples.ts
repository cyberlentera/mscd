// Example values shared by the schema examples of the UI, API and pack modules. Internal: not exported from the package
// entry point. Names and codes follow the sample organisation (UI 4.7, G.3).

export const EXAMPLE_ORGANISATION = { id: 'ndt', name: 'PT Nusantara Digital Teknologi', ms: ['isms', 'qms'], deploy: 'saas', sites: 2 } as const;

export const EXAMPLE_MS = {
  id: 'isms', code: 'ISO/IEC 27001', ed: '2022', short: 'ISMS',
  name: ['Information security management system', 'Sistem manajemen keamanan informasi'], mgr: 'rina', mgrRole: 'ISMS Manager',
  color: '#e8731a', scope: 'Data centre & managed services operations: Jakarta and Surabaya', certifier: 'PT Sertifikasi Nusantara',
  lead: 'Ir. Dwi Hartanto, IRCA LA', cert: ['Certified 14 Mar 2025, cycle 2025 to 2028', 'Tersertifikasi 14 Mar 2025, siklus 2025 sampai 2028'],
  stage: ['Surveillance 1, year 2', 'Surveilans 1, tahun ke-2'],
  audit: { name: ['Surveillance audit 1', 'Audit surveilans 1'], date: '2026-11-12', days: 2, prepWindowDays: 60 },
  clauses: [100, 100, 88, 72, 94, 81, 67], findings: { open: 3, major: 1 }, loc: 'sp', locMode: 'Customer Repository, Link',
  pack: 'ISO27001-2022 v1.2.0', phase: ['Operate & maintain', 'Operasi & pemeliharaan'], unit: 'ctrl',
  theme: { 5: 'Organizational', 6: 'People', 7: 'Physical', 8: 'Technological' },
  gateName: ['Risk & SoA', 'Risiko & SoA'], gtSuggestions: ['A.8.13', 'PRC-07', 'A.5.23'],
} as const;

export const EXAMPLE_REQUIREMENT = {
  id: 'A.8.13', key: '8.13', title: 'Information backup', theme: 'A.8 Technological', st: 'partial', owner: 'bagus', doc: 'PRC-11',
  freq: 'monthly', note: 'Q3 backup log not found at pinned location', gate: false, just: 'Required by risk treatment; see linked risks.',
  risks: ['R-014', 'R-031'], by: null,
} as const;

export const EXAMPLE_DOCUMENT = {
  id: 'PRC-07', title: 'Access Control Procedure', tier: 'Procedure', ver: '3.2', st: 'expired', appr: '2025-09-24', rev: '2026-09-24',
  owner: 'bagus', shared: false, ms: 'isms', approver: 'hendra', path: 'Compliance / ISMS / Documents', hashAlg: 'quickXorHash', usedBy: [],
} as const;

export const EXAMPLE_EVIDENCE = {
  code: 'EV-0313', ctrl: 'A.8.13', ctrlKey: '8.13', title: 'Backup job log & restore test', freq: 'monthly', p: 30, prod: '2026-05-31',
  next: '2026-06-30', fresh: 'critical', integ: 'missing', loc: 'sp', owner: 'bagus', ver: 'v3.0', hashAlg: 'quickXorHash',
  path: 'Compliance / ISMS / Evidence / 2026 / Q3', hash: 'ev0313a91f0000000000000000000000000000000000000000000000003c7e',
  lastCheck: '29 Sep 2026 06:00',
} as const;

export const EXAMPLE_CHAIN_ITEM = {
  key: 'isms:x:R-031', stage: 'risk', kind: 'x', id: 'R-031',
  title: ['Unpatched hypervisor in Surabaya DC', 'Unpatched hypervisor in Surabaya DC'],
  act: ['Select a treatment: no treatment linked', 'Select a treatment: no treatment linked'],
  h: 'rina', due: null, st: 'missing', after: false, gate: true, up: ['CI-03'], down: [], q: 'Show me how this risk was identified and assessed.',
} as const;

export const EXAMPLE_GATE_ITEM = {
  id: 'A.8.12', type: ['Control', 'Kontrol'], why: ['Justification missing', 'Justifikasi belum ada'], h: 'dewi', due: null, key: 'req:A.8.12',
} as const;

export const EXAMPLE_ACTIVITY = {
  key: 'isms:act:4.5', no: '4.5', title: 'Select Annex A controls', st: 'blocked', blocker: 'A.8.12', owner: 'bagus', out: 'SOA-01',
  docId: 'SOA-01', date: '2026-11-03', pno: 4,
} as const;

export const EXAMPLE_PHASE = {
  no: 4, n: 'Risk assessment & SoA', gate: true, acts: [EXAMPLE_ACTIVITY], total: 1,
  c: { verified: 0, complete: 0, progress: 0, blocked: 1, ns: 0, locked: 0 },
} as const;

export const EXAMPLE_STAGE = { id: 'risk', l: ['Risk', 'Risiko'], q: 'Show me how this risk was identified and assessed.', rec: 38 } as const;

export const EXAMPLE_X_RECORD = {
  id: 'R-031', t: 'Unpatched hypervisor in Surabaya DC', act: 'Select a treatment: no treatment linked', h: 'rina', due: null, gate: true,
  up: ['CI-03'], down: [],
} as const;


export const EXAMPLE_REF = {
  module: 'audit', entityType: 'risk', id: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b', code: 'R-031', etag: 'W/"1790000000000"',
} as const;

export const EXAMPLE_REPO = {
  id: 'gd', ref: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f', adapter: 'google_drive', ownershipType: 'organizational', actions: ['test', 'reauthorise'],
  name: 'Google Shared Drive', type: 'Google Workspace', modes: 'Zero-transit, Link', status: 'bad',
  msg: ['Delegated token expired 27 Sep 2026: checks paused for 11 references', 'Token delegasi kedaluwarsa 27 Sep 2026: pemeriksaan 11 rujukan tertunda'],
  tenant: 'Compliance BCMS drive, drive.file', ms: ['BCMS'], last: '27 Sep 2026 06:00',
} as const;

export const EXAMPLE_PACK_CARD = {
  v: '0.9.0 (2026), 1.4.2 (2015)', installed: '18 Sep 2026', eds: ['2026 current, 2015 in transition', '2026 berlaku, 2015 dalam transisi'],
  update: ['1.0.0: subclause numbering verified against published text', '1.0.0: penomoran subklausul diverifikasi terhadap teks terbitan'],
  status: 'transition',
} as const;

export const EXAMPLE_LICENCE_CARD = {
  org: 'PT Nusantara Digital Teknologi', to: '31 Mar 2027', fw: '4 of 4', ms: '4 of 10', users: '86 of 150',
  adapters: 'Managed Vault, Microsoft 365, Google Workspace, SMB',
  features: [['Integrated Management System', 'Sistem Manajemen Terintegrasi'], ['Link Health Monitor', 'Pemantau Kesehatan Tautan']],
  sig: ['Ed25519, verified', 'Ed25519, terverifikasi'],
} as const;

export const EXAMPLE_PERMISSIONS = { org: ['storage.repository.read', 'pack.read'], ms: { isms: ['ms.read', 'applicability.verify'] } } as const;

export const EXAMPLE_ORG_SNAPSHOT = {
  today: '2026-09-29',
  generatedAt: '2026-09-29T06:00:00Z',
  orgs: [EXAMPLE_ORGANISATION],
  MS: [EXAMPLE_MS],
  PEOPLE: { rina: ['Rina Kusuma', 'ISMS Manager'], bagus: ['Bagus Prasetyo', 'IT Infrastructure Lead'], none: ['Unassigned', '-'] },
  ROLES: { manager: { who: 'rina', label: ['MS Manager', 'Manajer SM'] } },
  LOC: { sp: ['SharePoint Online', 'sp', 'SharePoint'], gd: ['Google Shared Drive', 'gd', 'Google Drive'] },
  REPOS: [EXAMPLE_REPO],
  ROUTING: [['BCMS', 'Google Shared Drive', 'Zero-transit', ['Internal to Link', 'Internal ke Link']]],
  PACKS: { qms: EXAMPLE_PACK_CARD },
  LICENCE: EXAMPLE_LICENCE_CARD,
  STAGES: { isms: [EXAMPLE_STAGE] },
  CHAINS: { isms: [{ id: 'R-014', nodes: [['context', 'CI-02'], ['risk', 'R-014'], ['evidence', 'ev:A.8.2'], ['metric', null]] }] },
  TITLES: { 'CI-02': 'Dependence on privileged administrators' },
  CLAUSE_AT_RISK: { risk: '6.1.2' },
  EXAMPLES: { '8.13': 'Backup job log export and restore test sign-off' },
  FREQ: { monthly: ['Monthly', 'Bulanan', 30], event: ['Per event', 'Per kejadian', 0] },
  FREQ_ORDER: ['monthly', 'event'],
  permissions: EXAMPLE_PERMISSIONS,
} as const;

export const EXAMPLE_MS_SNAPSHOT = {
  ms: 'isms',
  bundle: {
    reqs: [EXAMPLE_REQUIREMENT], docs: [EXAMPLE_DOCUMENT], evs: [EXAMPLE_EVIDENCE],
    chain: { items: [EXAMPLE_CHAIN_ITEM], recs: { risk: 38 } }, gates: [EXAMPLE_GATE_ITEM], phases: [EXAMPLE_PHASE],
  },
  X: { risk: [EXAMPLE_X_RECORD] },
  EVENTS: [
    { t: ['Stage 2, certification', 'Tahap 2, sertifikasi'], d: '2025-03-10', days: 3, result: ['Certified, 2 Minor NC, 1 OFI', 'Tersertifikasi, 2 NC Minor, 1 OFI'] },
    { t: ['Surveillance 1', 'Surveilans 1'], d: '2026-11-12', days: 2, next: true },
  ],
  FOCUS: 'Vulnerability remediation (NC-2025-02)',
  PREP: [['Approve SoA v3.0', 'hendra', '2026-10-15', 'open']],
  PAST: [['NC-2025-02', 'Minor', '8.8 / A.8.8', 'Remediation SLA missed for 3 critical vulnerabilities', 'open', 'Corrective action implemented']],
  CYCLE_ITEMS: [['9.3', 'Management review with all mandatory inputs', 'hendra', '2026-10-28', 'open', '2 of 7 inputs not yet prepared']],
  DRIFT: [
    { id: 'risk12', l: ['Risks not reassessed in 12 months', 'Risiko tidak dinilai ulang 12 bulan'], rows: [['R-005', 'Data centre power failure', 'bagus', '2026-10-30']] },
    { id: 'unverif', l: ['Evidence files that cannot be verified', 'Berkas bukti tak terverifikasi'], src: 'unverif' },
  ],
  refs: { 'isms:x:R-031': EXAMPLE_REF },
} as const;

export const EXAMPLE_ME = {
  user: { id: '8c0d6f1e-2a3b-4c5d-9e6f-7a8b9c0d1e2f', handle: 'rina', email: 'rina.kusuma@nusantaradigital.co.id', displayName: 'Rina Kusuma', jobTitle: 'ISMS Manager' },
  org: { id: '00000000-0000-4000-8000-00000000a001', slug: 'ndt', name: 'PT Nusantara Digital Teknologi' },
  orgs: [EXAMPLE_ORGANISATION],
  rolesByMs: { isms: ['ms_manager'], qms: ['ms_manager'] },
  uiRoleByMs: { isms: 'manager', qms: 'manager' },
  adminRoles: ['tenant_admin', 'storage_admin'],
  platformRoles: [],
  permissions: EXAMPLE_PERMISSIONS,
  csrfToken: 'b1T7c0Qy9Zq2R8w4XkP6mN3vL5sJ0hG1fD2eC3aB4c5',
  session: { authMethod: 'local', idleExpiresAt: '2026-09-29T07:00:00Z', absoluteExpiresAt: '2026-09-29T14:00:00Z' },
  preferences: { lang: 'en' },
} as const;

export const EXAMPLE_LICENCE = {
  license_id: 'LIC-DEMO-NDT', organization: 'PT Nusantara Digital Teknologi', organization_id: '00000000-0000-4000-8000-00000000a001',
  valid_from: '2026-04-01', valid_until: '2027-03-31', grace_days: 30, frameworks: ['ISO27001', 'ISO9001', 'ISO22301', 'ISO37001'],
  max_management_systems: 10, max_users: 150, storage_adapters: ['managed_vault', 'm365', 'google_drive', 'smb'],
  features: ['integrated_mode', 'edition_transition', 'link_health_monitor', 'auditor_guest_access'], key_id: '0a1b2c3d4e5f6789',
  signature: 'ed25519:' + 'A'.repeat(86) + '==',
} as const;
