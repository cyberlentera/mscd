// Texts of the sign-in and account pages (BUILD-PLAN H.6) in English and Indonesian, the language rule (`?lang=`,
// else the browser language) and the mapping of api errors and `/login?error=<code>` codes to messages.
import type { AuthMessageKey, LoginErrorCode } from '@mscd/shared';
import type { ApiError, Lang, Pair } from '../data/api/ApiClient';

export type { Lang, Pair };

/** `?lang=en` or `?lang=id` wins; otherwise Indonesian when the browser prefers it, else English (H.6). */
export function detectLang(search: string, languages: readonly string[] = []): Lang {
  const fromUrl = new URLSearchParams(search).get('lang');
  if (fromUrl === 'en' || fromUrl === 'id') return fromUrl;
  const first = languages.find((l) => typeof l === 'string' && l.length > 0);
  // `in` is the former ISO 639 code for Indonesian that some systems still report.
  return first && /^(id|in)\b/i.test(first) ? 'id' : 'en';
}

/** The text of a pair in the language. */
export const li = (pair: Pair, lang: Lang): string => (lang === 'id' ? pair[1] : pair[0]);

/** Replaces `{name}` placeholders in both texts of a pair. */
export function fill(pair: Pair, values: Record<string, string | number>): Pair {
  const sub = (s: string) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
  return [sub(pair[0]), sub(pair[1])];
}

export const TEXT = {
  // brand panel
  headline: ['The chain stays intact, or you hear about it first.', 'Rantai tetap utuh, atau Anda yang pertama tahu.'],
  factFrameworks: ['ISO/IEC 27001, ISO 9001, ISO 22301, ISO 37001', 'ISO/IEC 27001, ISO 9001, ISO 22301, ISO 37001'],
  factChain: ['One traceability chain from risk to evidence', 'Satu rantai keterlacakan dari risiko hingga bukti'],
  factFiles: ['Files stay in your repository', 'File tetap berada di repositori Anda'],
  chainIssue: ['Issue', 'Isu'],
  chainRisk: ['Risk', 'Risiko'],
  chainControl: ['Control', 'Kontrol'],
  chainDocument: ['Document', 'Dokumen'],
  chainEvidence: ['Evidence', 'Bukti'],
  chainFinding: ['Finding', 'Temuan'],
  deploySaas: ['SaaS', 'SaaS'],
  deployOnprem: ['On-Premise', 'On-Premise'],
  region: ['{deploy}, region {region}', '{deploy}, wilayah {region}'],
  tls: ['TLS 1.3', 'TLS 1.3'],
  mfaEnforced: ['MFA enforced', 'MFA diwajibkan'],

  // common
  loading: ['Loading MSCD', 'Memuat MSCD'],
  backToSignIn: ['Back to sign in', 'Kembali ke halaman masuk'],
  workEmail: ['Work email', 'Email kantor'],
  password: ['Password', 'Kata sandi'],
  continue: ['Continue', 'Lanjutkan'],
  verify: ['Verify', 'Verifikasi'],
  working: ['Please wait', 'Mohon tunggu'],
  emailPlaceholder: ['rina.kusuma@nusantaradigital.co.id', 'rina.kusuma@nusantaradigital.co.id'],
  passwordPlaceholder: ['•'.repeat(12), '•'.repeat(12)],
  enterEmail: ['Enter your work email address.', 'Masukkan alamat email kantor Anda.'],
  enterPassword: ['Enter your password.', 'Masukkan kata sandi Anda.'],

  // sign in (/login)
  signInEyebrow: ['SIGN IN', 'MASUK'],
  signInTitle: ['Welcome back', 'Selamat datang kembali'],
  signInLead: [
    'Use your organisation account. Access is granted per management system by your Tenant Administrator.',
    'Gunakan akun organisasi Anda. Akses diberikan per sistem manajemen oleh Administrator Tenant Anda.',
  ],
  orWithEmail: ['or with email', 'atau dengan email'],
  forgot: ['Forgot?', 'Lupa?'],
  remember: ['Keep me signed in on this device for 12 hours', 'Tetap masuk di perangkat ini selama 12 jam'],
  secondFactorNote: ['You will be asked for a second factor.', 'Anda akan diminta faktor kedua.'],
  guestQuestion: ['Auditor guest access?', 'Akses tamu auditor?'],
  guestLink: ['Use your invitation link', 'Gunakan tautan undangan Anda'],
  sessionEnded: ['Your session has ended. Sign in again.', 'Sesi Anda telah berakhir. Silakan masuk kembali.'],
  signedOut: ['You have signed out.', 'Anda telah keluar.'],
  passwordChanged: [
    'Your password was changed and every session was signed out. Sign in with the new password.',
    'Kata sandi Anda telah diubah dan semua sesi telah dikeluarkan. Masuk dengan kata sandi baru.',
  ],
  reauthLead: [
    'This organisation asks you to sign in again with one of these methods: {methods}.',
    'Organisasi ini meminta Anda masuk kembali dengan salah satu metode berikut: {methods}.',
  ],
  reauthLocal: ['email and password', 'email dan kata sandi'],
  reauthNone: ['none is available to your account', 'tidak ada yang tersedia untuk akun Anda'],
  reauthCancel: ['Stay in the current organisation', 'Tetap di organisasi saat ini'],
  ssoOnly: ['Your organisation signs in with single sign-on only.', 'Organisasi Anda hanya menggunakan single sign-on untuk masuk.'],

  // second factor (/login/mfa)
  mfaEyebrow: ['TWO-STEP SIGN-IN', 'MASUK DUA LANGKAH'],
  mfaTitle: ['Enter your code', 'Masukkan kode Anda'],
  mfaLead: ['Open your authenticator app and enter the 6-digit code for MSCD.', 'Buka aplikasi autentikator Anda dan masukkan kode 6 digit untuk MSCD.'],
  mfaRecoveryLead: [
    'Enter one of the recovery codes you saved when you set up two-step sign-in. Each code works once.',
    'Masukkan salah satu kode pemulihan yang Anda simpan saat mengatur masuk dua langkah. Setiap kode hanya berlaku sekali.',
  ],
  codeLabel: ['Authentication code', 'Kode autentikasi'],
  recoveryLabel: ['Recovery code', 'Kode pemulihan'],
  useRecovery: ['Use a recovery code', 'Gunakan kode pemulihan'],
  useAuthenticator: ['Use the authenticator code', 'Gunakan kode autentikator'],
  otherAccount: ['Sign in with another account', 'Masuk dengan akun lain'],
  recoveryFormat: ['Enter a recovery code in the form xxxx-xxxx-xx.', 'Masukkan kode pemulihan dengan format xxxx-xxxx-xx.'],
  codeFormat: ['Enter the 6 digits of the code.', 'Masukkan 6 digit kode.'],

  // enrolment (/login/enrol)
  enrolEyebrow: ['SET UP TWO-STEP SIGN-IN', 'ATUR MASUK DUA LANGKAH'],
  enrolTitle: ['Add an authenticator', 'Tambahkan autentikator'],
  enrolLead: [
    'Every MSCD account uses a second factor. Scan the QR code with an authenticator app, then enter the code it shows.',
    'Setiap akun MSCD menggunakan faktor kedua. Pindai kode QR dengan aplikasi autentikator, lalu masukkan kode yang ditampilkan.',
  ],
  qrLabel: ['QR code for your authenticator app', 'Kode QR untuk aplikasi autentikator Anda'],
  secretLabel: ['Or enter this key in the app', 'Atau masukkan kunci ini di aplikasi'],
  accountLabel: ['Account', 'Akun'],
  confirmCode: ['Code from the app', 'Kode dari aplikasi'],
  confirm: ['Confirm', 'Konfirmasi'],
  reenrolTitle: ['Replace your authenticator', 'Ganti autentikator Anda'],
  reenrolLead: [
    'Confirm it is you first: enter the current code from your authenticator, or your password.',
    'Konfirmasi bahwa ini Anda terlebih dahulu: masukkan kode saat ini dari autentikator, atau kata sandi Anda.',
  ],
  enrolFactorLead: [
    'Your account already has an authenticator, added in another sign-in. Enter its current code to replace it, or sign in again and enter that code.',
    'Akun Anda sudah memiliki autentikator yang ditambahkan pada proses masuk lain. Masukkan kode saat ini dari autentikator tersebut untuk menggantinya, atau masuk kembali dan masukkan kode tersebut.',
  ],
  currentCodeWrong: ['The current code is not correct.', 'Kode saat ini tidak benar.'],
  signInAgain: ['Sign in again', 'Masuk kembali'],
  currentCode: ['Current code', 'Kode saat ini'],
  usePasswordProof: ['Use my password instead', 'Gunakan kata sandi saya'],
  useCodeProof: ['Use my current code instead', 'Gunakan kode saat ini'],
  recoveryTitle: ['Save your recovery codes', 'Simpan kode pemulihan Anda'],
  recoveryLead: [
    'Each code signs you in once when you cannot use your authenticator. They are shown only now.',
    'Setiap kode dapat dipakai sekali untuk masuk saat autentikator tidak dapat digunakan. Kode hanya ditampilkan sekarang.',
  ],
  copyCodes: ['Copy codes', 'Salin kode'],
  copied: ['Copied', 'Tersalin'],
  copyFailed: ['Copying is not available here. Select the codes and copy them.', 'Penyalinan tidak tersedia di sini. Pilih kode lalu salin.'],
  savedThem: ['I saved them', 'Saya sudah menyimpannya'],
  continueToApp: ['Continue to MSCD', 'Lanjut ke MSCD'],
  otherSessionsEnded: ['Your other sessions were signed out.', 'Sesi Anda yang lain telah dikeluarkan.'],

  // forgotten password (/forgot-password)
  passwordEyebrow: ['PASSWORD', 'KATA SANDI'],
  forgotTitle: ['Reset your password', 'Atur ulang kata sandi'],
  forgotLead: [
    'Enter your work email. If the account can sign in with a password, we send a link that is valid for 30 minutes.',
    'Masukkan email kantor Anda. Jika akun dapat masuk dengan kata sandi, kami mengirim tautan yang berlaku selama 30 menit.',
  ],
  sendLink: ['Send link', 'Kirim tautan'],
  forgotDone: [
    'If an account with that address can sign in with a password, a link is on its way. Check your inbox.',
    'Jika ada akun dengan alamat tersebut yang dapat masuk dengan kata sandi, tautan sedang dikirim. Periksa kotak masuk Anda.',
  ],

  // new password (/reset-password, /invite)
  resetTitle: ['Choose a new password', 'Pilih kata sandi baru'],
  passwordRules: [
    'Use 12 to 256 characters. Avoid your email address, your user name and common passwords.',
    'Gunakan 12 sampai 256 karakter. Hindari alamat email, nama pengguna, dan kata sandi yang umum.',
  ],
  newPassword: ['New password', 'Kata sandi baru'],
  repeatPassword: ['Repeat the new password', 'Ulangi kata sandi baru'],
  setPassword: ['Set password', 'Simpan kata sandi'],
  passwordMismatch: ['The two passwords are not the same.', 'Kedua kata sandi tidak sama.'],
  passwordTooShort: ['Use at least 12 characters.', 'Gunakan minimal 12 karakter.'],
  passwordTooLong: ['Use at most 256 characters.', 'Gunakan maksimal 256 karakter.'],
  passwordCommon: ['This password is too common. Choose another one.', 'Kata sandi ini terlalu umum. Pilih yang lain.'],
  passwordPersonal: ['The password must not be your email address or user name.', 'Kata sandi tidak boleh sama dengan alamat email atau nama pengguna Anda.'],
  linkIncomplete: [
    'This link is not complete. Open the link from the email again, or ask for a new one.',
    'Tautan ini tidak lengkap. Buka kembali tautan dari email, atau minta tautan baru.',
  ],
  resetInvalid: ['This reset link is not valid or has expired. Ask for a new one.', 'Tautan atur ulang ini tidak valid atau telah kedaluwarsa. Minta tautan baru.'],
  askNewLink: ['Ask for a new link', 'Minta tautan baru'],

  // invitation (/invite)
  inviteEyebrow: ['INVITATION', 'UNDANGAN'],
  inviteTitle: ['Join MSCD', 'Bergabung dengan MSCD'],
  inviteLead: [
    'Set a password for your account, or continue with the sign-in of your organisation.',
    'Tetapkan kata sandi untuk akun Anda, atau lanjutkan dengan layanan masuk organisasi Anda.',
  ],
  inviteSubmit: ['Set password and continue', 'Simpan kata sandi dan lanjutkan'],
  orContinueWith: ['or continue with', 'atau lanjutkan dengan'],
  findSignIn: ['Find the sign-in of my organisation', 'Cari layanan masuk organisasi saya'],
  haveAccount: ['I already have an MSCD account with a password', 'Saya sudah memiliki akun MSCD dengan kata sandi'],
  choosePassword: ['Choose a password to accept the invitation.', 'Pilih kata sandi untuk menerima undangan.'],
  inviteExistingLead: [
    'Enter the current password of your MSCD account to accept the invitation. An account without a password would take the value entered here as its new password.',
    'Masukkan kata sandi akun MSCD Anda saat ini untuk menerima undangan. Akun yang belum memiliki kata sandi akan memakai nilai yang dimasukkan di sini sebagai kata sandi barunya.',
  ],
  accountPassword: ['Current password', 'Kata sandi saat ini'],
  inviteAccept: ['Accept invitation', 'Terima undangan'],
  noPasswordYet: ['My account has no password yet', 'Akun saya belum memiliki kata sandi'],
  inviteEnterPassword: ['Enter the password of your MSCD account to accept the invitation.', 'Masukkan kata sandi akun MSCD Anda untuk menerima undangan.'],
  inviteWrongPassword: ['The password is not correct, or the account cannot sign in now.', 'Kata sandi tidak benar, atau akun tidak dapat masuk saat ini.'],
  inviteHasPassword: [
    'Your MSCD account already has a password. Enter it to accept the invitation.',
    'Akun MSCD Anda sudah memiliki kata sandi. Masukkan kata sandi tersebut untuk menerima undangan.',
  ],
  inviteNoPassword: [
    'Your account has no password yet. Choose one to accept the invitation.',
    'Akun Anda belum memiliki kata sandi. Pilih kata sandi untuk menerima undangan.',
  ],
  noSso: ['No single sign-on was found for this address.', 'Tidak ada single sign-on untuk alamat ini.'],

  // guest auditor access (/guest)
  guestEyebrow: ['AUDITOR GUEST ACCESS', 'AKSES TAMU AUDITOR'],
  guestTitle: ['Guest access', 'Akses tamu'],
  guestChecking: ['Checking your access link', 'Memeriksa tautan akses Anda'],
  guestCodeSent: [
    'We sent a 6-digit code to {hint}. It is valid for 10 minutes.',
    'Kami mengirim kode 6 digit ke {hint}. Kode berlaku selama 10 menit.',
  ],
  guestCodeLabel: ['Code from the email', 'Kode dari email'],
  guestReturningLead: [
    'Returning auditor? Enter the email address the access was granted to, and we send you a new code.',
    'Auditor yang kembali? Masukkan alamat email penerima akses, dan kami mengirim kode baru.',
  ],
  sendMeCode: ['Send me a code', 'Kirim kode kepada saya'],
  sendNewCode: ['Send a new code', 'Kirim kode baru'],
  guestLinkInvalid: [
    'This access link was already used, has expired or was revoked. If you used it before, ask for a new code below.',
    'Tautan akses ini sudah digunakan, telah kedaluwarsa, atau dicabut. Jika Anda pernah menggunakannya, minta kode baru di bawah.',
  ],
  guestCodeInvalid: ['The code is not correct or has expired.', 'Kode tidak benar atau telah kedaluwarsa.'],

  // boot
  bootFailed: ['MSCD could not start.', 'MSCD tidak dapat dimulai.'],
  tryAgain: ['Try again', 'Coba lagi'],
  signOut: ['Sign out', 'Keluar'],
} satisfies Record<string, Pair>;

export type TextKey = keyof typeof TEXT;

/** Messages of `/login?error=<code>` (F.8 step 6, H.6). */
export const LOGIN_ERROR_MESSAGES: Record<LoginErrorCode, Pair> = {
  no_account: [
    'No MSCD account is linked to this sign-in. Ask your Tenant Administrator for an invitation.',
    'Tidak ada akun MSCD yang terhubung dengan proses masuk ini. Minta undangan kepada Administrator Tenant Anda.',
  ],
  mfa_required_by_policy: [
    'Your organisation requires a second factor that your identity provider did not confirm. Sign in again with multi-factor authentication.',
    'Organisasi Anda mewajibkan faktor kedua yang tidak dikonfirmasi oleh penyedia identitas Anda. Masuk kembali dengan autentikasi multi-faktor.',
  ],
  idp_error: [
    'The identity provider could not complete the sign-in. Try again, or contact your administrator.',
    'Penyedia identitas tidak dapat menyelesaikan proses masuk. Coba lagi, atau hubungi administrator Anda.',
  ],
  expired: ['The sign-in took too long and has expired. Start again.', 'Proses masuk terlalu lama dan telah kedaluwarsa. Mulai lagi.'],
  invitation_invalid: [
    'This invitation is not valid, was already used or has expired. Ask for a new invitation.',
    'Undangan ini tidak valid, sudah digunakan, atau telah kedaluwarsa. Minta undangan baru.',
  ],
  sso_required: [
    'Your organisation requires single sign-on. Use one of the sign-in buttons.',
    'Organisasi Anda mewajibkan single sign-on. Gunakan salah satu tombol masuk.',
  ],
};

export const UNKNOWN_LOGIN_ERROR: Pair = ['The sign-in did not complete. Try again.', 'Proses masuk tidak selesai. Coba lagi.'];

/** The message of a `/login?error=` code; an unknown code gives a generic text. */
export function loginErrorMessage(code: string): Pair {
  return Object.prototype.hasOwnProperty.call(LOGIN_ERROR_MESSAGES, code) ? LOGIN_ERROR_MESSAGES[code as LoginErrorCode] : UNKNOWN_LOGIN_ERROR;
}

/** Messages of the `messageKey` values the identity routes answer with (`AUTH_MESSAGE_KEYS` of the contract, WP-11). */
export const MESSAGE_KEYS: Record<AuthMessageKey, Pair> = {
  'auth.invalid_credentials': [
    'The email or password is not correct, or the account cannot sign in now.',
    'Email atau kata sandi tidak benar, atau akun tidak dapat masuk saat ini.',
  ],
  'auth.sso_required': LOGIN_ERROR_MESSAGES.sso_required,
  'auth.mfa_invalid': ['The code is not correct. Try again.', 'Kode tidak benar. Coba lagi.'],
  'auth.proof_invalid': ['The current code or password is not correct.', 'Kode saat ini atau kata sandi tidak benar.'],
  'auth.proof_required': [
    'Enter your current code or your password to replace the authenticator.',
    'Masukkan kode saat ini atau kata sandi Anda untuk mengganti autentikator.',
  ],
  'auth.password_invalid': ['The current password is not correct.', 'Kata sandi saat ini tidak benar.'],
  'auth.reset_invalid': TEXT.resetInvalid,
  'auth.invitation_invalid': LOGIN_ERROR_MESSAGES.invitation_invalid,
};

const SESSION_EXPIRED: Pair = ['Your sign-in has expired. Sign in again.', 'Proses masuk Anda telah kedaluwarsa. Silakan masuk kembali.'];
const REFUSED: Pair = ['The request was refused. Reload the page and try again.', 'Permintaan ditolak. Muat ulang halaman lalu coba lagi.'];
const ORG_INACTIVE: Pair = [
  'Your organisation cannot be used at the moment. Contact your administrator.',
  'Organisasi Anda tidak dapat digunakan saat ini. Hubungi administrator Anda.',
];

/** "Try again in n minutes" for a 429, rounded up to whole minutes (at least one). */
export function retryMessage(seconds: number | undefined): Pair {
  if (seconds === undefined) return ['Too many attempts. Wait a moment and try again.', 'Terlalu banyak percobaan. Tunggu sebentar lalu coba lagi.'];
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes === 1
    ? ['Too many attempts. Try again in 1 minute.', 'Terlalu banyak percobaan. Coba lagi dalam 1 menit.']
    : fill(['Too many attempts. Try again in {n} minutes.', 'Terlalu banyak percobaan. Coba lagi dalam {n} menit.'], { n: minutes });
}

/** The page message of a server message about a password (`errors[].message` of the F.4 policy and of the invitation). */
export function passwordProblemMessage(message: string): Pair {
  if (/at least/i.test(message)) return TEXT.passwordTooShort;
  if (/at most/i.test(message)) return TEXT.passwordTooLong;
  if (/too common/i.test(message)) return TEXT.passwordCommon;
  if (/email address or user name/i.test(message)) return TEXT.passwordPersonal;
  if (/choose a password/i.test(message)) return TEXT.choosePassword;
  if (/enter the password of your account/i.test(message)) return TEXT.inviteEnterPassword;
  return [message, message];
}

/**
 * The text a page shows for an api error: a known message key, then the problem slug (429, CSRF, inactive
 * organisation, a session that ended during a sign-in step), then field errors about the password, then the
 * message the client composed (`messages` of the problem, its title, or the network text).
 */
export function errorMessage(error: ApiError, options: { stepExpired?: boolean } = {}): Pair {
  if (error.messageKey && Object.prototype.hasOwnProperty.call(MESSAGE_KEYS, error.messageKey)) return MESSAGE_KEYS[error.messageKey as AuthMessageKey];
  if (error.status === 429 || error.slug === 'rate-limited') return retryMessage(error.retryAfter);
  if (error.slug === 'csrf') return REFUSED;
  if (error.slug === 'organisation-inactive') return ORG_INACTIVE;
  if (error.status === 401 && options.stepExpired) return SESSION_EXPIRED;
  const passwordError = error.errors?.find((e) => /password/i.test(e.path));
  if (passwordError) return passwordProblemMessage(passwordError.message);
  if (error.status === 401) return MESSAGE_KEYS['auth.invalid_credentials'];
  return error.message;
}

/** Human list of the accepted methods of `reauth-required` or `auth.sso_required`. */
export function methodsText(methods: { local: boolean; providers: { label: string }[] }, lang: Lang): string {
  const names = [...(methods.local ? [li(TEXT.reauthLocal, lang)] : []), ...methods.providers.map((p) => p.label)];
  return names.length ? names.join(', ') : li(TEXT.reauthNone, lang);
}
