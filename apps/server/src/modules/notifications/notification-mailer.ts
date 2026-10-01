// Nodemailer transport of notification emails (build plan E.6): the SMTP server of the profile (`mail.smtp`), the
// same settings as the account mailer of the identity module (file and URL access disabled, timeouts). Unlike the
// account mailer, `send` throws on failure: the dispatch and digest jobs count attempts and retry.
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { MscdConfig } from '../../config/mscd-config';
import type { RenderedNotificationMail } from './notification-mail';

const CONNECT_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 20_000;

/** Header that names the kind of an MSCD email (`notification:<kind>` or `notification:digest`). */
export const MAIL_KIND_HEADER = 'X-MSCD-Mail';

@Injectable()
export class NotificationMailer implements OnApplicationShutdown {
  private transport?: Transporter;

  constructor(private readonly config: MscdConfig) {}

  /** Absolute URL of a path of the web app under `http.public_url`. */
  appLink(path = '/'): string {
    const base = this.config.profile.http.public_url.replace(/\/+$/, '');
    return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  /** Sends one message; throws when the SMTP server does not accept it. */
  async send(to: string, mail: RenderedNotificationMail, kind: string): Promise<void> {
    await this.transporter().sendMail({
      from: this.config.profile.mail.from,
      to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      headers: { [MAIL_KIND_HEADER]: `notification:${kind}` },
    });
  }

  async onApplicationShutdown(): Promise<void> {
    this.transport?.close();
    this.transport = undefined;
  }

  private transporter(): Transporter {
    if (this.transport) return this.transport;
    const smtp = this.config.profile.mail.smtp;
    const password = smtp.password_file ? this.config.readSecretFile(smtp.password_file, 'mail.smtp.password_file') : undefined;
    this.transport = createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      ...(smtp.user ? { auth: { user: smtp.user, pass: password ?? '' } } : {}),
      connectionTimeout: CONNECT_TIMEOUT_MS,
      greetingTimeout: CONNECT_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
      // Messages are built from stored texts; never read files or URLs named in a message.
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    return this.transport;
  }
}
