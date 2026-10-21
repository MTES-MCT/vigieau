import { MailerModule, MailerService } from '@nestjs-modules/mailer';
import { HandlebarsAdapter } from '@nestjs-modules/mailer/adapters/handlebars.adapter';
import { Test, TestingModule } from '@nestjs/testing';
import { createServer, Socket } from 'node:net';
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

  it('delivers recipients and attachments through a loopback-only SMTP server', async () => {
    const commands: string[] = [];
    const message: string[] = [];
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.setEncoding('utf8');
      socket.write('220 localhost SMTP test\r\n');
      let pending = '';
      let receivingMessage = false;

      socket.on('data', (chunk) => {
        pending += chunk.toString();
        let newline: number;
        while ((newline = pending.indexOf('\r\n')) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 2);
          if (receivingMessage) {
            if (line === '.') {
              receivingMessage = false;
              socket.write('250 Message accepted\r\n');
            } else {
              message.push(line);
            }
            continue;
          }

          commands.push(line);
          if (line.startsWith('EHLO') || line.startsWith('HELO')) {
            socket.write('250 localhost\r\n');
          } else if (line === 'DATA') {
            receivingMessage = true;
            socket.write('354 End with a dot\r\n');
          } else if (line === 'QUIT') {
            socket.end('221 Bye\r\n');
          } else {
            socket.write('250 OK\r\n');
          }
        }
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Loopback SMTP listener is unavailable');
      }
      mailerService.addTransporter('loopback-test', {
        host: '127.0.0.1',
        port: address.port,
        secure: false,
        ignoreTLS: true,
        connectionTimeout: 2000,
        greetingTimeout: 2000,
        socketTimeout: 2000,
      });

      const result = await mailerService.sendMail({
        transporterName: 'loopback-test',
        from: 'vigieau@example.test',
        to: ['first@example.test', 'second@example.test'],
        cc: 'copy@example.test',
        bcc: 'hidden@example.test',
        subject: 'Local SMTP regression',
        template: './creation_aci',
        context: {
          departementNom: 'Paris',
          acNumero: 'ACI-SMTP-001',
          acLien: 'https://admin.example.test/arretes/aci-smtp-001',
        },
        attachments: [{ filename: 'notice.txt', content: 'Local attachment' }],
      });

      expect(result.accepted).toEqual([
        'first@example.test',
        'second@example.test',
        'copy@example.test',
        'hidden@example.test',
      ]);
      expect(commands).toContain('MAIL FROM:<vigieau@example.test>');
      expect(commands).toContain('RCPT TO:<hidden@example.test>');
      const mime = message.join('\r\n');
      expect(mime).toContain('ACI-SMTP-001');
      expect(mime).toContain('filename=notice.txt');
      expect(mime).toContain(
        Buffer.from('Local attachment').toString('base64'),
      );
      expect(mime).not.toMatch(/^Bcc:/im);
    } finally {
      mailerService.removeTransporter('loopback-test');
      for (const socket of sockets) {
        socket.destroy();
      }
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });
});
