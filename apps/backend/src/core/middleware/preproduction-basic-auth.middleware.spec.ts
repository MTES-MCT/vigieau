import express from 'express';
import request from 'supertest';
import { createPreproductionBasicAuth } from './preproduction-basic-auth.middleware';

const environment = {
  APP: 'vigieau-api-preprod',
  VIGIEAU_PREPROD_AUTH_ENABLED: 'true',
  VIGIEAU_PREPROD_AUTH_USERNAME: 'synthetic-team',
  VIGIEAU_PREPROD_AUTH_PASSWORD: 'synthetic-password',
};

function app() {
  const server = express();
  server.use(createPreproductionBasicAuth(environment));
  server.use((_request, response) => response.status(200).send('ok'));
  return server;
}

describe('preproduction HTTP Basic authentication', () => {
  it.each([undefined, '', 'false'])(
    'leaves normal application authentication unchanged when disabled: %p',
    (flag) => {
      expect(
        createPreproductionBasicAuth({
          APP: 'vigieau-api',
          VIGIEAU_PREPROD_AUTH_ENABLED: flag,
        }),
      ).toBeUndefined();
    },
  );

  it.each([
    { VIGIEAU_PREPROD_AUTH_ENABLED: 'TRUE' },
    { APP: 'vigieau-api' },
    { APP: undefined },
    { VIGIEAU_PREPROD_AUTH_USERNAME: '' },
    { VIGIEAU_PREPROD_AUTH_USERNAME: 'invalid:name' },
    { VIGIEAU_PREPROD_AUTH_PASSWORD: '' },
    { VIGIEAU_PREPROD_AUTH_PASSWORD: undefined },
  ])('refuses invalid activation or missing credentials: %p', (override) => {
    expect(() =>
      createPreproductionBasicAuth({ ...environment, ...override }),
    ).toThrow();
  });

  it.each(['/api/subscriptions', '/swagger', '/swagger-json'])(
    'challenges unauthenticated direct access to %s',
    async (path) => {
      const response = await request(app()).get(path).expect(401);
      expect(response.headers['www-authenticate']).toBe(
        'Basic realm="VigiEau preproduction"',
      );
    },
  );

  it('refuses incorrect credentials and Bearer tokens', async () => {
    await request(app())
      .get('/api/subscriptions')
      .auth(environment.VIGIEAU_PREPROD_AUTH_USERNAME, 'wrong-password')
      .expect(401);
    await request(app())
      .get('/api/subscriptions')
      .set('Authorization', 'Bearer subscription-jwt')
      .expect(401);
  });

  it('accepts the configured HTTP Basic credentials', async () => {
    await request(app())
      .get('/swagger')
      .auth(
        environment.VIGIEAU_PREPROD_AUTH_USERNAME,
        environment.VIGIEAU_PREPROD_AUTH_PASSWORD,
      )
      .expect(200, 'ok');
  });

  it('exempts only the exact GET liveness route', async () => {
    await request(app()).get('/api/health/live').expect(200, 'ok');
    for (const path of ['/api/health/live/', '/api/health/ready']) {
      await request(app()).get(path).expect(401);
    }
    await request(app()).post('/api/health/live').expect(401);
    await request(app()).head('/api/health/live').expect(401);
  });
});
