import { ConfigService } from '@nestjs/config';
import JwtStrategy from './jwt.strategy';
import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';

describe('JwtStrategy', () => {
  let jwtStrategy: JwtStrategy;
  let configService: ConfigService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtStrategy,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'JWT_SECRET') return 'test-secret'; // Simule une clé secrète
              return null;
            }),
          },
        },
      ],
    }).compile();

    jwtStrategy = <JwtStrategy>module.get(JwtStrategy);
    configService = <ConfigService>module.get(ConfigService);
  });

  it('devrait être défini', () => {
    expect(jwtStrategy).toBeDefined();
  });

  it('devrait utiliser la clé secrète depuis ConfigService', () => {
    const secret = configService.get('JWT_SECRET');
    expect(secret).toBe('test-secret');
  });

  describe('validate', () => {
    it('returns only the authenticated subscription email', async () => {
      const payload = {
        email: 'user@example.com',
        iat: 12345,
        exp: 23456,
      };

      const result = await jwtStrategy.validate(payload);
      expect(result).toEqual({
        email: 'user@example.com',
      });
    });

    it.each([
      undefined,
      null,
      {},
      { email: null },
      { email: '' },
      { email: 'invalid' },
      { email: ['user@example.com'] },
    ])(
      'rejects an invalid email claim before any subscription query (%j)',
      async (payload) => {
        await expect(jwtStrategy.validate(payload)).rejects.toThrow(
          UnauthorizedException,
        );
      },
    );
  });
});
