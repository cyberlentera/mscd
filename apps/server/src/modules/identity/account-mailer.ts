// AccountMailer (build plan E.6): sends the `account` emails (invitations, password reset, guest one-time codes and
// access links, MFA reset) and the `security` emails (factor enrolled or replaced, recovery code used, second
// factor locked, password changed or reset, identity linked) through Nodemailer over the SMTP server of the
// profile (`mail.smtp`). They are sent from the request that causes them, not through the job queue, because they
// can concern users without a tenant context. A failed send is logged and never fails the request: the change it
// reports has already been committed.
import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { MscdConfig } from '../../config/mscd-config';
import { afterCommit } from '../../common/transaction-hooks';
import type { Trx } from '../../common/tokens';
import { IdentityInfra } from './identity-infra';
import { htmlBody, renderTemplate, SECURITY_TEMPLATES, textBody, type MailLanguage, type MailTemplate } from './mail-templates';

export interface AccountMail {
  to: { email: string; userId?: string | null };
  template: MailTemplate;
  /** Language of the message; default the recipient's `lang` preference, else English (E.6). */
  language?: MailLanguage;
}

const CONNECT_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 20_000;

@Injectable()
export class AccountMailer implements OnApplicationShutdown {
  private readonly logger = new Logger('AccountMailer');
  private transport?: Transporter;

  constructor(
    private readonly config: MscdConfig,
    private readonly infra: IdentityInfra,
  ) {}

  /** Absolute URL of a path of the web app under `http.public_url` (fragments are kept as given). */
  appLink(pathAndFragment = '/'): string {
    const base = this.config.profile.http.public_url.replace(/\/+$/, '');
    return `${base}${pathAndFragment.startsWith('/') ? '' : '/'}${pathAndFragment}`;
  }

  /** Sends one message now. Returns false (and logs) when it could not be sent; never throws. */
  async send(mail: AccountMail): Promise<boolean> {
    const name = mail.template.name;
    try {
      const language = mail.language ?? (await this.languageOf(mail.to.userId ?? null));
      const rendered = renderTemplate(mail.template, language);
      await this.transporter().sendMail({
        from: this.config.profile.mail.from,
        to: mail.to.email,
        subject: `[MSCD] ${rendered.title}`,
        text: textBody(rendered),
        html: htmlBody(rendered),
        headers: { 'X-MSCD-Mail': `${SECURITY_TEMPLATES.has(name) ? 'security' : 'account'}:${name}` },
      });
      return true;
    } catch (error) {
      this.logger.error(
        { template: name, userId: mail.to.userId ?? undefined },
        `Could not send the ${name} email${mail.to.userId ? ` to user ${mail.to.userId}` : ''}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /** Sends the message after `trx` commits (nothing is sent when it rolls back). */
  sendAfterCommit(trx: Trx, mail: AccountMail): void {
    afterCommit(trx, async () => {
      await this.send(mail);
    });
  }

  /**
   * Sends the message in the background: the caller does not wait, so the response time does not reveal whether
   * an account exists (password reset requests).
   */
  sendInBackground(mail: AccountMail): void {
    setImmediate(() => {
      void this.send(mail);
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
      // Messages are built from fixed templates; never read files or URLs named in a message.
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    return this.transport;
  }

  /** The recipient's `lang` preference (`id` or `en`), English when unknown. */
  private async languageOf(userId: string | null): Promise<MailLanguage> {
    if (!userId || !this.infra.available) return 'en';
    const row = await this.infra.scope.withPlatform(
      (trx) => trx.selectFrom('platform.user_preference').select('value').where('user_id', '=', userId).where('key', '=', 'lang').executeTakeFirst(),
      { scope: 'auth', userId },
    );
    return row?.value === 'id' ? 'id' : 'en';
  }
}
