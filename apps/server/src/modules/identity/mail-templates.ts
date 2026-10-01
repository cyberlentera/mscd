// Texts of the `account` and `security` emails (build plan E.6, F.4, F.5, F.8, F.14) in English and Indonesian.
// Every message has a title (the subject is `[MSCD] <title>`) and paragraphs; links are absolute URLs under
// `http.public_url`. Security messages end with the same advice, so a user who did not act knows what to do.

export type MailLanguage = 'en' | 'id';

export type AccountTemplate =
  | { name: 'password_reset'; link: string; minutes: number }
  | { name: 'invitation'; link: string; organisation: string; hours: number }
  | { name: 'mfa_reset'; link: string }
  | { name: 'guest_access_link'; link: string; organisation: string; system: string; expiresOn: string }
  | { name: 'guest_code'; code: string; minutes: number };

export type SecurityTemplate =
  | { name: 'mfa_enrolled'; link: string }
  | { name: 'mfa_replaced'; link: string }
  | { name: 'recovery_code_used'; link: string; remaining: number }
  | { name: 'mfa_locked'; link: string; until: string }
  | { name: 'password_changed'; link: string }
  | { name: 'password_reset_done'; link: string }
  | { name: 'identity_linked'; link: string; provider: string };

/** `account` emails are sent to anyone a flow names; `security` emails report a change of the user's own sign-in. */
export type MailTemplate = AccountTemplate | SecurityTemplate;

export const SECURITY_TEMPLATES: ReadonlySet<MailTemplate['name']> = new Set([
  'mfa_enrolled',
  'mfa_replaced',
  'recovery_code_used',
  'mfa_locked',
  'password_changed',
  'password_reset_done',
  'identity_linked',
]);

export interface RenderedMail {
  title: string;
  paragraphs: string[];
  /** The main link of the message, shown as a button in the HTML body. */
  link?: { href: string; label: string };
}

const ADVICE: Record<MailLanguage, string> = {
  en: 'If this was not you, reset your password at once and tell your administrator.',
  id: 'Jika ini bukan Anda, segera atur ulang kata sandi Anda dan beri tahu administrator Anda.',
};

const OPEN_APP: Record<MailLanguage, string> = { en: 'Open MSCD', id: 'Buka MSCD' };

function security(language: MailLanguage, title: string, lines: string[], link: string): RenderedMail {
  return { title, paragraphs: [...lines, ADVICE[language]], link: { href: link, label: OPEN_APP[language] } };
}

/** Title and paragraphs of a template in one language. */
export function renderTemplate(template: MailTemplate, language: MailLanguage): RenderedMail {
  const en = language === 'en';
  switch (template.name) {
    case 'password_reset':
      return {
        title: en ? 'Reset your password' : 'Atur ulang kata sandi Anda',
        paragraphs: en
          ? [
              'Someone asked to reset the password of your MSCD account.',
              `Open the link below within ${template.minutes} minutes to choose a new password. The link works once.`,
              'If you did not ask for this, ignore this email; your password stays as it is.',
            ]
          : [
              'Seseorang meminta pengaturan ulang kata sandi akun MSCD Anda.',
              `Buka tautan di bawah dalam ${template.minutes} menit untuk memilih kata sandi baru. Tautan hanya berlaku sekali.`,
              'Jika Anda tidak memintanya, abaikan email ini; kata sandi Anda tidak berubah.',
            ],
        link: { href: template.link, label: en ? 'Choose a new password' : 'Pilih kata sandi baru' },
      };
    case 'invitation':
      return {
        title: en ? `You are invited to ${template.organisation} on MSCD` : `Anda diundang ke ${template.organisation} di MSCD`,
        paragraphs: en
          ? [
              `You have been invited to join ${template.organisation} on MSCD.`,
              `Open the link below within ${template.hours} hours to set your password and your authenticator app. The link works once.`,
            ]
          : [
              `Anda diundang untuk bergabung dengan ${template.organisation} di MSCD.`,
              `Buka tautan di bawah dalam ${template.hours} jam untuk mengatur kata sandi dan aplikasi autentikator Anda. Tautan hanya berlaku sekali.`,
            ],
        link: { href: template.link, label: en ? 'Accept the invitation' : 'Terima undangan' },
      };
    case 'mfa_reset':
      return {
        title: en ? 'Your two-step sign-in was reset' : 'Verifikasi dua langkah Anda diatur ulang',
        paragraphs: en
          ? [
              'An administrator removed the authenticator of your MSCD account and ended all your sessions.',
              'Sign in again to set up a new authenticator app.',
              ADVICE.en,
            ]
          : [
              'Administrator menghapus autentikator akun MSCD Anda dan mengakhiri semua sesi Anda.',
              'Masuk kembali untuk mengatur aplikasi autentikator baru.',
              ADVICE.id,
            ],
        link: { href: template.link, label: OPEN_APP[language] },
      };
    case 'guest_access_link':
      return {
        title: en ? `Auditor access to ${template.system}` : `Akses auditor ke ${template.system}`,
        paragraphs: en
          ? [
              `${template.organisation} gave you read access to ${template.system} on MSCD until ${template.expiresOn}.`,
              'Open the link below. It works once: it sends a one-time code to this address, then you set up an authenticator app.',
            ]
          : [
              `${template.organisation} memberi Anda akses baca ke ${template.system} di MSCD sampai ${template.expiresOn}.`,
              'Buka tautan di bawah. Tautan hanya berlaku sekali: tautan mengirim kode sekali pakai ke alamat ini, lalu Anda mengatur aplikasi autentikator.',
            ],
        link: { href: template.link, label: en ? 'Open auditor access' : 'Buka akses auditor' },
      };
    case 'guest_code':
      return {
        title: en ? 'Your MSCD sign-in code' : 'Kode masuk MSCD Anda',
        paragraphs: en
          ? [`Your one-time code is ${template.code}. It is valid for ${template.minutes} minutes.`, 'If you did not ask for a code, ignore this email.']
          : [`Kode sekali pakai Anda adalah ${template.code}. Kode berlaku ${template.minutes} menit.`, 'Jika Anda tidak meminta kode, abaikan email ini.'],
      };
    case 'mfa_enrolled':
      return security(
        language,
        en ? 'Authenticator added to your account' : 'Autentikator ditambahkan ke akun Anda',
        [en ? 'An authenticator app was set up for two-step sign-in to your MSCD account.' : 'Aplikasi autentikator diatur untuk verifikasi dua langkah akun MSCD Anda.'],
        template.link,
      );
    case 'mfa_replaced':
      return security(
        language,
        en ? 'Authenticator replaced' : 'Autentikator diganti',
        [
          en
            ? 'The authenticator app of your MSCD account was replaced and your other sessions were ended. New recovery codes replace the old ones.'
            : 'Aplikasi autentikator akun MSCD Anda diganti dan sesi Anda yang lain diakhiri. Kode pemulihan baru menggantikan kode lama.',
        ],
        template.link,
      );
    case 'recovery_code_used':
      return security(
        language,
        en ? 'A recovery code was used' : 'Kode pemulihan digunakan',
        [
          en
            ? `A recovery code was used to sign in to your MSCD account. ${template.remaining} unused codes are left.`
            : `Kode pemulihan digunakan untuk masuk ke akun MSCD Anda. Tersisa ${template.remaining} kode yang belum digunakan.`,
        ],
        template.link,
      );
    case 'mfa_locked':
      return security(
        language,
        en ? 'Two-step sign-in locked' : 'Verifikasi dua langkah dikunci',
        [
          en
            ? `Too many wrong codes were entered for your MSCD account. Two-step sign-in is locked until ${template.until}.`
            : `Terlalu banyak kode salah dimasukkan untuk akun MSCD Anda. Verifikasi dua langkah dikunci sampai ${template.until}.`,
        ],
        template.link,
      );
    case 'password_changed':
      return security(
        language,
        en ? 'Your password was changed' : 'Kata sandi Anda diubah',
        [en ? 'The password of your MSCD account was changed and your other sessions were ended.' : 'Kata sandi akun MSCD Anda diubah dan sesi Anda yang lain diakhiri.'],
        template.link,
      );
    case 'password_reset_done':
      return security(
        language,
        en ? 'Your password was reset' : 'Kata sandi Anda diatur ulang',
        [en ? 'The password of your MSCD account was reset and all your sessions were ended.' : 'Kata sandi akun MSCD Anda diatur ulang dan semua sesi Anda diakhiri.'],
        template.link,
      );
    case 'identity_linked':
      return security(
        language,
        en ? 'Sign-in provider linked' : 'Penyedia masuk ditautkan',
        [
          en
            ? `Your MSCD account can now be signed in to through ${template.provider}.`
            : `Akun MSCD Anda sekarang dapat dimasuki melalui ${template.provider}.`,
        ],
        template.link,
      );
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Plain text body. */
export function textBody(mail: RenderedMail): string {
  const parts = [...mail.paragraphs];
  if (mail.link) parts.push(`${mail.link.label}: ${mail.link.href}`);
  return `${parts.join('\n\n')}\n\n-- \nMSCD\n`;
}

/** Simple HTML body (no images, no external resources). */
export function htmlBody(mail: RenderedMail): string {
  const paragraphs = mail.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n');
  const button = mail.link
    ? `<p><a href="${escapeHtml(mail.link.href)}" style="display:inline-block;padding:10px 16px;background:#1f4f8f;color:#ffffff;text-decoration:none;border-radius:4px">${escapeHtml(mail.link.label)}</a></p>\n<p style="font-size:12px;color:#555555">${escapeHtml(mail.link.href)}</p>`
    : '';
  return `<!doctype html>
<html><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.5">
<h2 style="font-size:18px">${escapeHtml(mail.title)}</h2>
${paragraphs}
${button}
<p style="font-size:12px;color:#555555">MSCD</p>
</body></html>`;
}
