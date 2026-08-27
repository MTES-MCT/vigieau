import {
  HISTORIC_BACKFILL_ARTIFACT_ACL_ENV,
  HISTORIC_BACKFILL_DURING_CURRENT_CONCURRENCY_ENV,
  HISTORIC_BACKFILL_ENABLED_ENV,
  isHistoricBackfillEnabled,
  readHistoricBackfillArtifactAcl,
  readHistoricBackfillWorkerConfig,
} from './historic-backfill.config';

describe('historic backfill worker config', () => {
  it('is strictly disabled by default', () => {
    expect(isHistoricBackfillEnabled({})).toBe(false);
    expect(readHistoricBackfillWorkerConfig({})).toMatchObject({
      enabled: false,
      concurrency: 1,
      duringCurrentConcurrency: 0,
      leaseSeconds: 1_800,
      heartbeatMilliseconds: 30_000,
      maxAttempts: 5,
    });
  });

  it('accepts an explicit case-insensitive true flag', () => {
    expect(
      isHistoricBackfillEnabled({
        [HISTORIC_BACKFILL_ENABLED_ENV]: ' TRUE ',
      }),
    ).toBe(true);
  });

  it('fails closed on an unsupported flag', () => {
    expect(() =>
      isHistoricBackfillEnabled({
        [HISTORIC_BACKFILL_ENABLED_ENV]: 'yes',
      }),
    ).toThrow(`${HISTORIC_BACKFILL_ENABLED_ENV} must be either true or false`);
  });

  it('keeps historic artifacts public by default', () => {
    expect(readHistoricBackfillArtifactAcl({})).toBe('public-read');
  });

  it.each(['private', 'public-read'] as const)(
    'accepts the %s historic artifact ACL',
    (acl) => {
      expect(
        readHistoricBackfillArtifactAcl({
          [HISTORIC_BACKFILL_ARTIFACT_ACL_ENV]: ` ${acl} `,
        }),
      ).toBe(acl);
    },
  );

  it('fails closed on an unsupported historic artifact ACL', () => {
    expect(() =>
      readHistoricBackfillArtifactAcl({
        [HISTORIC_BACKFILL_ARTIFACT_ACL_ENV]: 'authenticated-read',
      }),
    ).toThrow(
      `${HISTORIC_BACKFILL_ARTIFACT_ACL_ENV} must be either private or public-read`,
    );
  });

  it('reads bounded pool, lease, retry and yield settings', () => {
    expect(
      readHistoricBackfillWorkerConfig({
        HISTORIC_BACKFILL_ENABLED: 'true',
        HISTORIC_BACKFILL_WORKER_CONCURRENCY: '8',
        HISTORIC_BACKFILL_DURING_CURRENT_CONCURRENCY: '3',
        DATABASE_POOL_MAX: '20',
        HISTORIC_BACKFILL_LEASE_SECONDS: '120',
        HISTORIC_BACKFILL_HEARTBEAT_MILLISECONDS: '10000',
        HISTORIC_BACKFILL_POLL_MILLISECONDS: '500',
        HISTORIC_BACKFILL_ERROR_POLL_MILLISECONDS: '2500',
        HISTORIC_BACKFILL_MAX_ATTEMPTS: '9',
        HISTORIC_BACKFILL_RETRY_BASE_SECONDS: '5',
        HISTORIC_BACKFILL_RETRY_MAX_SECONDS: '600',
        HISTORIC_BACKFILL_YIELD_DELAY_SECONDS: '2',
      }),
    ).toEqual({
      enabled: true,
      concurrency: 8,
      duringCurrentConcurrency: 3,
      leaseSeconds: 120,
      heartbeatMilliseconds: 10_000,
      pollMilliseconds: 500,
      errorPollMilliseconds: 2_500,
      maxAttempts: 9,
      retryBaseSeconds: 5,
      retryMaxSeconds: 600,
      yieldDelaySeconds: 2,
    });
  });

  it.each([
    {
      environment: {
        HISTORIC_BACKFILL_WORKER_CONCURRENCY: '33',
      },
      message: 'HISTORIC_BACKFILL_WORKER_CONCURRENCY',
    },
    {
      environment: {
        [HISTORIC_BACKFILL_DURING_CURRENT_CONCURRENCY_ENV]: '33',
      },
      message: HISTORIC_BACKFILL_DURING_CURRENT_CONCURRENCY_ENV,
    },
    {
      environment: {
        [HISTORIC_BACKFILL_DURING_CURRENT_CONCURRENCY_ENV]: '-1',
      },
      message: HISTORIC_BACKFILL_DURING_CURRENT_CONCURRENCY_ENV,
    },
    {
      environment: {
        HISTORIC_BACKFILL_LEASE_SECONDS: '30',
        HISTORIC_BACKFILL_HEARTBEAT_MILLISECONDS: '30000',
      },
      message: 'must be shorter than the lease',
    },
    {
      environment: {
        HISTORIC_BACKFILL_RETRY_BASE_SECONDS: '100',
        HISTORIC_BACKFILL_RETRY_MAX_SECONDS: '10',
      },
      message: 'must not exceed',
    },
    {
      environment: {
        HISTORIC_BACKFILL_WORKER_CONCURRENCY: '2',
        DATABASE_POOL_MAX: '3',
      },
      message: 'DATABASE_POOL_MAX must be at least 5',
    },
  ])('rejects unsafe worker settings', ({ environment, message }) => {
    expect(() => readHistoricBackfillWorkerConfig(environment)).toThrow(
      message,
    );
  });
});
