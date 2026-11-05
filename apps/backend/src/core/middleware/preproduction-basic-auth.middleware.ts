import basicAuth from 'express-basic-auth';
import { RequestHandler } from 'express';

export function createPreproductionBasicAuth(
  environment: Record<string, string | undefined> = process.env,
): RequestHandler | undefined {
  const enabled = environment.VIGIEAU_PREPROD_AUTH_ENABLED;
  if (enabled === undefined || enabled === '' || enabled === 'false') return;
  if (enabled !== 'true') {
    throw new Error('VIGIEAU_PREPROD_AUTH_ENABLED must be true or false');
  }
  if (environment.APP !== 'vigieau-api-preprod') {
    throw new Error(
      'Preproduction authentication requires vigieau-api-preprod',
    );
  }
  const username = environment.VIGIEAU_PREPROD_AUTH_USERNAME;
  const password = environment.VIGIEAU_PREPROD_AUTH_PASSWORD;
  if (!username?.trim() || username.includes(':') || !password?.trim()) {
    throw new Error(
      'Preproduction authentication username and password are required',
    );
  }
  const authenticate = basicAuth({
    users: { [username]: password },
    challenge: true,
    realm: 'VigiEau preproduction',
  });
  return (request, response, next) => {
    if (request.method === 'GET' && request.path === '/api/health/live') {
      return next();
    }
    return authenticate(request, response, next);
  };
}
