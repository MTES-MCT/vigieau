import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { BrevoService } from './brevo.service';
import { CommunesService } from '../communes/communes.service';
import { BrevoClient } from '@getbrevo/brevo';

const mockSendTransacEmail = jest.fn();
const mockGetSmtpTemplate = jest.fn();

jest.mock('@getbrevo/brevo', () => ({
  BrevoClient: jest.fn(() => ({
    transactionalEmails: {
      sendTransacEmail: mockSendTransacEmail,
      getSmtpTemplate: mockGetSmtpTemplate,
    },
  })),
}));

describe('BrevoService', () => {
  let service: BrevoService;
  let configService: ConfigService;
  let jwtService: JwtService;
  let communesService: CommunesService;

  beforeEach(async () => {
    mockSendTransacEmail.mockReset();
    mockGetSmtpTemplate.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BrevoService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const envVars = {
                BREVO_API_KEY: 'test-api-key',
                EMAIL_NOTIFICATIONS_ENABLED: '1',
                EMAIL_NOTIFICATIONS_DEV_RECIPIENT: 'dev@example.com',
                WEBSITE_URL: 'https://example.com',
                JWT_SECRET: 'jwt-secret-key',
              };
              return envVars[key];
            }),
          },
        },
        {
          provide: JwtService,
          useValue: {
            sign: jest.fn(
              (payload: any) => `signed-token-for-${payload.email}`,
            ), // Simule la génération d'un token JWT
          },
        },
        {
          provide: CommunesService,
          useValue: {
            getCommune: jest.fn((codeCommune: any) => ({
              nom: `Commune-${codeCommune}`,
            })), // Simule le service des communes
          },
        },
      ],
    }).compile();

    service = <BrevoService>module.get(BrevoService);
    configService = <ConfigService>module.get(ConfigService);
    jwtService = <JwtService>module.get(JwtService);
    communesService = <CommunesService>module.get(CommunesService);
  });

  afterEach(() => {
    jest.clearAllMocks(); // Réinitialise les mocks après chaque test
  });

  describe('Initialisation', () => {
    it('devrait initialiser le service avec la clé API Brevo', () => {
      expect(BrevoClient).toHaveBeenCalledWith({
        apiKey: 'test-api-key',
        maxRetries: 0,
      });
    });
  });

  describe('sendSituationUpdate', () => {
    it.each([
      { lon: 0, lat: 0 },
      { lon: '-61.5532', lat: '16.2415' },
    ])(
      'links directly to the subscribed coordinates (%j)',
      async (coordinates) => {
        await service.sendSituationUpdate(
          'user@example.com',
          'alerte',
          true,
          'vigilance',
          false,
          'pas_restriction',
          false,
          '97105',
          'Point sur la carte',
          'particulier',
          coordinates,
        );
        const url = new URL(
          mockSendTransacEmail.mock.calls[0][0].params.restrictionUrl,
        );
        expect(url.searchParams.get('lon')).toBe(String(coordinates.lon));
        expect(url.searchParams.get('lat')).toBe(String(coordinates.lat));
        expect(url.searchParams.get('commune')).toBe('97105');
      },
    );

    it('refuses invalid coordinates rather than sending a misleading location link', () => {
      expect(() =>
        service.sendSituationUpdate(
          'user@example.com',
          'alerte',
          true,
          'vigilance',
          false,
          'pas_restriction',
          false,
          undefined,
          'Point sur la carte',
          'particulier',
          { lon: 181, lat: 0 },
        ),
      ).toThrow('Invalid subscription coordinates');
      expect(mockSendTransacEmail).not.toHaveBeenCalled();
    });
    it('preserves special characters in the situation link parameters', async () => {
      const address = '12 rue A & B + annexe #3, Test';
      await service.sendSituationUpdate(
        'user@example.com',
        'alerte',
        true,
        'vigilance',
        false,
        'pas_restriction',
        false,
        '75001',
        address,
        'particulier',
      );
      const url = new URL(
        mockSendTransacEmail.mock.calls[0][0].params.restrictionUrl,
      );
      expect(url.origin).toBe('https://example.com');
      expect(url.pathname).toBe('/situation');
      expect(url.searchParams.get('adresse')).toBe(address);
      expect(url.searchParams.get('profil')).toBe('particulier');
      expect([...url.searchParams.keys()]).toEqual(['profil', 'adresse']);
      expect(url.hash).toBe('');
    });
    it('devrait envoyer un email avec les bons paramètres', async () => {
      const email = 'user@example.com';
      const params = {
        niveauGraviteAep: 'alerte',
        changementAep: true,
        niveauGraviteSup: 'pas_restriction',
        changementSup: false,
        niveauGraviteSou: 'vigilance',
        changementSou: true,
        codeCommune: '75001',
        libelleLocalisation: 'Rue de Rivoli, Paris',
        profil: 'user_profile',
      };

      // @ts-expect-error The mocked SDK result is reduced to a string.
      jest.spyOn(service, 'sendMail').mockResolvedValueOnce('Email sent');

      const result = await service.sendSituationUpdate(
        email,
        params.niveauGraviteAep,
        params.changementAep,
        params.niveauGraviteSup,
        params.changementSup,
        params.niveauGraviteSou,
        params.changementSou,
        params.codeCommune,
        params.libelleLocalisation,
        params.profil,
      );

      expect(service.sendMail).toHaveBeenCalledWith(
        65, // Template ID attendu
        'dev@example.com', // Email de développement
        expect.objectContaining({
          address: 'Rue de Rivoli, Paris',
          city: 'Commune-75001',
          unsubscribeUrl:
            'https://example.com/abonnements?token=signed-token-for-user@example.com',
        }),
      );
      expect(result).toBe('Email sent');
    });

    it('devrait utiliser le libellé de localisation si la commune est introuvable', async () => {
      jest.spyOn(communesService, 'getCommune').mockReturnValueOnce(undefined);
      // @ts-expect-error The mocked SDK result is reduced to a string.
      jest.spyOn(service, 'sendMail').mockResolvedValueOnce('Email sent');

      await service.sendSituationUpdate(
        'user@example.com',
        'alerte',
        true,
        'pas_restriction',
        false,
        'vigilance',
        true,
        '75001',
        'Rue de Rivoli, Paris',
        'user_profile',
      );

      expect(service.sendMail).toHaveBeenCalledWith(
        65,
        'dev@example.com',
        expect.objectContaining({
          city: 'Rue de Rivoli, Paris',
        }),
      );
    });

    it('ne devrait pas envoyer d’email si les notifications sont désactivées', async () => {
      jest.spyOn(configService, 'get').mockImplementation((key) => {
        if (key === 'EMAIL_NOTIFICATIONS_ENABLED') return '0'; // Désactive les notifications
        return 'some-value';
      });

      const result = await service.sendSituationUpdate(
        'user@example.com',
        'alerte',
        true,
        'pas_restriction',
        false,
        'vigilance',
        true,
        '75001',
        'Rue de Rivoli, Paris',
        'user_profile',
      );

      expect(result).toBeUndefined();
      expect(mockSendTransacEmail).not.toHaveBeenCalled();
    });
  });

  describe('computeUnsubscribeUrl', () => {
    it('devrait générer une URL de désinscription avec un token valide', () => {
      const result = service.computeUnsubscribeUrl('user@example.com');

      expect(jwtService.sign).toHaveBeenCalledWith(
        { email: 'user@example.com' },
        {
          secret: 'jwt-secret-key',
          expiresIn: '7d',
        },
      );

      expect(result).toBe(
        'https://example.com/abonnements?token=signed-token-for-user@example.com',
      );
    });
  });

  describe('sendMail', () => {
    const createServiceWithoutApiKey = (nodeEnv: string) => {
      const configServiceWithoutApiKey = {
        get: jest.fn((key: string) =>
          key === 'NODE_ENV' ? nodeEnv : undefined,
        ),
      } as unknown as ConfigService;

      return new BrevoService(
        jwtService,
        configServiceWithoutApiKey,
        communesService,
      );
    };

    it('devrait envoyer un email via Brevo', async () => {
      mockSendTransacEmail.mockResolvedValueOnce({
        messageId: '12345',
      });

      const result = await service['sendMail'](65, 'user@example.com', {
        param1: 'value1',
      });

      expect(mockSendTransacEmail).toHaveBeenCalledWith({
        templateId: 65,
        to: [{ email: 'user@example.com' }],
        params: { param1: 'value1' },
      });
      expect(result).toEqual({ messageId: '12345' });
    });

    it('devrait gérer les erreurs lors de l’envoi d’email', async () => {
      mockSendTransacEmail.mockRejectedValueOnce(new Error('API Error'));

      await expect(
        service['sendMail'](65, 'user@example.com', { param1: 'value1' }),
      ).rejects.toThrow('API Error');
    });

    it('propagates synchronous SDK errors instead of reporting success', () => {
      mockSendTransacEmail.mockImplementationOnce(() => {
        throw new Error('SDK error');
      });
      expect(() => service.sendMail(29, 'user@example.com', {})).toThrow(
        'SDK error',
      );
    });

    it("ne devrait pas envoyer d'email sans clé API hors production", () => {
      const serviceWithoutApiKey = createServiceWithoutApiKey('test');

      expect(
        serviceWithoutApiKey.sendMail(65, 'user@example.com', {
          param1: 'value1',
        }),
      ).toBeUndefined();
      expect(mockSendTransacEmail).not.toHaveBeenCalled();
    });

    it('devrait refuser de démarrer un envoi sans clé API en production', () => {
      const serviceWithoutApiKey = createServiceWithoutApiKey('production');

      expect(() =>
        serviceWithoutApiKey.sendMail(65, 'user@example.com', {
          param1: 'value1',
        }),
      ).toThrow('BREVO_API_KEY is required');
      expect(mockSendTransacEmail).not.toHaveBeenCalled();
    });
  });

  describe('sendManagementLink', () => {
    it('sends a fresh management link with the verified sender and dedicated content', async () => {
      mockGetSmtpTemplate.mockResolvedValueOnce({
        sender: { email: 'alerts@example.com', name: 'VigiEau', id: '42' },
        replyTo: 'support@example.com',
      });
      mockSendTransacEmail.mockResolvedValueOnce({
        messageId: 'management-link',
      });
      await expect(
        service.sendManagementLink('user@example.com'),
      ).resolves.toEqual({
        messageId: 'management-link',
      });
      expect(mockGetSmtpTemplate).toHaveBeenCalledWith({ templateId: 29 });
      expect(jwtService.sign).toHaveBeenCalledWith(
        { email: 'user@example.com' },
        { secret: 'jwt-secret-key', expiresIn: '7d' },
      );
      expect(mockSendTransacEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          sender: { email: 'alerts@example.com', name: 'VigiEau' },
          replyTo: { email: 'support@example.com' },
          to: [{ email: 'user@example.com' }],
          subject: 'Gérer vos abonnements aux alertes VigiEau',
          textContent: expect.stringContaining(
            'https://example.com/abonnements?token=signed-token-for-user@example.com',
          ),
          htmlContent: expect.stringContaining('Gérer mes abonnements</a>'),
        }),
      );
      expect(mockSendTransacEmail.mock.calls[0][0]).not.toHaveProperty(
        'templateId',
      );
    });

    it('does not send when the template sender cannot be resolved', async () => {
      mockGetSmtpTemplate.mockResolvedValueOnce({ sender: {} });
      await expect(
        service.sendManagementLink('user@example.com'),
      ).rejects.toThrow('sender is unavailable');
      expect(mockSendTransacEmail).not.toHaveBeenCalled();
    });

    it('propagates provider errors so a new request can be made', async () => {
      mockGetSmtpTemplate.mockResolvedValueOnce({
        sender: { email: 'alerts@example.com' },
      });
      mockSendTransacEmail.mockRejectedValueOnce(
        new Error('Email service unavailable'),
      );
      await expect(
        service.sendManagementLink('user@example.com'),
      ).rejects.toThrow('Email service unavailable');
    });
  });
});
