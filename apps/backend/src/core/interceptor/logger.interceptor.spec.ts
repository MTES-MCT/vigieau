import { LoggerInterceptor } from './logger.interceptor';
import { ExecutionContext, CallHandler, HttpException } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { VigieauLogger } from '../../logger/vigieau.logger';
import * as Sentry from '@sentry/nestjs';

jest.mock('@sentry/nestjs', () => ({
  withScope: jest.fn(),
  captureException: jest.fn(),
}));

describe('LoggerInterceptor', () => {
  let interceptor: LoggerInterceptor;
  let mockLogger: Partial<VigieauLogger>;
  let mockContext: Partial<ExecutionContext>;
  let mockHandler: Partial<CallHandler>;
  let scope: {
    setFingerprint: jest.Mock;
    setTags: jest.Mock;
    setContext: jest.Mock;
    addEventProcessor: jest.Mock;
  };

  beforeEach(() => {
    // Mock de l'intercepteur avec un logger mocké
    interceptor = new LoggerInterceptor();
    scope = {
      setFingerprint: jest.fn(),
      setTags: jest.fn(),
      setContext: jest.fn(),
      addEventProcessor: jest.fn(),
    };
    (Sentry.withScope as jest.Mock).mockImplementation((callback) =>
      callback(scope),
    );

    // Mock du logger
    mockLogger = {
      log: jest.fn(),
      error: jest.fn(),
    };

    // Remplace le logger interne par un mock
    (interceptor as any)._logger = mockLogger;

    // Mock du contexte d'exécution (ExecutionContext)
    mockContext = {
      switchToHttp: jest.fn().mockReturnValue({
        getResponse: jest.fn().mockReturnValue({ locals: {} }),
        getRequest: jest.fn().mockReturnValue({
          ip: '127.0.0.1',
          method: 'GET',
          originalUrl: '/api/test',
          body: { key: 'value' },
          headers: { 'user-agent': 'TestAgent', host: 'localhost:3000' },
          session: { user: { email: 'test@example.com' } },
        }),
      }),
    };

    // Mock du gestionnaire de réponse (CallHandler)
    mockHandler = {
      handle: jest.fn(() => of('response')), // Simule une réponse réussie
    };
  });

  afterEach(() => {
    jest.clearAllMocks(); // Nettoie tous les mocks après chaque test
  });

  describe('intercept', () => {
    it.each([500, 502, 503])(
      'reports an explicit HTTP %s without sensitive request data',
      async (status) => {
        const req = mockContext.switchToHttp().getRequest();
        req.route = { path: '/api/subscriptions' };
        req.originalUrl = '/api/subscriptions?token=private';
        const error = new HttpException('Sensitive upstream response', status);
        mockHandler.handle = jest.fn(() => throwError(() => error));

        await expect(
          lastValueFrom(
            interceptor.intercept(
              mockContext as ExecutionContext,
              mockHandler as CallHandler,
            ),
          ),
        ).rejects.toBe(error);

        expect(Sentry.captureException).toHaveBeenCalledTimes(1);
        expect(
          (Sentry.captureException as jest.Mock).mock.calls[0][0].message,
        ).toBe(`HTTP ${status} GET /api/subscriptions`);
        expect(scope.setFingerprint).toHaveBeenCalledWith([
          'http-server-error',
          'GET',
          '/api/subscriptions',
          String(status),
        ]);
        const sanitize = scope.addEventProcessor.mock.calls[0][0];
        expect(
          sanitize({
            request: { data: 'private', headers: { authorization: 'private' } },
            user: { email: 'private' },
            breadcrumbs: [{ message: 'private' }],
            extra: { private: true },
            release: 'release-id',
          }),
        ).toEqual({ release: 'release-id' });
      },
    );

    it.each([
      new HttpException('Invalid input', 400),
      new HttpException('Conflicting zones', 409),
      new Error('Already captured by the Sentry global filter'),
    ])(
      'does not duplicate expected or automatically captured errors',
      async (error) => {
        mockHandler.handle = jest.fn(() => throwError(() => error));
        await expect(
          lastValueFrom(
            interceptor.intercept(
              mockContext as ExecutionContext,
              mockHandler as CallHandler,
            ),
          ),
        ).rejects.toBe(error);
        expect(Sentry.captureException).not.toHaveBeenCalled();
      },
    );

    it('leaves health alerts to the existing production monitors', async () => {
      mockContext.switchToHttp().getRequest().route = {
        path: '/api/health/statistics',
      };
      const error = new HttpException('Not ready', 503);
      mockHandler.handle = jest.fn(() => throwError(() => error));
      await expect(
        lastValueFrom(
          interceptor.intercept(
            mockContext as ExecutionContext,
            mockHandler as CallHandler,
          ),
        ),
      ).rejects.toBe(error);
      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    it('correlates request and response logs with the validated HTTP failure id', async () => {
      const requestId = 'd5a952e1-2847-479b-a9bc-1077bdb1bf28';
      mockContext.switchToHttp().getResponse().locals.httpRequestId = requestId;

      await lastValueFrom(
        interceptor.intercept(
          mockContext as ExecutionContext,
          mockHandler as CallHandler,
        ),
      );

      expect(mockLogger.log).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining(`REQUEST - ID: ${requestId},`),
      );
      expect(mockLogger.log).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining(`RESPONSE - ID: ${requestId},`),
      );
    });

    it('devrait logger la requête entrante et la réponse sortante', async () => {
      const mockRequest = mockContext.switchToHttp().getRequest();

      await lastValueFrom(
        interceptor.intercept(
          mockContext as ExecutionContext,
          mockHandler as CallHandler,
        ),
      ); // Convertit l'observable en promesse pour attendre sa résolution

      // Vérifie le log de la requête
      expect(mockLogger.log).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('REQUEST - ID: '), // On ignore l'ID exact
      );
      expect(mockLogger.log).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining(`IP: ${mockRequest.ip}`),
      );
      expect(mockLogger.log).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining(`User: test@example.com`),
      );
      expect(mockLogger.log).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining(`Method: ${mockRequest.method}`),
      );
      expect(mockLogger.log).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining(`URL: ${mockRequest.originalUrl}`),
      );
      expect(mockLogger.log).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining(`Body: ${JSON.stringify(mockRequest.body)}`),
      );

      // Vérifie le log de la réponse
      expect(mockLogger.log).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('RESPONSE - ID: '), // On ignore l'ID exact
      );
      expect(mockLogger.log).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining(`URL: ${mockRequest.originalUrl}`),
      );
      expect(mockLogger.log).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining(`User: test@example.com`),
      );
    });

    it('devrait gérer l’absence de session ou d’utilisateur', async () => {
      // Modifie le mock pour simuler une requête sans session
      mockContext.switchToHttp().getRequest = jest.fn().mockReturnValue({
        ip: '127.0.0.1',
        method: 'POST',
        originalUrl: '/api/test',
        body: { key: 'value' },
        headers: { 'user-agent': 'TestAgent', host: 'localhost:3000' },
      });

      await interceptor
        .intercept(mockContext as ExecutionContext, mockHandler as CallHandler)
        .toPromise();

      // Vérifie que le log de la requête est correctement formé même sans session
      expect(mockLogger.log).toHaveBeenCalledWith(
        expect.stringContaining('User: Anonymous'), // Devrait afficher "Anonymous" si aucun utilisateur
      );
    });

    it('devrait gérer l’absence de corps dans la requête', async () => {
      // Modifie le mock pour simuler une requête sans corps
      mockContext.switchToHttp().getRequest = jest.fn().mockReturnValue({
        ip: '127.0.0.1',
        method: 'PUT',
        originalUrl: '/api/no-body',
        body: undefined, // Pas de corps
        headers: { 'user-agent': 'TestAgent', host: 'localhost:3000' },
        session: { user: { email: 'test@example.com' } },
      });

      await interceptor
        .intercept(mockContext as ExecutionContext, mockHandler as CallHandler)
        .toPromise();

      // Vérifie que le log de la requête est correctement formé
      expect(mockLogger.log).toHaveBeenCalledWith(
        expect.stringContaining('Body: {}'), // Le corps devrait être vide
      );
    });
  });
});
