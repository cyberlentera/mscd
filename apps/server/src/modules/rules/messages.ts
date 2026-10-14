// User messages of every rule in English and Indonesian (build plan D.1 `messages`, digest 6.2 to 6.4): the business
// rules BR-01 to BR-50 and the platform rule ids of the problem `rule` member. Written once here for every work
// package: services build the `messages` of a 422 `business-rule` problem or of a warning with `ruleMessages(rule,
// vars)`. Templates name their variables in braces (`{name}`); a variable that is not given takes the template's
// default, so every message reads well without context.
import { RULE_IDS, type Messages, type RuleId } from '@mscd/shared';

/** One rule's message: the two texts and the defaults of their variables. */
export interface RuleMessageTemplate {
  en: string;
  id: string;
  /** Text used for a variable that the caller does not give, per language. */
  defaults?: Readonly<Record<string, { en: string; id: string }>>;
  /** True when the digest gives no user message (the rule acts silently); the text then describes the effect. */
  silent?: boolean;
}

/** Message keys of the problem `messageKey` member: `rule.<id>` (for example `rule.BR-01`). */
export function ruleMessageKey(rule: RuleId): string {
  return `rule.${rule}`;
}

export const RULE_MESSAGES: Readonly<Record<RuleId, RuleMessageTemplate>> = {
  // Digest 6.2 (TS 8.1, PRD 6.3, PRD 8.2)
  'BR-01': {
    en: 'This entry cannot be set to implemented without evidence from the current period whose file is intact or moved. Set it to partially implemented or planned instead.',
    id: 'Entri ini tidak dapat diubah menjadi diterapkan tanpa bukti dari periode berjalan yang berkasnya utuh atau dipindahkan. Ubah menjadi diterapkan sebagian atau direncanakan.',
  },
  'BR-02': {
    en: 'Link this applicable entry to at least one risk. Until it is, the entry cannot be verified and blocks the checkpoint.',
    id: 'Tautkan entri yang berlaku ini ke setidaknya satu risiko. Sampai ditautkan, entri tidak dapat diverifikasi dan menghambat titik periksa.',
  },
  'BR-03': {
    en: 'The exclusion justification does not look meaningful. Explain why this does not apply.',
    id: 'Justifikasi pengecualian tampaknya tidak bermakna. Jelaskan mengapa ini tidak berlaku.',
  },
  'BR-04': {
    en: 'A risk treatment cannot be completed without residual risk acceptance by the risk owner, and the implementer cannot accept it.',
    id: 'Perlakuan risiko tidak dapat diselesaikan tanpa penerimaan risiko residual oleh pemilik risiko, dan pelaksana tidak dapat menerimanya.',
  },
  'BR-05': {
    en: 'This risk is above the risk appetite and needs escalation.',
    id: 'Risiko ini melebihi selera risiko dan perlu dieskalasi.',
  },
  'BR-06': {
    en: 'A major finding cannot be closed without a root cause analysis.',
    id: 'Temuan mayor tidak dapat ditutup tanpa analisis akar masalah.',
  },
  'BR-07': {
    en: 'A major finding cannot be closed without a systemic check.',
    id: 'Temuan mayor tidak dapat ditutup tanpa pemeriksaan sistemik.',
  },
  'BR-08': {
    en: 'The finding needs a closed and effective corrective action, and the effectiveness verification must be dated differently from the implementation.',
    id: 'Temuan memerlukan tindakan korektif yang sudah ditutup dan efektif, dan verifikasi efektivitas harus bertanggal berbeda dari tanggal penerapan.',
  },
  'BR-09': {
    en: 'A corrective action cannot be verified by its implementer or its owner.',
    id: 'Tindakan korektif tidak dapat diverifikasi oleh pelaksana atau pemiliknya.',
  },
  'BR-10': {
    en: 'Document {code} is past its review date and has expired. It blocks the readiness of related clauses in every system that uses it.',
    id: 'Dokumen {code} telah melewati tanggal tinjauan dan kedaluwarsa. Dokumen ini menghambat kesiapan klausul terkait di setiap sistem yang menggunakannya.',
    defaults: { code: { en: 'this', id: 'ini' } },
  },
  'BR-11': {
    en: 'The evidence has expired. The entry was set to partially implemented and a task was created for the evidence owner.',
    id: 'Bukti telah kedaluwarsa. Entri diubah menjadi diterapkan sebagian dan tugas dibuat untuk pemilik bukti.',
  },
  'BR-12': {
    en: 'This activity stays locked until every activity of checkpoint phase {phase} is verified.',
    id: 'Aktivitas ini tetap terkunci sampai semua aktivitas pada fase titik periksa {phase} terverifikasi.',
    defaults: { phase: { en: 'before it', id: 'sebelumnya' } },
  },
  'BR-13': {
    en: 'The management review cannot be closed while mandatory inputs are empty for a linked system.',
    id: 'Tinjauan manajemen tidak dapat ditutup selama masukan wajib untuk sistem terkait masih kosong.',
  },
  'BR-14': {
    en: 'The management review cannot be closed without recorded decisions.',
    id: 'Tinjauan manajemen tidak dapat ditutup tanpa keputusan yang dicatat.',
  },
  'BR-15': {
    en: 'This finding is past its due date.',
    id: 'Temuan ini telah melewati tenggat waktunya.',
  },
  'BR-16': {
    en: 'A document cannot be approved by its own author. Approval is always separate from creation.',
    id: 'Dokumen tidak dapat disetujui oleh penulisnya sendiri. Persetujuan selalu terpisah dari pembuatan.',
  },
  'BR-17': {
    en: 'A risk needs an owner.',
    id: 'Risiko memerlukan pemilik.',
  },
  'BR-18': {
    en: 'This register has not changed across certification cycles.',
    id: 'Register ini tidak berubah antar siklus sertifikasi.',
  },
  'BR-19': {
    en: 'Records are only soft deleted. No role can delete a record physically.',
    id: 'Rekaman hanya dihapus secara lunak. Tidak ada peran yang dapat menghapus rekaman secara fisik.',
  },
  'BR-20': {
    en: 'External auditor access is read-only, time-limited, limited to the audited system and logged.',
    id: 'Akses auditor eksternal bersifat hanya-baca, terbatas waktu, terbatas pada sistem yang diaudit, dan dicatat.',
  },
  // Digest 6.3 (TS 8.2)
  'BR-21': {
    en: "This framework is not yet included in your organisation's licence. Contact your administrator.",
    id: 'Kerangka kerja ini belum termasuk dalam lisensi organisasi Anda. Hubungi administrator Anda.',
  },
  'BR-22': {
    en: 'This change also applies to: {systems}. Continue?',
    id: 'Perubahan ini juga berlaku untuk: {systems}. Lanjutkan?',
    defaults: { systems: { en: 'other management systems', id: 'sistem manajemen lain' } },
  },
  'BR-23': {
    en: 'This requirement is similar but not identical. Make sure this evidence really satisfies both.',
    id: 'Persyaratan ini mirip tetapi tidak identik. Pastikan bukti ini benar-benar memenuhi keduanya.',
  },
  'BR-24': {
    en: 'Recovery time must not exceed the maximum tolerable period of disruption.',
    id: 'Waktu pemulihan tidak boleh melebihi periode gangguan maksimum yang dapat ditoleransi.',
  },
  'BR-25': {
    en: 'This plan has not been tested in the current period. Schedule an exercise.',
    id: 'Rencana ini belum diuji pada periode berjalan. Jadwalkan latihan.',
  },
  'BR-26': {
    en: 'This associate needs a due diligence check that is still valid.',
    id: 'Rekanan ini memerlukan uji tuntas yang masih berlaku.',
  },
  'BR-27': {
    en: 'This value exceeds the policy limit and requires approval.',
    id: 'Nilai ini melebihi batas kebijakan dan memerlukan persetujuan.',
  },
  'BR-28': {
    en: 'You do not have access to this report.',
    id: 'Anda tidak memiliki akses ke laporan ini.',
  },
  'BR-29': {
    en: 'Repository {name} cannot be reached. Try again later or contact your administrator.',
    id: 'Repositori {name} tidak dapat dijangkau. Coba lagi nanti atau hubungi administrator Anda.',
    defaults: { name: { en: 'of this file', id: 'untuk berkas ini' } },
  },
  'BR-30': {
    en: 'Files in personal storage can be lost when their owner leaves. Consider a shared library.',
    id: 'Berkas di penyimpanan pribadi dapat hilang saat pemiliknya keluar. Pertimbangkan pustaka bersama.',
  },
  'BR-31': {
    en: 'The evidence file can no longer be verified in {repository}. Re-link it or upload the correct version.',
    id: 'Berkas bukti tidak dapat lagi diverifikasi di {repository}. Tautkan ulang atau unggah versi yang benar.',
    defaults: { repository: { en: 'its repository', id: 'repositorinya' } },
  },
  'BR-32': {
    en: 'This evidence file was changed after it was submitted. The recorded evidence remains the earlier version.',
    id: 'Berkas bukti ini diubah setelah diserahkan. Bukti yang tercatat tetap versi sebelumnya.',
  },
  'BR-33': {
    en: 'The edition of the standard in use is past its transition period.',
    id: 'Edisi standar yang digunakan telah melewati masa transisinya.',
  },
  'BR-34': {
    en: 'This evidence is not valid and is listed in the exceptions of the evidence pack manifest.',
    id: 'Bukti ini tidak valid dan dicantumkan pada bagian pengecualian manifes paket bukti.',
    silent: true,
  },
  'BR-35': {
    en: "This file opens directly in {repository} in line with your organisation's policy.",
    id: 'Berkas ini dibuka langsung di {repository} sesuai kebijakan organisasi Anda.',
    defaults: { repository: { en: 'its repository', id: 'repositorinya' } },
  },
  'BR-36': {
    en: 'The evidence date is later than the file creation date. Check the date again.',
    id: 'Tanggal bukti lebih lambat dari tanggal pembuatan berkas. Periksa kembali tanggalnya.',
  },
  'BR-37': {
    en: 'The licence has expired. Data can still be read and exported.',
    id: 'Lisensi telah berakhir. Data masih dapat dibaca dan diekspor.',
  },
  'BR-38': {
    en: "Restricted files will be stored in the provider's cloud. This change needs a second approval.",
    id: 'Berkas terbatas akan disimpan di cloud penyedia. Perubahan ini memerlukan persetujuan kedua.',
  },
  // Digest 6.4 (TS 8.3)
  'BR-39': {
    en: 'State why this activity is blocked and which blocking item causes it.',
    id: 'Sebutkan alasan aktivitas ini terblokir dan item penghambat mana yang menyebabkannya.',
  },
  'BR-40': {
    en: 'Link the output document from the register before marking this complete.',
    id: 'Tautkan dokumen keluaran dari register sebelum menandai ini selesai.',
  },
  'BR-41': {
    en: 'This due date falls after the audit on {date}. Bring the due date forward or prepare an explanation.',
    id: 'Tenggat ini jatuh setelah audit pada {date}. Majukan tenggatnya atau siapkan penjelasan.',
    defaults: { date: { en: 'the next audit date', id: 'tanggal audit berikutnya' } },
  },
  'BR-42': {
    en: 'The audit date has changed. {n} of your items are now due after the audit.',
    id: 'Tanggal audit berubah. {n} item Anda kini jatuh tempo setelah audit.',
    defaults: { n: { en: 'Some', id: 'Beberapa' } },
  },
  'BR-43': {
    en: 'Preparation tasks must be finished before the audit starts.',
    id: 'Tugas persiapan harus selesai sebelum audit dimulai.',
  },
  'BR-44': {
    en: 'The finding closure preparation task is skipped for the first audit of a system.',
    id: 'Tugas persiapan penutupan temuan dilewati untuk audit pertama suatu sistem.',
    silent: true,
  },
  'BR-45': {
    en: 'This item has no PIC yet. Assign it to one person.',
    id: 'Item ini belum memiliki PIC. Tugaskan kepada satu orang.',
  },
  'BR-46': {
    en: 'The number of blocked activities does not match the open blocking items. Check the blocking references.',
    id: 'Jumlah aktivitas yang terblokir tidak sesuai dengan item penghambat yang terbuka. Periksa rujukan pemblokirannya.',
  },
  'BR-47': {
    en: 'Document status and activity status do not match. Check one of them.',
    id: 'Status dokumen dan status aktivitas tidak sesuai. Periksa salah satunya.',
  },
  'BR-48': {
    en: 'A drift rule matched this record.',
    id: 'Sebuah aturan penyimpangan cocok dengan rekaman ini.',
  },
  'BR-49': {
    en: 'The drifted record is back to normal and no longer counts.',
    id: 'Rekaman yang menyimpang telah kembali normal dan tidak lagi dihitung.',
    silent: true,
  },
  'BR-50': {
    en: 'The last reminder was sent at {last}. Try again after {next}.',
    id: 'Pengingat terakhir dikirim pada {last}. Coba lagi setelah {next}.',
    defaults: { last: { en: 'a recent time', id: 'waktu belum lama ini' }, next: { en: '72 hours', id: '72 jam' } },
  },
  // Platform rules (D.1)
  'LIC-USERS': {
    en: 'The licence allows no more active users. Disable a user or extend the licence.',
    id: 'Lisensi tidak mengizinkan pengguna aktif tambahan. Nonaktifkan pengguna atau perluas lisensi.',
  },
  'LIC-MS': {
    en: 'The licence allows no more management systems.',
    id: 'Lisensi tidak mengizinkan sistem manajemen tambahan.',
  },
  'LIC-FEATURE': {
    en: "This feature is not included in your organisation's licence.",
    id: 'Fitur ini tidak termasuk dalam lisensi organisasi Anda.',
  },
  'LIC-BINDING': {
    en: 'This licence is bound to another installation or organisation.',
    id: 'Lisensi ini terikat pada instalasi atau organisasi lain.',
  },
  'VERIFY-SELF': {
    en: 'You cannot verify work that you completed or own. Another MS Manager or a Programme Owner must verify it.',
    id: 'Anda tidak dapat memverifikasi pekerjaan yang Anda selesaikan atau miliki. Manajer SM lain atau Pemilik Program harus memverifikasinya.',
  },
  'NOT-A-MEMBER': {
    en: '{who} is not a member of this organisation.',
    id: '{who} bukan anggota organisasi ini.',
    defaults: { who: { en: 'The person', id: 'Orang tersebut' } },
  },
  'SOD-SELF-GRANT': {
    en: 'You cannot decide a role grant that you requested or that names you. Another Tenant Admin must decide it.',
    id: 'Anda tidak dapat memutuskan pemberian peran yang Anda minta atau yang menyebut Anda. Admin Tenant lain harus memutuskannya.',
  },
};

for (const rule of RULE_IDS) {
  if (!RULE_MESSAGES[rule]) throw new Error(`rules/messages.ts: no message for ${rule}`);
}

export type RuleVars = Readonly<Record<string, string | number | null | undefined>>;

function fill(template: string, lang: 'en' | 'id', vars: RuleVars, defaults: RuleMessageTemplate['defaults']): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (_match, name: string) => {
    const value = vars[name];
    if (value !== undefined && value !== null && String(value) !== '') return String(value);
    return defaults?.[name]?.[lang] ?? '';
  });
}

/**
 * The message of a rule in both languages with its variables filled in. `vars` may give one value for both
 * languages, or `{en, id}` pairs through `localized`.
 */
export function ruleMessages(rule: RuleId, vars: RuleVars = {}, localized: Readonly<Record<string, { en: string; id: string }>> = {}): Messages {
  const template = RULE_MESSAGES[rule];
  const per = (lang: 'en' | 'id'): RuleVars => {
    const out: Record<string, string | number | null | undefined> = { ...vars };
    for (const [name, pair] of Object.entries(localized)) out[name] = pair[lang];
    return out;
  };
  return { en: fill(template.en, 'en', per('en'), template.defaults), id: fill(template.id, 'id', per('id'), template.defaults) };
}
