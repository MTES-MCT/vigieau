import { subscriptionRateLimitTracker } from './subscription-rate-limit';
import { UnauthorizedException } from '@nestjs/common';

describe('subscriptionRateLimitTracker', () => {
  const firstRateKey = 'A'.repeat(43);
  const secondRateKey = 'B'.repeat(43);
  const original = {
    SCALINGO_APPLICATION_ID: process.env.SCALINGO_APPLICATION_ID,
    VIGIEAU_PREPROD_AUTH_ENABLED: process.env.VIGIEAU_PREPROD_AUTH_ENABLED,
    APP: process.env.APP,
  };
  beforeEach(() => {
    delete process.env.VIGIEAU_PREPROD_AUTH_ENABLED;
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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

  it.each([undefined, '', 'false'])(
    'ignores spoofed gateway rate keys when preproduction auth is %p',
    (flag) => {
      if (flag !== undefined) process.env.VIGIEAU_PREPROD_AUTH_ENABLED = flag;
      process.env.APP = 'vigieau-api-preprod';
      process.env.SCALINGO_APPLICATION_ID = 'test-app';
      expect(
        subscriptionRateLimitTracker({
          ip: '10.0.0.1',
          headers: {
            'x-real-ip': '192.0.2.4',
            'x-vigieau-preprod-rate-key': firstRateKey,
          },
        }),
      ).toBe('192.0.2.4');
    },
  );

  describe('behind the preproduction authentication gateway', () => {
    beforeEach(() => {
      process.env.VIGIEAU_PREPROD_AUTH_ENABLED = 'true';
      process.env.APP = 'vigieau-api-preprod';
      process.env.SCALINGO_APPLICATION_ID = 'test-app';
    });

    it('keeps a signed session rate key stable across relay IPs and subscription emails', () => {
      const first = subscriptionRateLimitTracker({
        ip: '10.0.0.1',
        headers: {
          'x-real-ip': '192.0.2.4',
          'x-vigieau-preprod-rate-key': firstRateKey,
        },
        body: { email: 'first-subscription@example.com' },
      });
      const second = subscriptionRateLimitTracker({
        ip: '10.0.0.2',
        headers: {
          'x-real-ip': '192.0.2.5',
          'x-vigieau-preprod-rate-key': firstRateKey,
        },
        body: { email: 'other-subscription@example.com' },
      });
      expect(first).toBe(second);
      expect(first).toBe(`preprod-ip:${firstRateKey}`);
    });

    it('keeps distinct authenticated client IP keys separate behind the same relay', () => {
      const tracker = (rateKey: string) =>
        subscriptionRateLimitTracker({
          ip: '10.0.0.1',
          headers: {
            'x-real-ip': '192.0.2.4',
            'x-vigieau-preprod-rate-key': rateKey,
          },
        });
      expect(tracker(firstRateKey)).not.toBe(tracker(secondRateKey));
    });

    it.each([
      undefined,
      '',
      'invalid',
      'a'.repeat(42),
      'a'.repeat(44),
      `${firstRateKey}=`,
      `${firstRateKey}\n`,
      ` ${firstRateKey} `,
      `${firstRateKey},${secondRateKey}`,
      ['A'.repeat(43)],
      '*'.repeat(43),
    ])('refuses missing or malformed gateway rate keys: %p', (rateKey) => {
      expect(() =>
        subscriptionRateLimitTracker({
          ip: '10.0.0.1',
          headers: {
            'x-real-ip': '192.0.2.4',
            'x-vigieau-preprod-rate-key': rateKey,
            'x-forwarded-email': 'old-proxy-identity@example.com',
          },
          body: { email: 'valid-subscription@example.com' },
        }),
      ).toThrow(UnauthorizedException);
    });

    it('does not trust an alternate underscore header without the gateway header', () => {
      expect(() =>
        subscriptionRateLimitTracker({
          ip: '10.0.0.1',
          headers: { x_vigieau_preprod_rate_key: firstRateKey },
        }),
      ).toThrow(UnauthorizedException);
    });

    it('preserves the case of the opaque rate key', () => {
      const tracker = (rateKey: string) =>
        subscriptionRateLimitTracker({
          ip: '10.0.0.1',
          headers: { 'x-vigieau-preprod-rate-key': rateKey },
        });
      expect(tracker(firstRateKey)).not.toBe(
        tracker(firstRateKey.toLowerCase()),
      );
    });

    it('refuses trusting a rate key outside the exact preproduction app', () => {
      process.env.APP = 'vigieau-api';
      expect(() =>
        subscriptionRateLimitTracker({
          ip: '10.0.0.1',
          headers: { 'x-vigieau-preprod-rate-key': firstRateKey },
        }),
      ).toThrow('only supported on vigieau-api-preprod');
    });
  });
});
