import { S3Service } from './services/s3.service';
import { Module } from '@nestjs/common';
import { MailService } from './services/mail.service';
import { UserModule } from '../user/user.module';
import { MailerModule } from '@nestjs-modules/mailer';
import { HandlebarsAdapter } from '@nestjs-modules/mailer/dist/adapters/handlebars.adapter';
import { isArray, isObject } from '../mail_templates/helpers/handlebars_helpers';

@Module({
  imports: [
    UserModule,
    MailerModule.forRoot({
      transport: {
        host: `${process.env.MAIL_HOST}`,
        port: Number(`${process.env.MAIL_PORT}`),
        secure: true,
        auth: {
          user: `${process.env.MAIL_USER}`,
          pass: `${process.env.MAIL_PASSWORD}`,
        },
        tls: {
          // do not fail on invalid certs
          rejectUnauthorized: false,
        },
      },
      preview: process.env.NODE_ENV === 'local',
      template: {
        dir: __dirname + '/../mail_templates',
        adapter: new HandlebarsAdapter({'isObject': isObject, 'isArray': isArray}),
        options: {
          strict: true,
        },
      },
      options: {
        partials: {
          dir: __dirname + '/mail_templates/partials',
          options: {
            strict: true,
          },
        },
      },
    }),
  ],
  providers: [S3Service, MailService],
  exports: [S3Service, MailService],
})
export class SharedModule {}
