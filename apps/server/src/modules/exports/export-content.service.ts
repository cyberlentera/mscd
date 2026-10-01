// The content of every export (build plan D.3, E.2 `export.build`, F.15, D-04): the bytes, the file name and the
// content type, produced for one principal, so every list passes through `ScopePolicy` exactly as the screens do.
//
// - Statement of Applicability (XLSX or CSV): ID, title, theme, applicable, justification, status, owner,
//   implementing document, frequency, last evidence, freshness, integrity; the rows of `GET /ms/{ms}/applicability`.
// - Document register (XLSX or CSV): the UI 1.6 columns; the rows of `GET /ms/{ms}/documents`.
// - Readiness report (PDF): the five summary cards, clause readiness (clauses 4 to 10), audit readiness per chain
//   stage, gate items and blockers (blocked activities and blocked requirements).
// - Portfolio board (PDF): one section per system in which the principal holds `export.run` (the permission rule of
//   D.3), each on a page of its own, with the portfolio card numbers of UI 2.8.
// - Audit trail (CSV): the full entries of one system, through the audit module's formula-safe export.
//
// Used by the synchronous routes in the api (the session principal) and by `export.build` in the worker (the
// requester rebuilt from the task, `principalFor`).
import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import type { ExportFormat, ExportKind } from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { fmtDay } from '../../common/dates';
import { NotFoundError, ValidationError } from '../../common/problems';
import { PERMISSION_EVALUATOR, type PermissionEvaluator, type Principal, type TenantInfo, type Trx } from '../../common/tokens';
import { AuditTrailService } from '../audit/audit-trail.service';
import { ScopePolicyService } from '../authz/scope-policy';
import { ReadModelService, portfolioCounts, systemFields } from '../read-model';
import { ScreenReadService } from '../read-model-api/screen-read.service';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { PdfReport } from './pdf-report';
import { sheetBytes, type SheetData, type SheetFormat } from './sheets';

export type Lang = 'en' | 'id';

/** A finished export. */
export interface ExportFile {
  body: Buffer | Readable;
  fileName: string;
  /** The type the server generated (F.13 "the server's own type for generated files"). */
  contentType: string;
  /** Byte length when the body is a buffer. */
  size: number | null;
}

export interface ExportSpec {
  type: ExportKind;
  ms?: string;
  format: ExportFormat;
}

/** Formats each export type is offered in. */
export const EXPORT_FORMATS: Readonly<Record<ExportKind, readonly ExportFormat[]>> = {
  portfolio_board: ['pdf'],
  readiness: ['pdf'],
  soa: ['xlsx', 'csv'],
  document_register: ['xlsx', 'csv'],
  audit_trail: ['csv'],
};

export const CONTENT_TYPES: Readonly<Record<ExportFormat, string>> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
};

/** 400 `validation` when the format is not offered for the type. */
export function assertFormat(spec: ExportSpec): void {
  if (!EXPORT_FORMATS[spec.type].includes(spec.format)) {
    throw new ValidationError([{ path: 'format', message: `${spec.type} exports are available as ${EXPORT_FORMATS[spec.type].join(' or ')}` }]);
  }
}

const NAMES: Readonly<Record<ExportKind, string>> = {
  portfolio_board: 'portfolio-board',
  readiness: 'readiness-report',
  soa: 'statement-of-applicability',
  document_register: 'document-register',
  audit_trail: 'audit-trail',
};

/** `<prefix>-<kind>-<date>.<format>`, for example `ISMS-statement-of-applicability-2026-09-29.xlsx`. */
export function exportFileName(prefix: string, type: ExportKind, today: string, format: ExportFormat): string {
  const safe = prefix.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'mscd';
  return `${safe}-${NAMES[type]}-${today}.${format}`;
}

// -----------------------------------------------------------------------------------------------------------------
// Labels
// -----------------------------------------------------------------------------------------------------------------

type Labels = Readonly<Record<string, readonly [string, string]>>;

const REQ_STATUS: Labels = {
  implemented: ['Implemented', 'Diterapkan'],
  partial: ['Partially implemented', 'Diterapkan sebagian'],
  planned: ['Planned', 'Direncanakan'],
  ns: ['Not started', 'Belum dimulai'],
  blocked: ['Blocked', 'Terhambat'],
  na: ['Not applicable', 'Tidak berlaku'],
  complete: ['Complete, awaiting verification', 'Selesai, menunggu verifikasi'],
};
const DOC_STATUS: Labels = {
  approved: ['Approved', 'Disetujui'],
  expired: ['Expired', 'Kedaluwarsa'],
  review: ['In review', 'Dalam tinjauan'],
  draft: ['Draft', 'Draf'],
};
const FRESHNESS: Labels = { fresh: ['Fresh', 'Segar'], aging: ['Aging', 'Menua'], expired: ['Expired', 'Kedaluwarsa'], critical: ['Critical', 'Kritis'] };
const INTEGRITY: Labels = { ok: ['OK', 'OK'], degraded: ['Degraded', 'Menurun'], broken: ['Broken', 'Rusak'] };
const CLAUSES: Readonly<Record<number, readonly [string, string]>> = {
  4: ['Context of the organisation', 'Konteks organisasi'],
  5: ['Leadership', 'Kepemimpinan'],
  6: ['Planning', 'Perencanaan'],
  7: ['Support', 'Dukungan'],
  8: ['Operation', 'Operasi'],
  9: ['Performance evaluation', 'Evaluasi kinerja'],
  10: ['Improvement', 'Peningkatan'],
};

const T = {
  soaSheet: ['Statement of Applicability', 'Pernyataan Keberlakuan'],
  docSheet: ['Document register', 'Daftar dokumen'],
  soaColumns: [
    ['ID', 'ID'], ['Title', 'Judul'], ['Theme', 'Tema'], ['Applicable', 'Berlaku'], ['Justification', 'Justifikasi'], ['Status', 'Status'],
    ['Owner', 'Pemilik'], ['Implementing document', 'Dokumen pelaksana'], ['Frequency', 'Frekuensi'], ['Last evidence', 'Bukti terakhir'],
    ['Freshness', 'Kesegaran'], ['Integrity', 'Integritas'],
  ],
  docColumns: [
    ['ID', 'ID'], ['Title', 'Judul'], ['Type', 'Jenis'], ['Version', 'Versi'], ['Status', 'Status'], ['Approved', 'Disetujui'],
    ['Next review', 'Tinjauan berikutnya'], ['Owner', 'Pemilik'], ['Shared', 'Dibagikan'], ['System', 'Sistem'],
  ],
  yes: ['Yes', 'Ya'],
  no: ['No', 'Tidak'],
  readinessTitle: ['Readiness report', 'Laporan kesiapan'],
  boardTitle: ['Portfolio board', 'Papan portofolio'],
  generated: ['Generated', 'Dibuat'],
  by: ['for', 'untuk'],
  summary: ['Summary', 'Ringkasan'],
  clauseReadiness: ['Clause readiness', 'Kesiapan klausul'],
  clause: ['Clause', 'Klausul'],
  readiness: ['Readiness', 'Kesiapan'],
  stages: ['Audit readiness per stage', 'Kesiapan audit per tahap'],
  stage: ['Stage', 'Tahap'],
  records: ['Records', 'Catatan'],
  open: ['Open', 'Terbuka'],
  overdue: ['Overdue', 'Terlambat'],
  after: ['After audit', 'Setelah audit'],
  ready: ['Ready', 'Siap'],
  next: ['Next due', 'Jatuh tempo berikutnya'],
  gateItems: ['Gate items', 'Item gerbang'],
  type: ['Type', 'Jenis'],
  why: ['Reason', 'Alasan'],
  holder: ['Holder', 'Pemegang'],
  due: ['Due', 'Jatuh tempo'],
  blockers: ['Blockers', 'Penghambat'],
  item: ['Item', 'Item'],
  title: ['Title', 'Judul'],
  value: ['Value', 'Nilai'],
  blockedBy: ['Blocked by', 'Dihambat oleh'],
  noGate: ['No open gate items.', 'Tidak ada item gerbang terbuka.'],
  noBlockers: ['Nothing is blocked.', 'Tidak ada yang terhambat.'],
  nextAudit: ['Next audit', 'Audit berikutnya'],
  noAudit: ['No audit scheduled', 'Tidak ada audit terjadwal'],
  edition: ['Standard', 'Standar'],
  scope: ['Scope', 'Ruang lingkup'],
  certification: ['Certification', 'Sertifikasi'],
  stageNow: ['Stage', 'Tahap'],
  cardNumbers: ['Portfolio card', 'Kartu portofolio'],
  findings: ['Open findings', 'Temuan terbuka'],
  major: ['major', 'mayor'],
  docExpired: ['Expired documents', 'Dokumen kedaluwarsa'],
  evCritical: ['Critical evidence', 'Bukti kritis'],
  evUnverifiable: ['Unverifiable evidence', 'Bukti tidak dapat diverifikasi'],
  afterAudit: ['Chain items due after the audit', 'Item rantai jatuh tempo setelah audit'],
  requirements: ['Requirements', 'Persyaratan'],
  implemented: ['Implemented', 'Diterapkan'],
  documentsApproved: ['Documents approved', 'Dokumen disetujui'],
  noSystems: ['No management system to show.', 'Tidak ada sistem manajemen untuk ditampilkan.'],
  control: ['Control', 'Kontrol'],
  activity: ['Activity', 'Aktivitas'],
  inDays: ['in', 'dalam'],
  days: ['days', 'hari'],
} as const;

function l(pair: readonly [string, string], lang: Lang): string {
  return lang === 'id' ? pair[1] : pair[0];
}

function label(map: Labels, code: string | null | undefined, lang: Lang): string {
  if (!code) return '';
  const pair = map[code];
  return pair ? l(pair, lang) : code;
}

/** Arbitrary but large page: the exports read every row of a list route in one call. */
const ALL = { page: 1, pageSize: 1_000_000 } as const;

interface SystemInfo {
  id: string;
  slug: string;
  code: string;
  name: string;
}

@Injectable()
export class ExportContentService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly clock: Clock,
    private readonly screens: ScreenReadService,
    private readonly readModel: ReadModelService,
    private readonly scopePolicy: ScopePolicyService,
    private readonly auditTrail: AuditTrailService,
    @Inject(PERMISSION_EVALUATOR) private readonly evaluator: PermissionEvaluator,
  ) {}

  /** The requester of a task as a principal without a session (worker side, F.7 checks and `ScopePolicy`). */
  async principalFor(trx: Trx, org: TenantInfo, userId: string): Promise<Principal | null> {
    const user = await trx
      .selectFrom('platform.app_user')
      .select(['id', 'handle', 'email', 'display_name', 'job_title', 'kind', 'status', 'deleted_at'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user || user.status !== 'active' || user.deleted_at) return null;
    return {
      user: { id: user.id, handle: user.handle, email: user.email, displayName: user.display_name, jobTitle: user.job_title, kind: user.kind },
      org,
      session: null,
    };
  }

  /** The language preference of a user (`lang`), English by default. */
  async languageOf(trx: Trx, userId: string): Promise<Lang> {
    const row = await trx.selectFrom('platform.user_preference').select('value').where('user_id', '=', userId).where('key', '=', 'lang').executeTakeFirst();
    return row?.value === 'id' ? 'id' : 'en';
  }

  /** True when the principal may run the export now (D.3 rules, checked again at download and in the job). */
  async allowed(principal: Principal, spec: ExportSpec): Promise<boolean> {
    try {
      if (spec.type === 'portfolio_board') return (await this.evaluator.evaluate(principal, 'export.run', { scope: 'any_ms' })) !== null;
      const permission = spec.type === 'audit_trail' ? 'audit_trail.read' : 'export.run';
      return (await this.evaluator.evaluate(principal, permission, { scope: 'ms', ms: spec.ms })) !== null;
    } catch (error) {
      if (error instanceof NotFoundError) return false;
      throw error;
    }
  }

  /** Builds one export for the principal. */
  async build(principal: Principal, spec: ExportSpec, lang: Lang): Promise<ExportFile> {
    assertFormat(spec);
    switch (spec.type) {
      case 'portfolio_board':
        return this.portfolio(principal, lang);
      case 'readiness':
        return this.readiness(principal, this.msOf(spec), lang);
      case 'soa':
        return this.soa(principal, this.msOf(spec), spec.format as SheetFormat, lang);
      case 'document_register':
        return this.documents(principal, this.msOf(spec), spec.format as SheetFormat, lang);
      case 'audit_trail':
        return this.auditTrailCsv(principal, this.msOf(spec));
    }
  }

  private msOf(spec: ExportSpec): string {
    if (!spec.ms) throw new ValidationError([{ path: 'ms', message: `${spec.type} exports need a management system` }]);
    return spec.ms;
  }

  private orgOf(principal: Principal): TenantInfo {
    if (!principal.org) throw new NotFoundError('No organisation is selected');
    return principal.org;
  }

  private today(principal: Principal): string {
    return this.clock.todayIn(this.orgOf(principal).timeZone);
  }

  /** The system of the path (404 unknown) and the display names of the organisation's members. */
  private async context(principal: Principal, ms: string | null): Promise<{ system: SystemInfo | null; names: Map<string, string> }> {
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      let system: SystemInfo | null = null;
      if (ms) {
        const row = await trx.selectFrom('management_system').select(['id', 'slug', 'code', 'name']).where('slug', '=', ms).where('deleted_at', 'is', null).executeTakeFirst();
        if (!row) throw new NotFoundError('Unknown management system');
        system = row;
      }
      const { rows } = await sql<{ handle: string; display_name: string }>`
        select u.handle, u.display_name from platform.org_membership m
        join platform.app_user u on u.id = m.user_id and u.deleted_at is null
        where m.organization_id = ${this.orgOf(principal).id}::uuid and m.deleted_at is null`.execute(trx);
      return { system, names: new Map(rows.map((r) => [r.handle, r.display_name])) };
    });
  }

  private personName(names: Map<string, string>, handle: string | null | undefined): string {
    if (!handle || handle === 'none') return '';
    return names.get(handle) ?? handle;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Spreadsheets
  // -------------------------------------------------------------------------------------------------------------

  async soa(principal: Principal, ms: string, format: SheetFormat, lang: Lang): Promise<ExportFile> {
    const { system, names } = await this.context(principal, ms);
    const page = await this.screens.applicability(principal, ms, lang, { ...ALL });
    const sheet: SheetData = {
      sheetName: l(T.soaSheet, lang),
      columns: [
        { header: l(T.soaColumns[0], lang), width: 12 },
        { header: l(T.soaColumns[1], lang), width: 44 },
        { header: l(T.soaColumns[2], lang), width: 22 },
        { header: l(T.soaColumns[3], lang), width: 11 },
        { header: l(T.soaColumns[4], lang), width: 48 },
        { header: l(T.soaColumns[5], lang), width: 24 },
        { header: l(T.soaColumns[6], lang), width: 22 },
        { header: l(T.soaColumns[7], lang), width: 20 },
        { header: l(T.soaColumns[8], lang), width: 14 },
        { header: l(T.soaColumns[9], lang), width: 14, date: true },
        { header: l(T.soaColumns[10], lang), width: 12 },
        { header: l(T.soaColumns[11], lang), width: 12 },
      ],
      rows: page.items.map((r) => [
        r.id,
        r.title,
        r.theme,
        l(r.st === 'na' ? T.no : T.yes, lang),
        r.just,
        label(REQ_STATUS, r.st, lang),
        this.personName(names, r.owner),
        r.doc === '-' ? '' : r.doc,
        r.freq,
        r.lastEvidence,
        label(FRESHNESS, r.freshness, lang),
        label(INTEGRITY, r.integrity, lang),
      ]),
    };
    return this.sheetFile(principal, sheet, format, exportFileName(system!.code, 'soa', this.today(principal), format));
  }

  async documents(principal: Principal, ms: string, format: SheetFormat, lang: Lang): Promise<ExportFile> {
    const { system, names } = await this.context(principal, ms);
    const page = await this.screens.documents(principal, ms, lang, { ...ALL });
    const sheet: SheetData = {
      sheetName: l(T.docSheet, lang),
      columns: [
        { header: l(T.docColumns[0], lang), width: 12 },
        { header: l(T.docColumns[1], lang), width: 44 },
        { header: l(T.docColumns[2], lang), width: 14 },
        { header: l(T.docColumns[3], lang), width: 9 },
        { header: l(T.docColumns[4], lang), width: 12 },
        { header: l(T.docColumns[5], lang), width: 13, date: true },
        { header: l(T.docColumns[6], lang), width: 13, date: true },
        { header: l(T.docColumns[7], lang), width: 22 },
        { header: l(T.docColumns[8], lang), width: 10 },
        { header: l(T.docColumns[9], lang), width: 10 },
      ],
      rows: page.items.map((d) => [
        d.id,
        d.title,
        d.tier,
        d.ver,
        label(DOC_STATUS, d.st, lang),
        d.appr === '' ? null : d.appr,
        d.rev === '' ? null : d.rev,
        this.personName(names, d.owner),
        l(d.shared ? T.yes : T.no, lang),
        d.ms,
      ]),
    };
    return this.sheetFile(principal, sheet, format, exportFileName(system!.code, 'document_register', this.today(principal), format));
  }

  private async sheetFile(principal: Principal, sheet: SheetData, format: SheetFormat, fileName: string): Promise<ExportFile> {
    const body = await sheetBytes(sheet, format, { creator: principal.user.displayName, created: this.clock.now() });
    return { body, fileName, contentType: CONTENT_TYPES[format], size: body.length };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Readiness report
  // -------------------------------------------------------------------------------------------------------------

  async readiness(principal: Principal, ms: string, lang: Lang): Promise<ExportFile> {
    const { system, names } = await this.context(principal, ms);
    const today = this.today(principal);
    const summary = await this.screens.summary(principal, ms, lang);
    const stages = await this.screens.stages(principal, ms, lang);
    const gates = await this.screens.gates(principal, ms, lang);
    const next = await this.screens.nextEvent(principal, ms, lang);
    const snapshot = await this.readModel.msSnapshot(principal, ms);
    const org = this.orgOf(principal);

    const report = await PdfReport.create({
      title: `${system!.code} ${l(T.readinessTitle, lang)}`,
      subject: system!.name,
      footer: `${org.name}, ${system!.code} ${l(T.readinessTitle, lang)}, ${fmtDay(today, lang)}`,
      createdAt: this.clock.now(),
    });
    report.title(`${system!.code}: ${l(T.readinessTitle, lang)}`, `${system!.name}. ${org.name}. ${l(T.generated, lang)} ${fmtDay(today, lang)} ${l(T.by, lang)} ${principal.user.displayName}.`);
    report.facts([
      [
        l(T.nextAudit, lang),
        next ? `${next.name}, ${fmtDay(next.scheduledAt, lang)} (${l(T.inDays, lang)} ${next.daysLeft} ${l(T.days, lang)})${next.certificationBody ? `, ${next.certificationBody}` : ''}` : l(T.noAudit, lang),
      ],
    ]);
    report.heading(l(T.summary, lang));
    report.facts(summary.cards.map((c) => [c.label, c.total !== undefined ? `${c.count} / ${c.total}` : String(c.count)] as const));

    report.heading(l(T.clauseReadiness, lang));
    report.table(
      [
        { header: l(T.clause, lang), width: 3 },
        { header: l(T.readiness, lang), width: 1, align: 'right' },
      ],
      summary.maturity.map((m) => [`${m.clause} ${l(CLAUSES[m.clause] ?? ['', ''], lang)}`, `${m.readiness}%`]),
    );

    report.heading(l(T.stages, lang));
    report.table(
      [
        { header: l(T.stage, lang), width: 2.4 },
        { header: l(T.records, lang), width: 1, align: 'right' },
        { header: l(T.open, lang), width: 1, align: 'right' },
        { header: l(T.overdue, lang), width: 1, align: 'right' },
        { header: l(T.after, lang), width: 1.2, align: 'right' },
        { header: l(T.ready, lang), width: 1, align: 'right' },
        { header: l(T.next, lang), width: 1.6 },
      ],
      stages.map((s) => [s.label, String(s.rec), String(s.open), String(s.overdue), String(s.after), `${s.pct}%`, s.next ? fmtDay(s.next, lang) : '']),
    );

    report.heading(`${l(T.gateItems, lang)} (${gates.length})`);
    report.table(
      [
        { header: 'ID', width: 1.3 },
        { header: l(T.type, lang), width: 1.2 },
        { header: l(T.why, lang), width: 4 },
        { header: l(T.holder, lang), width: 1.8 },
        { header: l(T.due, lang), width: 1.3 },
      ],
      gates.map((g) => [g.id, g.type, g.why, this.personName(names, g.holder), g.due ? fmtDay(g.due, lang) : '']),
      l(T.noGate, lang),
    );

    const blockers: string[][] = [];
    for (const phase of snapshot.bundle.phases) {
      for (const act of phase.acts) {
        if (act.st !== 'blocked') continue;
        blockers.push([`${l(T.activity, lang)} ${act.no}`, act.title, act.blocker ?? '', this.personName(names, act.owner)]);
      }
    }
    for (const req of snapshot.bundle.reqs) {
      if (req.st !== 'blocked') continue;
      blockers.push([`${l(T.control, lang)} ${req.id}`, req.title, req.note ?? '', this.personName(names, req.owner)]);
    }
    report.heading(`${l(T.blockers, lang)} (${blockers.length})`);
    report.table(
      [
        { header: l(T.item, lang), width: 1.6 },
        { header: l(T.title, lang), width: 3.4 },
        { header: l(T.blockedBy, lang), width: 2.2 },
        { header: l(T.holder, lang), width: 1.6 },
      ],
      blockers,
      l(T.noBlockers, lang),
    );
    const body = await report.finish();
    return { body, fileName: exportFileName(system!.code, 'readiness', today, 'pdf'), contentType: CONTENT_TYPES.pdf, size: body.length };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Portfolio board
  // -------------------------------------------------------------------------------------------------------------

  /** The systems of the organisation in which the principal holds `export.run`, in portfolio order. */
  async boardSystems(principal: Principal): Promise<string[]> {
    const slugs = await this.tenancy.withTenant(tenantContextOf(principal), async (trx) =>
      (
        await trx
          .selectFrom('management_system')
          .select('slug')
          .where('deleted_at', 'is', null)
          .where('status', '<>', 'archived')
          .orderBy('position')
          .orderBy('slug')
          .execute()
      ).map((r) => r.slug),
    );
    const allowed: string[] = [];
    for (const slug of slugs) if (await this.allowed(principal, { type: 'soa', ms: slug, format: 'xlsx' })) allowed.push(slug);
    return allowed;
  }

  async portfolio(principal: Principal, lang: Lang): Promise<ExportFile> {
    const org = this.orgOf(principal);
    const today = this.today(principal);
    const allowed = new Set(await this.boardSystems(principal));
    const sections = await this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const all = await this.readModel.allSystemSnapshotsIn(trx, org);
      const out = [];
      for (const { system, snapshot } of all) {
        if (!allowed.has(system.slug)) continue;
        const scope = await this.scopePolicy.scopeContext(trx, principal, system.slug);
        const view = this.scopePolicy.projectSnapshot(scope, snapshot);
        out.push({ fields: systemFields(system, today), counts: portfolioCounts(view.bundle), view });
      }
      return out;
    });

    const title = l(T.boardTitle, lang);
    const report = await PdfReport.create({ title: `${org.name} ${title}`, footer: `${org.name}, ${title}, ${fmtDay(today, lang)}`, createdAt: this.clock.now() });
    if (sections.length === 0) {
      report.title(`${org.name}: ${title}`, `${l(T.generated, lang)} ${fmtDay(today, lang)} ${l(T.by, lang)} ${principal.user.displayName}.`);
      report.paragraph(l(T.noSystems, lang));
    }
    sections.forEach(({ fields, counts, view }, index) => {
      if (index > 0) report.newPage();
      const name = l(fields.name, lang);
      report.title(`${fields.short}: ${name}`, `${org.name}. ${title}, ${l(T.generated, lang)} ${fmtDay(today, lang)} ${l(T.by, lang)} ${principal.user.displayName}.`);
      const audit = fields.audit;
      report.facts([
        [l(T.edition, lang), `${fields.code} ${fields.ed}`],
        [l(T.scope, lang), fields.scope],
        [l(T.certification, lang), `${fields.cert}${fields.certifier ? `, ${fields.certifier}` : ''}`],
        [l(T.stageNow, lang), l(fields.stage, lang)],
        [
          l(T.nextAudit, lang),
          audit ? `${l(audit.name, lang)}, ${fmtDay(audit.date, lang)}` : l(T.noAudit, lang),
        ],
      ]);
      report.heading(l(T.cardNumbers, lang));
      const reqs = view.bundle.reqs;
      const docs = view.bundle.docs;
      report.table(
        [
          { header: l(T.item, lang), width: 4 },
          { header: l(T.value, lang), width: 1, align: 'right' },
        ],
        [
          [l(T.gateItems, lang), String(counts.gateItems)],
          [l(T.findings, lang), fields.findings.major > 0 ? `${fields.findings.open} (${fields.findings.major} ${l(T.major, lang)})` : String(fields.findings.open)],
          [l(T.docExpired, lang), String(counts.expiredDocuments)],
          [l(T.evCritical, lang), String(counts.criticalEvidence)],
          [l(T.evUnverifiable, lang), String(counts.unverifiableEvidence)],
          [l(T.afterAudit, lang), String(counts.afterAudit)],
          [l(T.implemented, lang), `${reqs.filter((r) => r.st === 'implemented').length} / ${reqs.length}`],
          [l(T.documentsApproved, lang), `${docs.filter((d) => d.st === 'approved').length} / ${docs.length}`],
        ],
      );
      report.heading(l(T.clauseReadiness, lang));
      report.table(
        [
          { header: l(T.clause, lang), width: 3 },
          { header: l(T.readiness, lang), width: 1, align: 'right' },
        ],
        fields.clauses.map((value, i) => [`${i + 4} ${l(CLAUSES[i + 4] ?? ['', ''], lang)}`, `${value}%`]),
      );
    });
    const body = await report.finish();
    return { body, fileName: exportFileName(org.slug, 'portfolio_board', today, 'pdf'), contentType: CONTENT_TYPES.pdf, size: body.length };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Audit trail
  // -------------------------------------------------------------------------------------------------------------

  async auditTrailCsv(principal: Principal, ms: string): Promise<ExportFile> {
    await this.context(principal, ms);
    const org = this.orgOf(principal);
    return {
      body: this.auditTrail.exportCsv(principal, ms),
      fileName: exportFileName(`${org.slug}-${ms}`, 'audit_trail', this.today(principal), 'csv'),
      contentType: CONTENT_TYPES.csv,
      size: null,
    };
  }
}
