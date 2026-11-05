import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import JwtStrategy from './jwt.strategy';
import { SubscriptionsController } from '../subscriptions/subscriptions.controller';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';

describe('Subscription management authentication', () => {
  let app: INestApplication;
  const jwt = new JwtService({ secret: 'subscription-auth-test-only' });
  const service = {
    getSubscriptionsByEmail: jest.fn().mockResolvedValue([]),
    deleteSubscriptionByEmail: jest.fn().mockResolvedValue(undefined),
    deleteSubscriptionById: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
      controllers: [SubscriptionsController],
      providers: [
        JwtStrategy,
        { provide: SubscriptionsService, useValue: service },
        {
          provide: ConfigService,
          useValue: { get: () => 'subscription-auth-test-only' },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  beforeEach(() => jest.clearAllMocks());
  afterAll(async () => app.close());

  it('accepts existing seven-day links and scopes management to the signed email', async () => {
    const token = jwt.sign(
      { email: 'subscriber@example.com' },
      { expiresIn: '7d' },
    );
    await request(app.getHttpServer())
      .get('/api/subscriptions?email=someone-else@example.com')
      .set('Authorization', `Bearer ${token}`)
      .expect(200, []);
    expect(service.getSubscriptionsByEmail).toHaveBeenCalledWith(
      'subscriber@example.com',
    );

    await request(app.getHttpServer())
      .delete('/api/subscriptions/all?email=someone-else@example.com')
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    expect(service.deleteSubscriptionByEmail).toHaveBeenCalledWith(
      'subscriber@example.com',
    );
  });

  it('keeps the subscription JWT identity separate from the preproduction rate key', async () => {
    const token = jwt.sign(
      { email: 'subscriber@example.com' },
      { expiresIn: '7d' },
    );
    await request(app.getHttpServer())
      .get('/api/subscriptions')
      .set('X-Vigieau-Preprod-Rate-Key', 'A'.repeat(43))
      .set('Authorization', `Bearer ${token}`)
      .expect(200, []);
    expect(service.getSubscriptionsByEmail).toHaveBeenCalledWith(
      'subscriber@example.com',
    );

    await request(app.getHttpServer())
      .delete('/api/subscriptions/42')
      .set('X-Vigieau-Preprod-Rate-Key', 'A'.repeat(43))
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    expect(service.deleteSubscriptionById).toHaveBeenCalledWith(
      42,
      'subscriber@example.com',
    );
  });

  it('requires a valid subscription JWT even with a preproduction rate key', async () => {
    for (const method of ['get', 'delete'] as const) {
      await request(app.getHttpServer())
        [method]('/api/subscriptions')
        .set('X-Vigieau-Preprod-Rate-Key', 'A'.repeat(43))
        .set('Authorization', 'Bearer invalid-subscription-token')
        .expect(401);
    }
    expect(service.getSubscriptionsByEmail).not.toHaveBeenCalled();
    expect(service.deleteSubscriptionByEmail).not.toHaveBeenCalled();
  });

  it.each(['', 'tampered', 'expired', 'missing-email', 'invalid-email'])(
    'refuses %s credentials before reading or deleting subscriptions',
    async (kind) => {
      const token =
        kind === 'expired'
          ? jwt.sign({ email: 'subscriber@example.com' }, { expiresIn: -1 })
          : kind === 'missing-email'
            ? jwt.sign({ other: 'claim' }, { expiresIn: '7d' })
            : kind === 'invalid-email'
              ? jwt.sign({ email: '' }, { expiresIn: '7d' })
              : kind;
      for (const method of ['get', 'delete'] as const) {
        await request(app.getHttpServer())
          [method]('/api/subscriptions')
          .set('Authorization', `Bearer ${token}`)
          .expect(401);
      }
      expect(service.getSubscriptionsByEmail).not.toHaveBeenCalled();
      expect(service.deleteSubscriptionByEmail).not.toHaveBeenCalled();
    },
  );
});
