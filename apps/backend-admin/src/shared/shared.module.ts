import { MailerModule } from '@nestjs-modules/mailer';
import { HandlebarsAdapter } from '@nestjs-modules/mailer/dist/adapters/handlebars.adapter';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  isArray,
  isObject,
} from '../mail_templates/helpers/handlebars_helpers';
import { UserModule } from '../user/user.module';
import { MailService } from './services/mail.service';
import { S3Service } from './services/s3.service';

@Module({
  imports: [
    UserModule,
    MailerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => ({
        transport: {
          host: configService.get<string>('MAIL_HOST'),
          port: Number(configService.get<number>('MAIL_PORT')),
          secure: true,
          auth: {
            user: configService.get<string>('MAIL_USER'),
            pass: configService.get<string>('MAIL_PASSWORD'),
          },
          tls: {
            // do not fail on invalid certs
            rejectUnauthorized: false,
          },
        },
        preview: configService.get<string>('NODE_ENV') === 'local',
        template: {
          dir: __dirname + '/../mail_templates',
          adapter: new HandlebarsAdapter({
            isObject: isObject,
            isArray: isArray,
          }),
          options: {
            strict: true,
          },
        },
        options: {
          partials: {
            dir: __dirname + '/../mail_templates/partials',
            options: {
              strict: true,
            },
          },
        },
      }),
    }),
  ],
  providers: [S3Service, MailService],
  exports: [S3Service, MailService],
})
export class SharedModule {}
