import {
  CanActivate,
  Controller,
  Get,
  HttpException,
  INestApplication,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { json, Response } from 'express';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createHttpFailureLoggingMiddleware } from './http-failure-logging.middleware';

class UnavailableGuard implements CanActivate {
  canActivate(): boolean {
    throw new HttpException({ reason: 'guard unavailable' }, 503);
  }
}

let notifyAbortStarted: () => void;

@Controller('failures')
class FailureController {
  @Get('handled/:id')
  handled() {
    throw new HttpException({ reason: 'test unavailable' }, 503);
  }

  @Get('guarded/:id')
  @UseGuards(UnavailableGuard)
  guarded() {
    throw new Error('The guard must prevent this handler from running');
  }

  @Get('success')
  success() {
    return { ok: true };
  }

  @Get('conflict')
  conflict() {
    throw new HttpException({ reason: 'ambiguous' }, 409);
  }

  @Get('abort/:id')
  abort() {
    notifyAbortStarted();
    return new Promise(() => undefined);
  }

  @Get('abort-after-headers/:id')
  abortAfterHeaders(@Res() response: Response) {
    response.status(503).flushHeaders();
    notifyAbortStarted();
  }
}

describe('HTTP failure logging at the response boundary', () => {
  let app: INestApplication;
  const logger = { error: jest.fn(), warn: jest.fn() };
  const validRequestId = 'd5a952e1-2847-479b-a9bc-1077bdb1bf28';
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [FailureController],
      providers: [UnavailableGuard],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.use(createHttpFailureLoggingMiddleware(logger));
    app.use('/early-failure', (_request, response) => {
      response.status(502).json({ reason: 'early middleware unavailable' });
    });
    app.use(
      '/parser-failure',
      json({
        type: () => {
          throw new Error('Private parser diagnostic must not be logged');
        },
      }),
    );
    app.use(json());
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    logger.error.mockReset();
    logger.warn.mockReset();
  });

  it('logs a handled 503 once, preserves its body and redacts request values', async () => {
    const response = await request(app.getHttpServer())
      .get(
        '/api/failures/handled/private-user@example.test?lat=43.6154&token=private-token',
      )
      .set('X-Request-ID', validRequestId)
      .set('Authorization', 'Bearer private-auth')
      .set('X-Forwarded-For', '192.0.2.33');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ reason: 'test unavailable' });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    const record = JSON.parse(logger.error.mock.calls[0][0]);
    expect(record).toEqual({
      event: 'http_5xx',
      requestId: validRequestId,
      method: 'GET',
      route: '/api/failures/handled/:id',
      statusCode: 503,
      durationMs: expect.any(Number),
    });
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(record)).not.toMatch(
      /private|43\.6154|192\.0\.2\.33|Authorization|token|body|email/,
    );
  });

  it('captures a guard failure that occurs before Nest interceptors', async () => {
    const response = await request(app.getHttpServer()).get(
      '/api/failures/guarded/private-id',
    );
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ reason: 'guard unavailable' });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logger.error.mock.calls[0][0])).toMatchObject({
      route: '/api/failures/guarded/:id',
      statusCode: 503,
    });
  });

  it.each([
    ['missing', undefined],
    ['untrusted', 'private-user@example.test'],
    ['oversized', 'a'.repeat(256)],
  ])(
    'generates a UUID when the incoming request id is %s',
    async (_name, id) => {
      const pending = request(app.getHttpServer()).get('/early-failure');
      if (id !== undefined) pending.set('X-Request-ID', id);
      const response = await pending;
      expect(response.status).toBe(502);
      const record = JSON.parse(logger.error.mock.calls[0][0]);
      expect(record.requestId).toMatch(uuidPattern);
      expect(record.requestId).not.toBe(id);
      expect(record.route).toBe('<unmatched>');
    },
  );

  it('captures a parser failure before routing without logging its payload or diagnostic', async () => {
    const response = await request(app.getHttpServer())
      .post('/parser-failure?token=private-query')
      .send({ email: 'private-user@example.test', secret: 'private-body' });
    expect(response.status).toBe(500);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const record = JSON.parse(logger.error.mock.calls[0][0]);
    expect(record).toMatchObject({
      event: 'http_5xx',
      method: 'POST',
      route: '<unmatched>',
      statusCode: 500,
    });
    expect(JSON.stringify(record)).not.toMatch(/private|email|secret|parser/i);
  });

  it('does not turn completed 2xx, 4xx or parser errors into failure records', async () => {
    await request(app.getHttpServer()).get('/api/failures/success').expect(200);
    await request(app.getHttpServer())
      .get('/api/failures/conflict')
      .expect(409);
    await request(app.getHttpServer())
      .post('/api/failures/success')
      .set('Content-Type', 'application/json')
      .send('{invalid json')
      .expect(400);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['abort', null],
    ['abort-after-headers', 503],
  ])(
    'records an interrupted %s request once without inventing a status',
    async (path, statusCode) => {
      const started = new Promise<void>((resolve) => {
        notifyAbortStarted = resolve;
      });
      const logged = new Promise<void>((resolve) => {
        logger.warn.mockImplementationOnce(() => resolve());
      });
      const address = app.getHttpServer().address() as AddressInfo;
      const client = httpRequest({
        host: '127.0.0.1',
        port: address.port,
        path: `/api/failures/${path}/private-id?token=private-token`,
        headers: { 'x-request-id': validRequestId },
      });
      client.on('error', () => undefined);
      client.end();
      await started;
      client.destroy();
      await logged;

      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(JSON.parse(logger.warn.mock.calls[0][0])).toEqual({
        event: 'http_request_aborted',
        requestId: validRequestId,
        method: 'GET',
        route: `/api/failures/${path}/:id`,
        statusCode,
        durationMs: expect.any(Number),
      });
    },
  );
});
