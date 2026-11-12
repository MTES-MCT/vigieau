import { Injectable, Optional } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';
import { RegleauLogger } from '../../logger/regleau.logger';
import { UserService } from '../../user/user.service';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../../audit/audit.service';

@Injectable()
export class MailService {
  /**
   * LIEN UTILES
   * Preview de templates handlebars : https://handlebars-email-html-previewer.vercel.app/
   * Template d'Email : https://github.com/leemunroe/responsive-html-email-template
   */
  private readonly logger = new RegleauLogger('MailService');

  constructor(
    private readonly mailerService: MailerService,
    private readonly userService: UserService,
    private readonly configService: ConfigService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  /**
   * Envoi d'un email selon un template
   * @param email
   * @param subject
   * @param template
   * @param context
   */
  async sendEmail(
    email: string,
    subject: string,
    template: string,
    context?: any,
  ): Promise<any> {
    if (!this.configService.get('MAIL_USER')) {
      this.logger.log('EMAIL NOT SENT - MAIL_USER not configured');
      return;
    }
    await this.audit?.recordEvent('started', {
      stage: 'mail.send',
      template,
      recipientCount: 1,
    });
    return this.mailerService
      .sendMail({
        to: email,
        from: `${this.configService.get('MAIL_USER')}`,
        subject: `VigiEau Admin - ${subject}`,
        template: `./${template}`,
        context: context,
      })
      .then(async () => {
        await this.audit?.recordBestEffort('accepted', {
          stage: 'mail.send',
          template,
          recipientCount: 1,
          externalOutcome: 'smtp_accepted',
        });
        this.logger.log('MAIL accepted by SMTP');
      })
      .catch(async () => {
        await this.audit?.recordBestEffort('failed', {
          stage: 'mail.send',
          template,
          recipientCount: 1,
          errorCode: 'MAIL_SEND_FAILURE',
        });
        this.logger.error('MAIL_SEND_FAILURE', '');
      });
  }

  sendEmails(
    emails: string[],
    subject: string,
    template: string,
    context?: any,
  ): Promise<any> {
    return Promise.all(
      emails.map((email) => this.sendEmail(email, subject, template, context)),
    );
  }

  async sendEmailsByDepartement(
    depCode: string,
    subject: string,
    template: string,
    context?: any,
    sendToMte?: boolean,
  ): Promise<any> {
    const users = await this.userService.findByDepartementsCode([depCode]);
    const emails = users.map((user) => user.email);
    if (sendToMte) {
      emails.push(this.configService.get('MAIL_MTE'));
    }
    return Promise.all(
      emails.map((email) => this.sendEmail(email, subject, template, context)),
    );
  }
}
