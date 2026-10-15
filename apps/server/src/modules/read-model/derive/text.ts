// Texts the read model composes in both interface languages (build plan D-18, D.1 "Language": `/ui/*` returns
// `[en, id]` pairs). The wording is the sample controller's (UI 2.3, 2.4), so the API shows the same text.
import type { IntegId, Pair, ReqStatus } from '@mscd/shared';

/** A text that reads the same in both languages. */
export function same(text: string): Pair {
  return [text, text];
}

/** Person handle of an unassigned record (BR-45). */
export const NONE = 'none';

/** Display names by handle (`PEOPLE`), used where a text names a person. */
export type PeopleNames = ReadonlyMap<string, string>;

/** Display name of a person in both languages; `none` and unknown handles read as Unassigned. */
export function personName(people: PeopleNames, handle: string | null | undefined): Pair {
  const name = handle && handle !== NONE ? people.get(handle) : undefined;
  return name ? same(name) : ['Unassigned', 'Belum ditugaskan'];
}

/** Chain item action of a requirement by UI status (UI 2.3); `complete` is composed with the person's name. */
export const REQUIREMENT_ACTION: Readonly<Partial<Record<ReqStatus, Pair>>> = {
  partial: ['Complete implementation', 'Selesaikan implementasi'],
  planned: ['Start implementation', 'Mulai implementasi'],
  ns: ['Assign and start', 'Tugaskan dan mulai'],
  blocked: ['Resolve blocking item: justification missing', 'Selesaikan item penghambat: justifikasi belum ada'],
};

/** `Verify output (<name> marked complete)` (UI 2.3). */
export function verifyOutputAction(name: Pair): Pair {
  return [`Verify output (${name[0]} marked complete)`, `Verifikasi hasil (ditandai selesai oleh ${name[1]})`];
}

/** Chain item action of a document by UI status (UI 2.3). */
export const DOCUMENT_ACTION: Readonly<Record<'expired' | 'review' | 'draft', Pair>> = {
  expired: ['Start review: review date passed', 'Mulai tinjauan: tanggal tinjauan terlewati'],
  review: ['Approve review', 'Setujui tinjauan'],
  draft: ['Continue draft and approve', 'Lanjutkan draf dan setujui'],
};

/** Labels of the UI integrity codes (the web's `INTEG`, UI 1.7). */
export const INTEG_LABELS: Readonly<Record<IntegId, Pair>> = {
  ok: ['Verified', 'Terverifikasi'],
  changed: ['Version changed', 'Versi berubah'],
  moved: ['Moved', 'Dipindahkan'],
  missing: ['Missing', 'Hilang'],
  revoked: ['Access revoked', 'Akses dicabut'],
  pending: ['Check pending', 'Pemeriksaan tertunda'],
  nohash: ['No hash (Google Doc)', 'Tanpa hash (Google Doc)'],
};

/** `Re-link file in repository (<integrity label>)` (UI 2.3). */
export function relinkAction(integ: IntegId): Pair {
  const label = INTEG_LABELS[integ];
  return [`Re-link file in repository (${label[0]})`, `Tautkan ulang berkas di repositori (${label[1]})`];
}

/** `Submit <frequency> evidence` (UI 2.3), with the frequency labels in lower case. */
export function submitEvidenceAction(frequency: Pair): Pair {
  return [`Submit ${frequency[0].toLowerCase()} evidence`, `Serahkan evidence ${frequency[1].toLowerCase()}`];
}

/** Justification chain items of blocked entries (UI 2.3 `soa`). */
export const JUSTIFICATION_ACTION: Pair = ['Add risk-based justification', 'Tambahkan justifikasi berbasis risiko'];

/** `Applicability entry: <title>` (UI 2.3 `soa`). */
export function applicabilityEntryTitle(title: string): Pair {
  return [`Applicability entry: ${title}`, `Entri keberlakuan: ${title}`];
}

/** Why a requirement holds the gate when no reason is stored (the web's `T.blocked`, UI 2.4). */
export const BLOCKED_REASON: Pair = ['Blocked', 'Terblokir'];

/** Gate item type of requirements by unit (UI 2.4, G.5). */
export const REQUIREMENT_GATE_TYPE: Readonly<Record<'ctrl' | 'req', Pair>> = {
  ctrl: ['Control', 'Kontrol'],
  req: ['Requirement', 'Persyaratan'],
};

/** Words of the pack card edition list (G.5 `PACKS.eds`) by framework version status. */
export const EDITION_STATUS_WORDS: Readonly<Record<'current' | 'transition' | 'withdrawn', Pair>> = {
  current: ['current', 'berlaku'],
  transition: ['in transition', 'dalam transisi'],
  withdrawn: ['withdrawn', 'ditarik'],
};

/** Licence signature line (G.5 `LICENCE.sig`). */
export const SIGNATURE_TEXT: Readonly<Record<'verified' | 'unverified', Pair>> = {
  verified: ['Ed25519, verified', 'Ed25519, terverifikasi'],
  unverified: ['Ed25519, unverified', 'Ed25519, tidak terverifikasi'],
};
