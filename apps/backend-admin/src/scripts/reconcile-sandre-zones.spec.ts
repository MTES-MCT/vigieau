import {
  acquireHistoricalRecomputeLock,
  currentTargetFingerprint,
  fetchText,
  parseCliOptions,
} from './reconcile-sandre-zones';

describe('reconcile-sandre-zones CLI safeguards', () => {
  const originalEnvironment = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnvironment,
      DATABASE_HOST: 'db.example.test',
      DATABASE_PORT: '5432',
      DATABASE_NAME: 'vigieau-preprod',
      SCALINGO_APP: 'regleau-back-preprod',
      NODE_ENV: 'preprod',
    };
  });

  afterAll(() => {
    process.env = originalEnvironment;
  });

  it('uses dry-run by default', () => {
    expect(parseCliOptions(['--department', '65,31'])).toEqual({
      apply: false,
      departments: ['31', '65'],
      reportPath: null,
    });
  });

  it('rejects contradictory dry-run and apply flags', () => {
    expect(() =>
      parseCliOptions([
        '--dry-run',
        '--apply',
        '--report',
        '/tmp/approved.json',
      ]),
    ).toThrow('--apply and --dry-run are mutually exclusive');
  });

  it('binds reports to the non-secret database target', () => {
    const preprodFingerprint = currentTargetFingerprint();
    process.env.DATABASE_NAME = 'vigieau-prod';
    process.env.SCALINGO_APP = 'regleau-back-prod';

    expect(currentTargetFingerprint()).not.toBe(preprodFingerprint);
  });

  it('skips the historical lock when no historical recompute is needed', async () => {
    const executor = { query: jest.fn() };

    await expect(acquireHistoricalRecomputeLock(executor, null)).resolves.toBe(
      false,
    );
    expect(executor.query).not.toHaveBeenCalled();
  });

  it('acquires the historical session lock', async () => {
    const executor = {
      query: jest.fn().mockResolvedValue([{ locked: true }]),
    };

    await expect(
      acquireHistoricalRecomputeLock(executor, '2024-01-15'),
    ).resolves.toBe(true);
    expect(executor.query).toHaveBeenCalledWith(
      "SELECT pg_try_advisory_lock(hashtext('vigieau'), hashtext('zone-compute-historic')) AS locked",
    );
  });

  it('bounds the historical lock wait', async () => {
    const executor = {
      query: jest.fn().mockResolvedValue([{ locked: false }]),
    };

    await expect(
      acquireHistoricalRecomputeLock(executor, '2024-01-15', 0),
    ).rejects.toThrow('Timed out waiting for the historic zone compute lock');
    expect(executor.query).toHaveBeenCalledTimes(1);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses a supported language header for Sandre metadata', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue('<metadata />'),
    } as unknown as Response);

    await expect(
      fetchText('https://www.sandre.eaufrance.fr/metadata.xml'),
    ).resolves.toBe('<metadata />');
    expect(fetch).toHaveBeenCalledWith(
      'https://www.sandre.eaufrance.fr/metadata.xml',
      expect.objectContaining({
        headers: expect.objectContaining({
          'accept-language': 'fr',
        }),
      }),
    );
  });
});
