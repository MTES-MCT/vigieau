import { isPreproductionAuthEnabled } from './preproduction-auth';

describe('public API preproduction authentication configuration', () => {
  it.each([undefined, '', 'false'])(
    'keeps authentication disabled when the flag is %p',
    (flag) => {
      expect(
        isPreproductionAuthEnabled({
          VIGIEAU_PREPROD_AUTH_ENABLED: flag,
          APP: 'vigieau-api',
        }),
      ).toBe(false);
    },
  );

  it('enables trusted proxy identity only on the public preproduction API', () => {
    expect(
      isPreproductionAuthEnabled({
        VIGIEAU_PREPROD_AUTH_ENABLED: 'true',
        APP: 'vigieau-api-preprod',
      }),
    ).toBe(true);
  });

  it.each([undefined, 'vigieau-api', 'vigieau-api-preprod-copy'])(
    'refuses activation on an unexpected app: %p',
    (app) => {
      expect(() =>
        isPreproductionAuthEnabled({
          VIGIEAU_PREPROD_AUTH_ENABLED: 'true',
          APP: app,
        }),
      ).toThrow('only supported on vigieau-api-preprod');
    },
  );

  it.each(['TRUE', '1', ' true ', 'disabled'])(
    'refuses an ambiguous flag: %p',
    (flag) => {
      expect(() =>
        isPreproductionAuthEnabled({
          VIGIEAU_PREPROD_AUTH_ENABLED: flag,
          APP: 'vigieau-api-preprod',
        }),
      ).toThrow('must be true or false');
    },
  );
});
