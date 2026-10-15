// Texts of the per-screen read endpoints (build plan D.1 "Language": TS 9.2 endpoints return one string in the
// language of `Accept-Language`). Labels are kept as `[en, id]` pairs and resolved per request with `pick`.
import type { DocStatus, FreshnessStatus, IntegId, Pair, ReqStatus, Text } from '@mscd/shared';

export type Lang = 'en' | 'id';

/**
 * The response language of D.1: the first tag of `Accept-Language` (by quality, then order) whose primary subtag is
 * `id` or `en`; English when the header names neither.
 */
export function languageOf(header: string | string[] | undefined): Lang {
  const value = Array.isArray(header) ? header.join(',') : (header ?? '');
  const tags = value
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const quality = q ? Number(q.slice(2)) : 1;
      return { primary: tag.trim().toLowerCase().split('-')[0] ?? '', quality: Number.isFinite(quality) ? quality : 0, index };
    })
    .filter((t) => t.quality > 0 && (t.primary === 'en' || t.primary === 'id'))
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  return tags[0]?.primary === 'id' ? 'id' : 'en';
}

/** One string of a pair (or a plain text) in the response language. */
export function pick(text: Text | readonly [string, string], lang: Lang): string {
  if (typeof text === 'string') return text;
  return lang === 'id' ? text[1] : text[0];
}

export const UNASSIGNED: Pair = ['Unassigned', 'Belum ditugaskan'];

/** Summary card labels (UI 2.5 Controls tabs); the first two depend on the system's unit. */
export const CARD_LABELS = {
  implemented: { ctrl: ['Controls implemented', 'Kontrol diterapkan'], req: ['Requirements implemented', 'Persyaratan diterapkan'] },
  partial: ['Partially implemented', 'Sebagian diterapkan'],
  gateItems: ['Blocking items', 'Item penghambat'],
  documentsApproved: ['Documents approved', 'Dokumen disetujui'],
  documentsExpired: ['Documents expired', 'Dokumen kedaluwarsa'],
} as const satisfies Record<string, Pair | Record<'ctrl' | 'req', Pair>>;

/** Derived text of a phase (UI 2.7 counts): `<verified> of <total> verified`, then the blocked, locked and open parts. */
export function phaseText(c: { verified: number; complete: number; progress: number; blocked: number; ns: number; locked: number }, total: number, lang: Lang): string {
  if (total > 0 && c.locked === total) return lang === 'id' ? 'Terkunci sampai fase titik periksa terverifikasi' : 'Locked until the checkpoint phase is verified';
  const parts = [lang === 'id' ? `${c.verified} dari ${total} terverifikasi` : `${c.verified} of ${total} verified`];
  if (c.complete) parts.push(lang === 'id' ? `${c.complete} menunggu verifikasi` : `${c.complete} awaiting verification`);
  if (c.blocked) parts.push(lang === 'id' ? `${c.blocked} terblokir` : `${c.blocked} blocked`);
  if (c.locked) parts.push(lang === 'id' ? `${c.locked} terkunci` : `${c.locked} locked`);
  return parts.join(', ');
}

/** Requirement status labels (C.11 UI codes). */
export const REQ_STATUS_LABELS: Readonly<Record<ReqStatus, Pair>> = {
  implemented: ['Implemented', 'Diterapkan'],
  partial: ['Partially implemented', 'Sebagian diterapkan'],
  planned: ['Planned', 'Direncanakan'],
  ns: ['Not started', 'Belum mulai'],
  blocked: ['Blocked: open blocking item', 'Terblokir: item penghambat terbuka'],
  na: ['Not applicable', 'Tidak berlaku'],
  complete: ['Complete, awaiting verification', 'Selesai, menunggu verifikasi'],
};

/** Document status labels (C.11 UI codes). */
export const DOC_STATUS_LABELS: Readonly<Record<DocStatus, Pair>> = {
  approved: ['Approved', 'Disetujui'],
  expired: ['Review date passed', 'Tanggal tinjauan terlewati'],
  review: ['In review', 'Dalam tinjauan'],
  draft: ['Draft', 'Draf'],
};

/** Freshness band labels (E.3). */
export const FRESHNESS_LABELS: Readonly<Record<FreshnessStatus, Pair>> = {
  fresh: ['Fresh', 'Mutakhir'],
  aging: ['Aging', 'Hampir kedaluwarsa'],
  expired: ['Expired', 'Kedaluwarsa'],
  critical: ['Critical', 'Kritis'],
};

/** UI integrity code labels (the web's `INTEG`, UI 1.7). */
export const INTEG_LABELS: Readonly<Record<IntegId, Pair>> = {
  ok: ['Verified', 'Terverifikasi'],
  changed: ['Version changed', 'Versi berubah'],
  moved: ['Moved', 'Dipindahkan'],
  missing: ['Missing', 'Hilang'],
  revoked: ['Access revoked', 'Akses dicabut'],
  pending: ['Check pending', 'Pemeriksaan tertunda'],
  nohash: ['No hash (Google Doc)', 'Tanpa hash (Google Doc)'],
};

/** State of a chain record of an entity stage. */
export const RECORD_STATE: Readonly<Record<'open' | 'ready', Pair>> = {
  open: ['Action open', 'Tindakan terbuka'],
  ready: ['No open action', 'Tidak ada tindakan terbuka'],
};

/** Titles of chain nodes without a record (UI 2.9 `resolveNode`). */
export const NODE_MISSING: Readonly<Record<'record' | 'evidence', Pair>> = {
  record: ['No record linked', 'Tidak ada rekaman tertaut'],
  evidence: ['No evidence recorded this cycle', 'Belum ada evidence tercatat siklus ini'],
};
