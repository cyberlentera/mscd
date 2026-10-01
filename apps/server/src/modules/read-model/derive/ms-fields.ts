// Management system card and header fields (build plan G.5 `MS[]`, G.4 stored display values, TS 9.4, UI 1.2).
import type { AlertTone, ManagementSystem, MsAlertKind, Pair, StorageAdapter, StorageMode, Text } from '@mscd/shared';
import { routingModeLabel } from '../../storage';
import type { AuditEventRow } from './audit';
import { NONE } from './text';

/** A framework version a system uses (`ref.framework_version` with its framework). */
export interface VersionInfo {
  id: string;
  frameworkCode: string;
  frameworkName: string;
  edition: string;
  packId: string;
  packVersion: string;
  status: 'current' | 'transition' | 'withdrawn';
  preRelease: boolean;
  applicabilityTarget: 'catalogue_item' | 'requirement';
  installedAt: Date;
}

/** Pack labels of a version by key, as `[en, id]` (the Indonesian text falls back to the English one). */
export type PackLabels = Readonly<Record<string, Pair | undefined>>;

/** An open `ms_alert` row. */
export interface AlertRow {
  kind: MsAlertKind;
  tone: AlertTone;
  textEn: string;
  textId: string;
  raisedAt: Date;
}

export interface MsFieldsInput {
  slug: string;
  /** `management_system.code` (`ISMS`). */
  code: string;
  scope: string;
  certificationBody: string | null;
  color: string;
  /** `management_system.display` (G.4). */
  display: Readonly<Record<string, unknown>>;
  active: VersionInfo;
  target: VersionInfo | null;
  labels: PackLabels;
  /** Handle of the primary MS Manager (active grant), null when there is none. */
  primaryManager: string | null;
  nextEvent: AuditEventRow | null;
  /** Readiness per clause group 4 to 10 (`clause_readiness`). */
  readiness: ReadonlyMap<number, number>;
  findings: { open: number; major: number };
  alerts: readonly AlertRow[];
  defaultRepository: { slug: string; adapter: StorageAdapter };
  /** Mode of the system's active default routing rule (classification and object kind empty). */
  defaultRoutingMode: StorageMode | null;
  /** Approver of the system's own documents (the controller's per-system approver literal, UI 2.14). */
  approver: string | null;
}

function isPair(value: unknown): value is Pair {
  return Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === 'string');
}

function isText(value: unknown): value is Text {
  return typeof value === 'string' || isPair(value);
}

function label(labels: PackLabels, key: string): Pair | null {
  const value = labels[key];
  return value ? [value[0], value[1]] : null;
}

/** G.5 `ed`: the active edition, or `<active> to <target>` during a transition. */
export function editionText(active: Pick<VersionInfo, 'edition'>, target: Pick<VersionInfo, 'edition'> | null): string {
  return target ? `${active.edition} to ${target.edition}` : active.edition;
}

/** G.5 `locMode`: `Managed Vault` for a vault default, else `Customer Repository, ` plus the default rule's mode label. */
export function locModeText(adapter: StorageAdapter, defaultRoutingMode: StorageMode | null): string {
  if (adapter === 'managed_vault') return 'Managed Vault';
  return `Customer Repository, ${routingModeLabel(defaultRoutingMode ?? 'link')}`;
}

/** G.5 `theme` of a catalogue system: `{5: <label of catalogue.theme.5>, ...}` in English. */
export function themeLabels(labels: PackLabels): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    const match = /^catalogue\.theme\.(\d+)$/.exec(key);
    if (match && value) out[match[1]!] = value[0];
  }
  return out;
}

/** G.5 `banner`: the newest open alert. */
export function bannerOf(alerts: readonly AlertRow[]): ManagementSystem['banner'] {
  const newest = [...alerts].sort((a, b) => b.raisedAt.getTime() - a.raisedAt.getTime())[0];
  return newest ? { tone: newest.tone, text: [newest.textEn, newest.textId], kind: newest.kind } : undefined;
}

/** One `MS[]` entry (G.5). */
export function deriveManagementSystem(input: MsFieldsInput): ManagementSystem {
  const { display, labels, nextEvent } = input;
  const longName = label(labels, 'ms.long_name') ?? [input.code, input.code];
  const unit = input.active.applicabilityTarget === 'catalogue_item' ? 'ctrl' : 'req';
  const lead: Text = nextEvent?.leadAuditorName ?? (isText(display.lead) ? display.lead : '-');
  const ms: ManagementSystem = {
    id: input.slug,
    code: input.active.frameworkName,
    ed: editionText(input.active, input.target),
    short: input.code,
    name: longName,
    mgr: input.primaryManager ?? NONE,
    mgrRole: label(labels, 'ms.manager_role')?.[0] ?? '',
    color: input.color,
    scope: input.scope,
    certifier: input.certificationBody ?? '',
    lead,
    cert: isText(display.certLabel) ? display.certLabel : '-',
    stage: isPair(display.stage) ? display.stage : ['-', '-'],
    audit: nextEvent
      ? { name: [nextEvent.nameEn, nextEvent.nameId], date: nextEvent.scheduledAt, days: nextEvent.auditDays, prepWindowDays: nextEvent.prepWindowDays }
      : null,
    clauses: [4, 5, 6, 7, 8, 9, 10].map((c) => input.readiness.get(c) ?? 0),
    findings: { ...input.findings },
    loc: input.defaultRepository.slug,
    locMode: locModeText(input.defaultRepository.adapter, input.defaultRoutingMode),
    pack: typeof display.packLabel === 'string' ? display.packLabel : `${input.active.packId} v${input.active.packVersion}`,
    phase: isPair(display.phase) ? display.phase : ['-', '-'],
    unit,
  };
  const banner = bannerOf(input.alerts);
  if (banner) ms.banner = banner;
  if (unit === 'ctrl') ms.theme = themeLabels(labels);
  const gateName = label(labels, 'gate.name');
  if (gateName) ms.gateName = gateName;
  if (Array.isArray(display.gtSuggestions)) ms.gtSuggestions = display.gtSuggestions.filter((s): s is string => typeof s === 'string');
  if (input.approver) ms.approver = input.approver;
  return ms;
}
