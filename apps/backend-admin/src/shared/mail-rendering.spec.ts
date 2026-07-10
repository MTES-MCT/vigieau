import { MailerModule, MailerService } from '@nestjs-modules/mailer';
import { HandlebarsAdapter } from '@nestjs-modules/mailer/adapters/handlebars.adapter';
import { Test, TestingModule } from '@nestjs/testing';
import { join } from 'node:path';
import {
  isArray,
  isObject,
} from '../mail_templates/helpers/handlebars_helpers';

describe('Mail template rendering', () => {
  let moduleRef: TestingModule;
  let mailerService: MailerService;

  beforeAll(async () => {
    const templateDir = join(__dirname, '../mail_templates');

    moduleRef = await Test.createTestingModule({
      imports: [
        MailerModule.forRoot({
          transport: {
            streamTransport: true,
            buffer: true,
          },
          preview: {
            open: false,
          },
          template: {
            dir: templateDir,
            adapter: new HandlebarsAdapter({ isArray, isObject }),
            options: {
              strict: true,
            },
          },
          options: {
            partials: {
              dir: join(templateDir, 'partials'),
              options: {
                strict: true,
              },
            },
          },
        }),
      ],
    }).compile();

    mailerService = moduleRef.get(MailerService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  const renderTemplate = async (
    template: string,
    context: Record<string, unknown>,
  ): Promise<string> => {
    const result = (await mailerService.sendMail({
      from: 'vigieau@example.test',
      to: 'recipient@example.test',
      subject: 'VigiEau mail rendering smoke test',
      template,
      context,
    })) as { message: Buffer };

    return result.message.toString('utf8');
  };

  it('renders a standard Handlebars template', async () => {
    const message = await renderTemplate('./creation_aci', {
      departementNom: 'Paris',
      acNumero: 'ACI-2026-001',
      acLien: 'https://admin.example.test/arretes/aci-2026-001',
    });

    expect(message).toContain('Content-Type: text/html');
    expect(message).toContain('ACI-2026-001');
    expect(message).toContain("Je remplis l'ACI");
  });

  it('renders the recursive partial with real helpers', async () => {
    const message = await renderTemplate('./maj_ar', {
      date: '09/07/2026',
      userEmail: 'agent@example.test',
      userDepartement: '75',
      arreteNumero: 'AR-2026-001',
      arreteLien: 'https://admin.example.test/arretes/ar-2026-001',
      diffAr: {
        niveau: {
          avant: 'alerte',
          apres: 'crise',
        },
        communes: ['75056', '75101'],
      },
      oldAr: {
        niveau: 'alerte',
      },
      newAr: {
        niveau: 'crise',
      },
    });

    expect(message).toContain('AR-2026-001');
    expect(message).toContain('avant');
    expect(message).toContain('crise');
    expect(message).toContain('75056');
  });
});
