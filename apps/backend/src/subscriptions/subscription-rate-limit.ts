import { isIP } from 'node:net';

export function subscriptionRateLimitTracker(req: Record<string, any>): string {
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
