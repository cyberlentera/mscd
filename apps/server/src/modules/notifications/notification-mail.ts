// Email texts of in-app notifications (build plan E.6): one message per notification (`notifications.dispatch`) and
// one daily digest per user (`notifications.digest`). The subject is `[MSCD] <title>`; the body is plain text and
// simple HTML (no images, no external resources) in the recipient's language, with a link into the app under
// `http.public_url`. Notification texts are stored in both languages, so nothing is translated here.

export type MailLanguage = 'en' | 'id';

/** What a message needs from one stored notification. */
export interface MailNotification {
  title: { en: string; id: string };
  body: { en: string; id: string };
}

/** A message ready for Nodemailer. */
export interface RenderedNotificationMail {
  subject: string;
  text: string;
  html: string;
}

const OPEN_APP: Record<MailLanguage, string> = { en: 'Open MSCD', id: 'Buka MSCD' };
const FOOTER: Record<MailLanguage, string> = {
  en: 'You receive this email because you are a member of an organisation in MSCD.',
  id: 'Anda menerima email ini karena Anda anggota organisasi di MSCD.',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** One line of text for a subject: control characters and line breaks become spaces, cut to 180 characters. */
export function subjectLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > 180 ? `${flat.slice(0, 177)}...` : flat;
}

function textMessage(title: string, paragraphs: readonly string[], link: string, language: MailLanguage): string {
  return `${title}\n\n${paragraphs.join('\n\n')}\n\n${OPEN_APP[language]}: ${link}\n\n-- \nMSCD\n${FOOTER[language]}\n`;
}

function htmlMessage(title: string, blocks: readonly { heading?: string; text: string }[], link: string, language: MailLanguage): string {
  const body = blocks
    .map((b) => (b.heading ? `<h3 style="font-size:15px;margin:16px 0 4px">${escapeHtml(b.heading)}</h3>\n<p style="margin:0 0 8px">${escapeHtml(b.text)}</p>` : `<p>${escapeHtml(b.text)}</p>`))
    .join('\n');
  return `<!doctype html>
<html><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.5">
<h2 style="font-size:18px">${escapeHtml(title)}</h2>
${body}
<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 16px;background:#1f4f8f;color:#ffffff;text-decoration:none;border-radius:4px">${escapeHtml(OPEN_APP[language])}</a></p>
<p style="font-size:12px;color:#555555">${escapeHtml(link)}</p>
<p style="font-size:12px;color:#555555">MSCD. ${escapeHtml(FOOTER[language])}</p>
</body></html>`;
}

/** The email of one notification (`notifications.dispatch`). */
export function renderNotificationMail(notification: MailNotification, language: MailLanguage, link: string): RenderedNotificationMail {
  const title = subjectLine(notification.title[language]);
  const body = notification.body[language];
  return {
    subject: `[MSCD] ${title}`,
    text: textMessage(title, [body], link, language),
    html: htmlMessage(title, [{ text: body }], link, language),
  };
}

/** Title of a digest message for `count` notifications. */
export function digestTitle(count: number, language: MailLanguage): string {
  if (language === 'id') return `Ringkasan harian: ${count} notifikasi`;
  return `Daily digest: ${count} ${count === 1 ? 'notification' : 'notifications'}`;
}

/** The daily digest of one user (`notifications.digest`): every digest notification, oldest first. */
export function renderDigestMail(notifications: readonly MailNotification[], language: MailLanguage, link: string): RenderedNotificationMail {
  const title = digestTitle(notifications.length, language);
  const intro = language === 'id' ? 'Notifikasi sejak ringkasan terakhir:' : 'Notifications since the last digest:';
  const items = notifications.map((n) => ({ heading: subjectLine(n.title[language]), text: n.body[language] }));
  return {
    subject: `[MSCD] ${title}`,
    text: textMessage(title, [intro, ...items.map((i) => `- ${i.heading}\n  ${i.text}`)], link, language),
    html: htmlMessage(title, [{ text: intro }, ...items], link, language),
  };
}
