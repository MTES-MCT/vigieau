import { subscriptionRateLimitTracker } from './subscription-rate-limit';

describe('subscriptionRateLimitTracker', () => {
  const original = process.env.SCALINGO_APPLICATION_ID;
  afterEach(() => {
    if (original === undefined) delete process.env.SCALINGO_APPLICATION_ID;
    else process.env.SCALINGO_APPLICATION_ID = original;
  });

  it('ignores client-controlled forwarding headers outside Scalingo', () => {
    delete process.env.SCALINGO_APPLICATION_ID;
    expect(
      subscriptionRateLimitTracker({
        ip: '127.0.0.1',
        headers: { 'x-real-ip': '192.0.2.4', 'x-forwarded-for': '192.0.2.5' },
      }),
    ).toBe('127.0.0.1');
  });

  it.each(['192.0.2.4', '2001:db8::1'])(
    'uses the IP overwritten by the Scalingo router: %s',
    (ip) => {
      process.env.SCALINGO_APPLICATION_ID = 'test-app';
      expect(
        subscriptionRateLimitTracker({
          ip: '10.0.0.1',
          headers: { 'x-real-ip': ip },
        }),
      ).toBe(ip);
    },
  );

  it.each([undefined, 'invalid', '192.0.2.4,192.0.2.5', ['192.0.2.4']])(
    'falls back to the socket IP for invalid headers: %p',
    (realIp) => {
      process.env.SCALINGO_APPLICATION_ID = 'test-app';
      expect(
        subscriptionRateLimitTracker({
          ip: '10.0.0.1',
          headers: { 'x-real-ip': realIp },
        }),
      ).toBe('10.0.0.1');
    },
  );
});
