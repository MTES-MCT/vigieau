import { isIP } from 'node:net';
import { UnauthorizedException } from '@nestjs/common';
import { isPreproductionAuthEnabled } from '../core/preproduction-auth';

export function subscriptionRateLimitTracker(req: Record<string, any>): string {
  if (isPreproductionAuthEnabled()) {
    // The gateway replaces this header with the rate key from its signed
    // session cookie. It represents the initial authenticated client IP,
    // so front/admin relays and the shared login do not merge all quotas.
    const rateKey = req.headers?.['x-vigieau-preprod-rate-key'];
    if (
      typeof rateKey !== 'string' ||
      rateKey.length !== 43 ||
      !/^[A-Za-z0-9_-]{43}$/.test(rateKey)
    ) {
      throw new UnauthorizedException(
        'Authenticated preproduction rate key required',
      );
    }
    return `preprod-ip:${rateKey}`;
  }

  // Scalingo overwrites this header with the originating client IP. Trust it
  // only in that runtime; local/direct requests keep their socket identity.
  const realIp = req.headers?.['x-real-ip'];
  if (
    process.env.SCALINGO_APPLICATION_ID &&
    typeof realIp === 'string' &&
    isIP(realIp)
  ) {
    return realIp;
  }
  return req.ip;
}
