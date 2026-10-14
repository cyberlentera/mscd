// G.5 formats of the snapshots: MS fields, pack and licence cards, storage rows, stages and frequencies, the
// certification cycle rows, drift patterns and predicates, the overview and the record refs.
import type { RepositoryView } from '@mscd/shared';
import { describe, expect, it } from 'vitest';
import { deriveCycleItems, deriveEvents, deriveFocus, derivePast, derivePrep, findingCounts, nextAuditEvent, type AuditEventRow } from '../../../src/modules/read-model/derive/audit';
import {
  deriveDriftPatterns, evidenceWithoutHashOf, isStaleMetric, isStaleRisk, lacksScheduledExercise, lacksValidDueDiligence, monthsBefore, unverifiableEvidenceOf,
} from '../../../src/modules/read-model/derive/drift';
import { bannerOf, deriveManagementSystem, editionText, locModeText, themeLabels, type VersionInfo } from '../../../src/modules/read-model/derive/ms-fields';
import { compareVersions, frequencyTable, licenceCard, locEntry, locKind, packCard, repoRow, routingRow, stageEntry } from '../../../src/modules/read-model/derive/org-formats';
import { clauseLevel, maturityLevel, maturityValues, nextGate, openPerClause, overviewBlockers } from '../../../src/modules/read-model/derive/overview';
import { RefCollector, recordRef } from '../../../src/modules/read-model/derive/refs';
import { loadSampleSnapshot } from '../../../src/seed/snapshot';

const sample = loadSampleSnapshot();
const ndt = sample.snapshots.ndt!;
const today = sample.today;

function version(over: Partial<VersionInfo>): VersionInfo {
  return {
    id: 'v', frameworkCode: 'ISO27001', frameworkName: 'ISO/IEC 27001', edition: '2022', packId: 'ISO27001-2022', packVersion: '1.2.0', status: 'current',
    preRelease: false, applicabilityTarget: 'catalogue_item', installedAt: new Date('2026-02-02T02:00:00Z'), ...over,
  };
}

describe('MS fields (G.5 MS[])', () => {
  const isms = ndt.MS.find((m) => m.id === 'isms')!;
  const labels = {
    'ms.long_name': ['Information security management system', 'Sistem manajemen keamanan informasi'] as [string, string],
    'ms.manager_role': ['ISMS Manager', 'Manajer ISMS'] as [string, string],
    'gate.name': ['Risk & SoA', 'Risiko & SoA'] as [string, string],
    'catalogue.theme.5': ['Organizational', 'Organisasional'] as [string, string],
    'catalogue.theme.6': ['People', 'Orang'] as [string, string],
    'catalogue.theme.7': ['Physical', 'Fisik'] as [string, string],
    'catalogue.theme.8': ['Technological', 'Teknologi'] as [string, string],
  };
  const event: AuditEventRow = {
    id: 'e', updatedAt: new Date(0), scheduledAt: '2026-11-12', auditDays: 2, shortLabel: 'Surveillance 1', nameEn: 'Surveillance audit 1', nameId: 'Audit surveilans 1',
    leadAuditorName: 'Ir. Dwi Hartanto, IRCA LA', expectedFocus: 'focus', prepWindowDays: 60, outcomeSummary: null,
  };

  it('reproduces the sample ISMS card from stored values', () => {
    const ms = deriveManagementSystem({
      slug: 'isms', code: 'ISMS', scope: isms.scope, certificationBody: isms.certifier, color: isms.color,
      display: { certLabel: isms.cert, stage: isms.stage, phase: isms.phase, packLabel: isms.pack, gtSuggestions: isms.gtSuggestions },
      active: version({}), target: null, labels, primaryManager: 'rina', nextEvent: event,
      readiness: new Map(isms.clauses.map((p, i) => [4 + i, p])), findings: { open: 3, major: 1 }, alerts: [],
      defaultRepository: { slug: 'sp', adapter: 'm365' }, defaultRoutingMode: 'link', approver: 'hendra',
    });
    expect(ms).toEqual(isms);
  });

  it('formats edition, location mode, themes and the newest open alert', () => {
    expect(editionText({ edition: '2015' }, { edition: '2026' })).toBe('2015 to 2026');
    expect(editionText({ edition: '2019' }, null)).toBe('2019');
    expect(locModeText('managed_vault', 'stored')).toBe('Managed Vault');
    expect(locModeText('google_drive', 'zero_transit')).toBe('Customer Repository, Zero-transit');
    expect(themeLabels(labels)).toEqual({ 5: 'Organizational', 6: 'People', 7: 'Physical', 8: 'Technological' });
    expect(bannerOf([
      { kind: 'beta', tone: 'warn', textEn: 'old', textId: 'lama', raisedAt: new Date('2026-01-01') },
      { kind: 'connector', tone: 'bad', textEn: 'new', textId: 'baru', raisedAt: new Date('2026-09-27') },
    ])).toEqual({ tone: 'bad', text: ['new', 'baru'], kind: 'connector' });
    expect(bannerOf([])).toBeUndefined();
  });
});

describe('pack and licence cards (G.5 PACKS, LICENCE)', () => {
  it('reproduces the four sample pack cards', () => {
    const tz = 'Asia/Jakarta';
    const at = (d: string) => new Date(`${d}T02:00:00Z`);
    const qms15 = version({ frameworkCode: 'ISO9001', edition: '2015', packId: 'ISO9001-2015', packVersion: '1.4.2', status: 'transition', installedAt: at('2025-06-01') });
    const qms26 = version({ frameworkCode: 'ISO9001', edition: '2026', packId: 'ISO9001-2026', packVersion: '0.9.0', status: 'current', installedAt: at('2026-09-18') });
    const abms25 = version({ frameworkCode: 'ISO37001', edition: '2025', packId: 'ISO37001-2025', packVersion: '0.6.0', preRelease: true, installedAt: at('2026-09-01') });
    const abms16 = version({ frameworkCode: 'ISO37001', edition: '2016', packId: 'ISO37001-2016', packVersion: '1.0.0', status: 'withdrawn', installedAt: at('2024-01-10') });
    const catalog = [
      { packId: 'ISO9001-2026', packVersion: '1.0.0', noteEn: 'subclause numbering verified against published text', noteId: 'penomoran subklausul diverifikasi terhadap teks terbitan' },
      { packId: 'ISO37001-2025', packVersion: '0.7.0', noteEn: '26 more activities, 80 finding conditions', noteId: 'tambahan 26 aktivitas, 80 kondisi temuan' },
    ];
    const card = (active: VersionInfo, target: VersionInfo | null, installed: VersionInfo[]) => packCard({ active, target, installed, catalog, timeZone: tz });
    const { status: _s1, ...isms } = card(version({ installedAt: at('2026-02-02') }), null, [version({})]);
    const { status: _s2, ...qms } = card(qms15, qms26, [qms15, qms26]);
    const { status: _s3, ...bcms } = card(version({ frameworkCode: 'ISO22301', edition: '2019', packId: 'ISO22301-2019', packVersion: '1.0.0', installedAt: at('2026-04-02') }), null, []);
    const { status: _s4, ...abms } = card(abms25, null, [abms25, abms16]);
    const strip = (c: Record<string, unknown>) => ({ ...c, status: undefined });
    expect({ isms, qms, bcms, abms }).toEqual(Object.fromEntries(Object.entries(ndt.PACKS).map(([k, v]) => [k, { ...strip(v as never), status: undefined }])) as never);
    expect([card(version({}), null, []).status, card(qms15, qms26, []).status, card(abms25, null, []).status]).toEqual(['current', 'transition', 'beta']);
    expect(compareVersions('1.0.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
  });

  it('reproduces the sample licence card from the licence document and live counts', () => {
    expect(licenceCard({
      organization: 'PT Nusantara Digital Teknologi', validUntil: '2027-03-31', frameworks: ['ISO27001', 'ISO9001', 'ISO22301', 'ISO37001'],
      storageAdapters: ['managed_vault', 'm365', 'google_drive', 'smb'], features: ['integrated_mode', 'edition_transition', 'link_health_monitor', 'auditor_guest_access'],
      maxManagementSystems: 10, maxUsers: 150, frameworksUsed: 4, managementSystems: 4, activeUsers: 86, verified: true,
    })).toEqual(ndt.LICENCE);
    expect(licenceCard({ organization: 'x', validUntil: '2027-03-31', frameworks: [], storageAdapters: [], features: [], maxManagementSystems: 1, maxUsers: 1, frameworksUsed: 0, managementSystems: 0, activeUsers: 0, verified: false }).sig).toEqual(['Ed25519, not verified', 'Ed25519, tidak terverifikasi']);
  });
});

describe('storage formats (G.5 LOC, REPOS, ROUTING)', () => {
  it('derives LOC entries by repository kind', () => {
    expect(locKind('m365', 'organizational')).toBe('sp');
    expect(locKind('m365', 'personal')).toBe('od');
    expect(locKind('google_drive', 'organizational')).toBe('gd');
    expect(locKind('managed_vault', 'organizational')).toBe('vault');
    expect(locKind('smb', 'organizational')).toBe('smb');
    expect(locEntry({ name: 'OneDrive personal', adapter: 'm365', ownershipType: 'personal', display: { locName: 'OneDrive (personal)' } })).toEqual(ndt.LOC.od!.slice(0, 3));
    expect(locEntry({ name: 'Managed Vault', adapter: 'managed_vault', ownershipType: 'organizational', display: {} })).toEqual(ndt.LOC.vault!.slice(0, 3));
  });

  it('formats repository cards and routing rows', () => {
    const view = {
      id: 'gd', ref: '33333333-3333-4333-8333-333333333333', name: 'Google Shared Drive', type: 'Google Workspace', status: 'bad',
      msg: ndt.REPOS.find((r) => r.id === 'gd')!.msg, tenant: 'Compliance BCMS drive, drive.file', ms: ['BCMS'], last: '27 Sep 2026 06:00', adapter: 'google_drive',
      modes: ['zero_transit', 'link'], ownershipType: 'organizational', connectionStatus: 'revoked', retentionConfirmed: true, metadataMinimization: false,
      readOnly: false, credentialSet: true, credentialExpiresAt: null, config: {}, actions: ['test', 'reauthorise'],
    } as unknown as RepositoryView;
    const { ref: _ref, ...row } = repoRow(view);
    expect(row).toEqual(ndt.REPOS.find((r) => r.id === 'gd'));
    expect(routingRow({ msCode: 'ISMS', repositoryName: 'SharePoint Online', mode: 'link', note: 'Restricted to Zero-transit', displayNote: ['Restricted to Zero-transit', 'Terbatas ke Zero-transit'] })).toEqual(ndt.ROUTING[0]);
    expect(routingRow({ msCode: 'QMS', repositoryName: 'Managed Vault', mode: 'stored', note: null })).toEqual(ndt.ROUTING[1]);
    expect(routingRow({ msCode: 'QMS', repositoryName: 'Managed Vault', mode: 'stored', note: 'Edited', displayNote: ['Old', 'Lama'] })[3]).toBe('Edited');
  });
});

describe('stages and frequencies (G.5 STAGES, FREQ)', () => {
  it('builds stage entries with src and rec by source', () => {
    const def = { key: 'risk', position: 2, labelEn: 'Risk', labelId: 'Risiko', questionEn: 'Show me how this risk was identified and assessed.', source: 'entity' as const, entityType: 'risk', riskProfileCode: 'information_security', clauseAtRisk: '6.1.2', overviewClause: 6, gateTypeLabel: null };
    expect(stageEntry(def, 38)).toEqual(ndt.STAGES.isms![1]);
    expect(stageEntry({ ...def, key: 'soa', labelEn: 'SoA', labelId: 'SoA', questionEn: 'q', source: 'justification' }, 93)).toEqual({ id: 'soa', l: ['SoA', 'SoA'], q: 'q', src: 'soa', rec: 93 });
    expect(stageEntry({ ...def, key: 'document', source: 'document' }, 5)).not.toHaveProperty('rec');
  });

  it('builds FREQ and FREQ_ORDER, the first definition of a code winning', () => {
    const defs = Object.entries(sample.raw.FREQ).map(([code, f], i) => ({ code, labelEn: f[0], labelId: f[1], periodDays: f[2], sortOrder: i + 1 }));
    expect(frequencyTable([...defs, { ...defs[0]!, labelEn: 'Other' }])).toEqual({ FREQ: sample.raw.FREQ, FREQ_ORDER: (ndt as unknown as { FREQ_ORDER: string[] }).FREQ_ORDER });
  });
});

describe('certification cycle rows (G.5 EVENTS, FOCUS, PREP, PAST, CYCLE_ITEMS)', () => {
  const events: AuditEventRow[] = ndt.EVENTS.qms!.map((e, i) => ({
    id: `e${i}`, updatedAt: new Date(0), scheduledAt: e.d, auditDays: e.days, shortLabel: e.t[0], nameEn: e.t[0], nameId: e.t[1], leadAuditorName: null,
    expectedFocus: e.next ? ndt.FOCUS.qms! : null, prepWindowDays: 60, outcomeSummary: e.result ? e.result[0] : null,
    eventType: e.type, outcome: e.outcome ?? null,
  }));
  const labels = Object.fromEntries(ndt.EVENTS.qms!.map((e) => [e.d, { t: e.t, ...(e.short ? { short: e.short } : {}), ...(e.result ? { result: e.result } : {}) }]));

  it('reproduces the QMS events with their bilingual labels, the next event and the focus', () => {
    expect(deriveEvents(events, today, labels)).toEqual(ndt.EVENTS.qms);
    expect(nextAuditEvent(events, today)!.scheduledAt).toBe('2026-12-03');
    expect(deriveFocus(nextAuditEvent(events, today))).toBe(ndt.FOCUS.qms);
    expect(deriveFocus(null)).toBe('-');
    expect(deriveEvents(events, today)[0]).toEqual({ t: 'Recertification (2015 ed.)', d: '2023-06-22', days: 2, result: 'Certified, 1 Minor', type: 'recertification', outcome: 'recommended' });
    // An event without a stored type or outcome (a row read before they were loaded) has neither field.
    expect(deriveEvents([{ ...events[0]!, eventType: undefined, outcome: null }], today)[0]).toEqual({ t: 'Recertification (2015 ed.)', d: '2023-06-22', days: 2, result: 'Certified, 1 Minor' });
  });

  it('builds preparation, past findings, cycle items and finding counts', () => {
    const prep = ndt.PREP.isms!.map(([title, owner, due, st], i) => ({
      id: `p${i}`, updatedAt: new Date(0), auditEventId: i === 0 ? 'other' : 'next', title, owner, dueAt: due,
      status: ({ done: 'done', progress: 'in_progress', open: 'not_started' } as const)[st], position: i,
    }));
    expect(derivePrep(prep, { id: 'next' })).toEqual(ndt.PREP.isms!.slice(1));
    expect(derivePrep(prep, null)).toEqual([]);
    const findings = [
      ...ndt.PAST.isms!.map(([code, label, clause, title, state, note], i) => ({
        id: code, code, title, classification: label.toLowerCase() as 'major' | 'minor' | 'ofi', clauseRef: clause, source: 'certification_audit' as const,
        status: state === 'closed' ? ('closed' as const) : ('open' as const), statusNote: note, position: i,
      })),
      { id: 'ia', code: 'IA-2026-01', title: 't', classification: 'major' as const, clauseRef: null, source: 'internal_audit' as const, status: 'open' as const, statusNote: null, position: 9 },
      { id: 'sg', code: 'SG-1', title: 't', classification: 'signal' as const, clauseRef: null, source: 'certification_audit' as const, status: 'open' as const, statusNote: null, position: 10 },
    ];
    expect(derivePast(findings)).toEqual(ndt.PAST.isms);
    expect(findingCounts(findings)).toEqual({ open: 2, major: 1 });
    const cycle = ndt.CYCLE_ITEMS.qms!.map(([code, title, owner, due, st, note], i) => ({
      id: `c${i}`, updatedAt: new Date(0), cycleId: 'latest', requirementCode: code, title, owner, dueAt: due,
      status: ({ done: 'done', progress: 'in_progress', open: 'not_started' } as const)[st], conditionNote: note || null, position: i,
    }));
    expect(deriveCycleItems([...cycle, { ...cycle[0]!, cycleId: 'old' }], 'latest')).toEqual(ndt.CYCLE_ITEMS.qms);
  });
});

describe('drift (G.5 DRIFT, drift.evaluate predicates)', () => {
  it('reproduces the sample ISMS patterns from definitions and stored rows', () => {
    const kinds: Record<string, 'stale_risk' | 'unverif' | 'metric' | 'manual'> = { risk12: 'stale_risk', unverif: 'unverif', metric: 'metric', mr: 'manual' };
    const defs = ndt.DRIFT.isms!.map((d, i) => ({ code: d.id, labelEn: d.l[0], labelId: d.l[1], sourceKind: kinds[d.id]!, sourceStage: null, predicate: {}, sortOrder: i }));
    const results = ndt.DRIFT.isms!.flatMap((d) => (d.rows ?? []).map(([code, title, holder, due], i) => ({ id: `${d.id}${i}`, ruleCode: d.id, entityCode: code, title, holder, dueAt: due, detectedOn: '2026-09-29', position: i })));
    expect(deriveDriftPatterns([...defs].reverse(), results)).toEqual(ndt.DRIFT.isms);
  });

  it('evaluates the predicates', () => {
    expect(monthsBefore('2026-09-29', 12)).toBe('2025-09-29');
    expect(monthsBefore('2026-03-31', 1)).toBe('2026-02-28');
    expect(isStaleRisk({ assessedAt: '2025-08-25' }, today)).toBe(true);
    expect(isStaleRisk({ assessedAt: '2026-08-30' }, today)).toBe(false);
    expect(isStaleRisk({ assessedAt: null }, today)).toBe(true);
    expect(lacksValidDueDiligence([{ status: 'completed', validUntil: '2026-09-28' }], today)).toBe(true);
    expect(lacksValidDueDiligence([{ status: 'completed', validUntil: '2026-09-29' }], today)).toBe(false);
    expect(isStaleMetric({ lastMeasuredAt: '2026-08-28', periodDays: 30 }, today)).toBe(true);
    expect(isStaleMetric({ lastMeasuredAt: '2026-08-29', periodDays: 30 }, today)).toBe(false);
    expect(lacksScheduledExercise([{ plannedAt: '2026-12-01', performedAt: null }], today)).toBe(false);
    expect(lacksScheduledExercise([{ plannedAt: '2025-01-01', performedAt: '2025-01-01' }], today)).toBe(true);
    const evs = ndt.bundles.bcms!.evs.map((e) => ({ integ: e.integ as never }));
    expect(evidenceWithoutHashOf(evs).length).toBe(ndt.bundles.bcms!.evs.filter((e) => e.integ === 'nohash').length);
    expect(unverifiableEvidenceOf(ndt.bundles.isms!.evs.map((e) => ({ integ: e.integ as never }))).length).toBe(3);
  });
});

describe('implementation overview (UI 2.6)', () => {
  it('computes maturity values, levels, open items per clause, blockers and the next gate', () => {
    expect(maturityValues(88, 3)).toEqual([100, 88, 70, 66]);
    expect(maturityValues(10, 0)).toEqual([24, 10, 0, 0]);
    expect(maturityLevel(62.5)).toBe(3);
    expect(clauseLevel(100, 0)).toBe(4);
    const clauseOf = (stage: string) => ({ context: 4, risk: 6, document: 7, metric: 9 } as Record<string, number>)[stage] ?? 8;
    expect(openPerClause([{ stage: 'risk' }, { stage: 'risk' }, { stage: 'evidence' }], clauseOf, 3)).toEqual({ 4: 0, 5: 0, 6: 2, 7: 0, 8: 1, 9: 0, 10: 3 });
    const gate = { id: 'R-031', type: ['Risk', 'Risiko'] as [string, string], why: ['Select', 'Select'] as [string, string], h: 'rina', due: null, key: 'x:R-031' };
    const item = (id: string, due: string) => ({ key: `isms:x:${id}`, stage: 'risk', kind: 'x' as const, id, title: [id, id] as [string, string], act: ['a', 'a'] as [string, string], h: 'bagus', due, st: 'overdue' as const, after: false, gate: false, up: [], down: [], q: '' });
    const blockers = overviewBlockers([gate], [item('R-2', '2026-09-20'), item('R-1', '2026-09-10')], (id) => (id === 'R-031' ? 'Unpatched hypervisor' : null));
    expect(blockers.map((b) => [b.id, b.title[0]])).toEqual([['R-031', 'Unpatched hypervisor'], ['R-1', 'R-1'], ['R-2', 'R-2']]);
    const phase = (no: number, gateFlag: boolean, verified: number) => ({ no, n: `P${no}`, gate: gateFlag, total: 2, c: { verified, complete: 0, progress: 0, blocked: 0, ns: 0, locked: 0 } });
    expect(nextGate([phase(1, false, 1), phase(2, true, 1)], 4)).toEqual({ no: 2, name: 'P2', items: 4 });
    expect(nextGate([phase(2, true, 2)], 0)).toBeNull();
  });
});

describe('record refs (G.5 refs)', () => {
  it('keys records by system, kind and business id, with the module and a weak ETag', () => {
    const refs = new RefCollector();
    const at = new Date('2026-09-01T00:00:00.000Z');
    const key = refs.add('isms', 'x', 'R-031', recordRef('x', 'risk', '44444444-4444-4444-8444-444444444444', 'R-031', at));
    refs.add('isms', 'x', 'R-031', recordRef('x', 'risk', '55555555-5555-4555-8555-555555555555', 'R-031', at));
    expect(key).toBe('isms:x:R-031');
    expect(refs.refs).toEqual({ 'isms:x:R-031': { module: 'audit', entityType: 'risk', id: '44444444-4444-4444-8444-444444444444', code: 'R-031', etag: `W/"${at.getTime()}"` } });
    expect(recordRef('req', 'applicability_entry', 'id', 'A.5.1', at).module).toBe('implementation');
    expect(recordRef('ev', 'evidence', 'id', 'EV-1', at).module).toBe('surveillance');
  });
});
