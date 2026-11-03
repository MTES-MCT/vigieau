import { Test, TestingModule } from '@nestjs/testing';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';
import { CreateSubscriptionDto } from './dto/create_subscription.dto';
import { SubscriptionDto } from './dto/subscription.dto';
import {
  INestApplication,
  NotFoundException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import JwtGuard from '../auth/jwt.guard';

describe('SubscriptionsController', () => {
  let controller: SubscriptionsController;
  let app: INestApplication;

  // Mock pour le service des abonnements
  const mockSubscriptionsService = {
    create: jest.fn(),
    getSubscriptionsByEmail: jest.fn(),
    deleteSubscriptionById: jest.fn(),
    deleteSubscriptionByEmail: jest.fn(),
    requestManagementLink: jest.fn(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 900_000, limit: 300 }])],
      controllers: [SubscriptionsController],
      providers: [
        {
          provide: SubscriptionsService,
          useValue: mockSubscriptionsService,
        },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue({
        canActivate(context) {
          const req = context.switchToHttp().getRequest();
          if (req.headers.authorization !== 'Bearer test-session')
            throw new UnauthorizedException();
          req.user = { email: 'test@example.com' };
          return true;
        },
      })
      .compile();

    controller = <SubscriptionsController>module.get(SubscriptionsController);
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('create', () => {
    it('should create a subscription', async () => {
      const createSubscriptionDto: CreateSubscriptionDto = <any>{
        email: 'test@example.com',
        topic: 'water-alert',
      };
      const expectedResult: SubscriptionDto = <any>{
        id: '1',
        email: 'test@example.com',
        topic: 'water-alert',
        createdAt: new Date(),
      };

      // Mock du service
      mockSubscriptionsService.create.mockResolvedValue(expectedResult);

      const result = await controller.create(
        {
          user: { email: 'test@example.com' },
          headers: { 'x-forwarded-for': '127.0.0.1' },
        } as any,
        createSubscriptionDto,
      );

      expect(result).toEqual(expectedResult);
      expect(mockSubscriptionsService.create).toHaveBeenCalledWith(
        createSubscriptionDto,
        '127.0.0.1',
      );
    });
  });

  describe('getAll', () => {
    it("should return all subscriptions for the user's email", async () => {
      const mockEmail = 'test@example.com';
      const expectedResult: SubscriptionDto[] = <any[]>[
        {
          id: '1',
          email: 'test@example.com',
          topic: 'water-alert',
          createdAt: new Date(),
        },
        {
          id: '2',
          email: 'test@example.com',
          topic: 'drought-warning',
          createdAt: new Date(),
        },
      ];

      // Mock du service
      mockSubscriptionsService.getSubscriptionsByEmail.mockResolvedValue(
        expectedResult,
      );

      const result = await controller.getAll({
        user: { email: mockEmail },
      } as any);

      expect(result).toEqual(expectedResult);
      expect(
        mockSubscriptionsService.getSubscriptionsByEmail,
      ).toHaveBeenCalledWith(mockEmail);
    });

    it('should return an empty array if no subscriptions are found', async () => {
      const mockEmail = 'unknown@example.com';
      const expectedResult: SubscriptionDto[] = [];

      mockSubscriptionsService.getSubscriptionsByEmail.mockResolvedValue(
        expectedResult,
      );

      const result = await controller.getAll({
        user: { email: mockEmail },
      } as any);

      expect(result).toEqual(expectedResult);
      expect(
        mockSubscriptionsService.getSubscriptionsByEmail,
      ).toHaveBeenCalledWith(mockEmail);
    });
  });

  describe('remove', () => {
    it('should delete a subscription by ID', async () => {
      const mockId = 1;
      const mockEmail = 'test@example.com';

      // Mock du service
      mockSubscriptionsService.deleteSubscriptionById.mockResolvedValue(
        undefined,
      );

      const result = await controller.remove(
        { user: { email: mockEmail } } as any,
        mockId,
      );

      expect(result).toBeUndefined(); // La méthode ne retourne rien (status 204)
      expect(
        mockSubscriptionsService.deleteSubscriptionById,
      ).toHaveBeenCalledWith(mockId, mockEmail);
    });

    it('should throw an error if the subscription does not exist', async () => {
      const mockId = 999;
      const mockEmail = 'test@example.com';

      mockSubscriptionsService.deleteSubscriptionById.mockRejectedValue(
        new NotFoundException('Subscription not found'),
      );

      await expect(
        controller.remove({ user: { email: mockEmail } } as any, mockId),
      ).rejects.toThrow(NotFoundException);
      expect(
        mockSubscriptionsService.deleteSubscriptionById,
      ).toHaveBeenCalledWith(mockId, mockEmail);
    });
  });

  describe('removeAll', () => {
    it('should delete all subscriptions for the user', async () => {
      const mockEmail = 'test@example.com';

      // Mock du service
      mockSubscriptionsService.deleteSubscriptionByEmail.mockResolvedValue(
        undefined,
      );

      const result = await controller.removeAll({
        user: { email: mockEmail },
      } as any);

      expect(result).toBeUndefined(); // La méthode ne retourne rien (status 204)
      expect(
        mockSubscriptionsService.deleteSubscriptionByEmail,
      ).toHaveBeenCalledWith(mockEmail);
    });

    it('should handle cases where there are no subscriptions to delete', async () => {
      const mockEmail = 'unknown@example.com';

      mockSubscriptionsService.deleteSubscriptionByEmail.mockResolvedValue(
        undefined,
      );

      const result = await controller.removeAll({
        user: { email: mockEmail },
      } as any);

      expect(result).toBeUndefined();
      expect(
        mockSubscriptionsService.deleteSubscriptionByEmail,
      ).toHaveBeenCalledWith(mockEmail);
    });
  });

  describe('HTTP routing and validation', () => {
    it.each(['/api/subscriptions/all', '/api/subscriptions'])(
      'routes %s to authenticated bulk deletion',
      async (path) => {
        await request(app.getHttpServer())
          .delete(path)
          .set('Authorization', 'Bearer test-session')
          .expect(204);
        expect(
          mockSubscriptionsService.deleteSubscriptionByEmail,
        ).toHaveBeenCalledWith('test@example.com');
        expect(
          mockSubscriptionsService.deleteSubscriptionById,
        ).not.toHaveBeenCalled();
      },
    );

    it.each([
      '/api/subscriptions/all',
      '/api/subscriptions',
      '/api/subscriptions/42',
    ])('requires authentication for %s', async (path) => {
      await request(app.getHttpServer()).delete(path).expect(401);
      expect(
        mockSubscriptionsService.deleteSubscriptionByEmail,
      ).not.toHaveBeenCalled();
      expect(
        mockSubscriptionsService.deleteSubscriptionById,
      ).not.toHaveBeenCalled();
    });

    it('passes a numeric ID and authenticated email to individual deletion', async () => {
      await request(app.getHttpServer())
        .delete('/api/subscriptions/42')
        .set('Authorization', 'Bearer test-session')
        .expect(204);
      expect(
        mockSubscriptionsService.deleteSubscriptionById,
      ).toHaveBeenCalledWith(42, 'test@example.com');
    });

    it.each(['invalid', '1.5', '1e3'])(
      'rejects non-integer ID %s without calling the service',
      async (id) => {
        await request(app.getHttpServer())
          .delete(`/api/subscriptions/${id}`)
          .set('Authorization', 'Bearer test-session')
          .expect(400);
        expect(
          mockSubscriptionsService.deleteSubscriptionById,
        ).not.toHaveBeenCalled();
      },
    );

    it.each(['0', '-1', '2147483648', '999999999999999999999999999999'])(
      'returns 400 for an out-of-range ID %s before reaching PostgreSQL',
      async (id) => {
        const remove = jest.fn();
        mockSubscriptionsService.deleteSubscriptionById.mockImplementation(
          (parsedId, email) =>
            SubscriptionsService.prototype.deleteSubscriptionById.call(
              { abonnementMailRepository: { delete: remove } } as any,
              parsedId,
              email,
            ),
        );
        await request(app.getHttpServer())
          .delete(`/api/subscriptions/${id}`)
          .set('Authorization', 'Bearer test-session')
          .expect(400);
        expect(remove).not.toHaveBeenCalled();
      },
    );

    it('accepts link recovery without an old token, trims email and strips unrelated input', async () => {
      const result = {
        message:
          'Si des abonnements sont associés à cette adresse, un lien de gestion vous sera envoyé.',
      };
      mockSubscriptionsService.requestManagementLink.mockResolvedValue(result);
      const response = await request(app.getHttpServer())
        .post('/api/subscriptions/management-link')
        .send({ email: ' test@example.com ', token: 'expired' })
        .expect(202);
      expect(response.body).toEqual(result);
      expect(
        mockSubscriptionsService.requestManagementLink,
      ).toHaveBeenCalledWith('test@example.com');
    });

    it.each([
      undefined,
      '',
      'invalid',
      ['test@example.com'],
      'x'.repeat(256) + '@example.com',
    ])('rejects invalid recovery email %p', async (email) => {
      await request(app.getHttpServer())
        .post('/api/subscriptions/management-link')
        .send({ email })
        .expect(400);
      expect(
        mockSubscriptionsService.requestManagementLink,
      ).not.toHaveBeenCalled();
    });

    it('limits recovery attempts to three per fifteen minutes', async () => {
      for (let i = 0; i < 3; i++) {
        await request(app.getHttpServer())
          .post('/api/subscriptions/management-link')
          .send({ email: `test${i}@example.com` })
          .expect(202);
      }
      const response = await request(app.getHttpServer())
        .post('/api/subscriptions/management-link')
        .send({ email: 'test3@example.com' })
        .expect(429);
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(800);
      expect(
        mockSubscriptionsService.requestManagementLink,
      ).toHaveBeenCalledTimes(3);
    });

    it('limits subscription confirmations to ten requests per fifteen minutes', async () => {
      const input = {
        email: 'test@example.com',
        profil: 'particulier',
        typesEau: ['AEP'],
        commune: '75056',
      };
      for (let i = 0; i < 10; i++) {
        await request(app.getHttpServer())
          .post('/api/subscriptions')
          .send(input)
          .expect(201);
      }
      await request(app.getHttpServer())
        .post('/api/subscriptions')
        .send(input)
        .expect(429);
      expect(mockSubscriptionsService.create).toHaveBeenCalledTimes(10);
    });
  });
});
