import { ArreteRestrictionService } from './arrete_restriction.service';
import {
  getScheduledCivilDate,
  NATIONAL_COMPUTE_START_HOUR,
  shiftCivilDate,
} from '../core/scheduling/daily-job-schedule';

const BUSINESS_DATE = getScheduledCivilDate(
  new Date(),
  NATIONAL_COMPUTE_START_HOUR,
);
const YESTERDAY = shiftCivilDate(BUSINESS_DATE, -1);
const TWO_DAYS_AGO = shiftCivilDate(BUSINESS_DATE, -2);
const TOMORROW = shiftCivilDate(BUSINESS_DATE, 1);

interface RecomputeRequest {
  departementId: number;
  generation: string;
  targetPublicRevision?: string;
  scheduledFor?: string | null;
  pendingScheduledDates?: string[];
  currentPending?: boolean;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createHarness(
  requestBatches: RecomputeRequest[][],
  options: {
    lockAcquired?: boolean;
    sandreLockAcquired?: boolean;
    sandreUnlockError?: Error;
    unlockAllError?: Error;
    askCompute?: jest.Mock;
    generationAdvanced?: boolean | boolean[];
    postComputePublicRevision?: string;
    postComputePublicRevisions?: string[];
    publicRevision?: string;
    publicRevisions?: string[];
  } = {},
) {
  let generationAdvancedIndex = 0;
  let postComputePublicRevisionIndex = 0;
  let requestBatchIndex = 0;
  let publicRevisionIndex = 0;
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('pg_try_advisory_lock')) {
      if (sql.includes('sandre-zone-sync')) {
        return [{ locked: options.sandreLockAcquired ?? true }];
      }
      return [{ locked: options.lockAcquired ?? true }];
    }
    if (
      sql.includes('request."departementId", request."generation"') &&
      sql.includes('current_zone_recompute_request')
    ) {
      return (requestBatches[requestBatchIndex++] ?? []).map((request) => {
        const scheduledFor = request.scheduledFor ?? null;
        return {
          targetPublicRevision: '42',
          scheduledFor,
          pendingScheduledDates:
            request.pendingScheduledDates ??
            (scheduledFor === null ? [] : [scheduledFor]),
          currentPending: request.currentPending ?? scheduledFor === null,
          ...request,
        };
      });
    }
    if (
      sql.includes('SELECT "publicRevision"') &&
      sql.includes('zone_publication_source_state')
    ) {
      return [
        {
          publicRevision:
            options.publicRevisions?.[publicRevisionIndex++] ??
            options.publicRevision ??
            '42',
        },
      ];
    }
    if (sql.includes('AS "generationAdvanced"')) {
      const generationAdvanced = Array.isArray(options.generationAdvanced)
        ? options.generationAdvanced[generationAdvancedIndex++]
        : options.generationAdvanced;
      return [
        {
          publicRevision:
            options.postComputePublicRevisions?.[
              postComputePublicRevisionIndex++
            ] ??
            options.postComputePublicRevision ??
            options.publicRevision ??
            '42',
          generationAdvanced: generationAdvanced ?? false,
        },
      ];
    }
    if (sql.includes('pg_advisory_unlock_all')) {
      if (options.unlockAllError) {
        throw options.unlockAllError;
      }
      return [];
    }
    if (sql.includes('pg_advisory_unlock')) {
      if (sql.includes('sandre-zone-sync') && options.sandreUnlockError) {
        throw options.sandreUnlockError;
      }
      return [{ unlocked: true }];
    }
    if (
      sql.includes('DELETE FROM "current_zone_recompute_request"') ||
      sql.includes('UPDATE "current_zone_recompute_request"') ||
      sql.includes('INSERT INTO "zone_type_availability"')
    ) {
      return [];
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const queryRunner = {
    connect: jest.fn().mockResolvedValue(undefined),
    query,
    release: jest.fn().mockResolvedValue(undefined),
    releasePostgresConnection: jest.fn().mockResolvedValue(undefined),
  };
  const managerQuery = jest.fn();
  const repository = {
    manager: {
      query: managerQuery,
      connection: {
        createQueryRunner: jest.fn(() => queryRunner),
      },
    },
  };
  const askCompute = options.askCompute ?? jest.fn().mockResolvedValue({});
  const statisticDepartementService = {
    computeDepartementStatistics: jest.fn().mockResolvedValue(undefined),
  };
  const service = new ArreteRestrictionService(
    repository as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { askCompute } as any,
    statisticDepartementService as any,
    {} as any,
    {} as any,
    {} as any,
  );

  return {
    askCompute,
    managerQuery,
    query,
    queryRunner,
    service,
    statisticDepartementService,
  };
}

function matchingQuery(
  query: jest.Mock,
  fragment: string,
): [string, unknown[] | undefined] {
  const call = query.mock.calls.find(([sql]) => sql.includes(fragment));
  if (!call) {
    throw new Error(`Query containing ${fragment} was not executed`);
  }
  return call;
}

describe('ArreteRestrictionService current zone recompute queue', () => {
  const previousZonePublicationEnabled = process.env.ZONE_PUBLICATION_ENABLED;

  beforeEach(() => {
    process.env.ZONE_PUBLICATION_ENABLED = 'false';
    delete process.env.CURRENT_ZONE_RECOMPUTE_WORKER_ENABLED;
    delete process.env.CURRENT_ZONE_RECOMPUTE_WORKER_PROCESS;
    delete process.env.PUBLIC_SOURCE_REVISION_ENABLED;
  });

  afterAll(() => {
    if (previousZonePublicationEnabled === undefined) {
      delete process.env.ZONE_PUBLICATION_ENABLED;
    } else {
      process.env.ZONE_PUBLICATION_ENABLED = previousZonePublicationEnabled;
    }
  });

  it('coalesces sorted department ids and increments their generations transactionally', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ publicRevision: '42' }])
      .mockResolvedValueOnce(undefined);
    const harness = createHarness([]);

    await harness.service.enqueueCurrentZoneRecomputeWithManager(
      { query } as any,
      [7, 2, 7, 2],
    );

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][1]).toEqual([[2, 7], '42', 'LEGACY', null]);
    expect(query.mock.calls[1][0]).toContain(
      'ON CONFLICT ("departementId") DO UPDATE',
    );
    expect(query.mock.calls[1][0]).toContain(
      'ELSE "current_zone_recompute_request"."generation" + 1',
    );
    expect(query.mock.calls[1][0]).toContain('"pendingScheduledDates"');
    expect(query.mock.calls[1][0]).toContain('SELECT DISTINCT pending_date');
    expect(query.mock.calls[1][0]).toContain('OR EXCLUDED."currentPending"');
  });

  it('does not write an empty request', async () => {
    const query = jest.fn();
    const harness = createHarness([]);

    await harness.service.enqueueCurrentZoneRecomputeWithManager(
      { query } as any,
      [],
    );

    expect(query).not.toHaveBeenCalled();
  });

  it('keeps the last certification while queuing the exact replacement revision', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([[{ publicRevision: '43' }], 1])
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    const harness = createHarness([]);

    await expect(
      harness.service.recordPublicMutation(
        { query } as any,
        [7, 2, 7],
        'PUBLICATION AR',
      ),
    ).resolves.toBe('43');

    expect(query.mock.calls[0][0]).toContain('WHEN "legacyDualWrite" THEN 0');
    expect(query.mock.calls[0][0]).toContain('ELSE 1');
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[1][0]).toContain(
      '"historic_backfill_department_revision"',
    );
    expect(query.mock.calls[1][0]).toContain('"generation" + 1');
    expect(query.mock.calls[1][1]).toEqual([[2, 7], '43']);
    expect(query.mock.calls[2][0]).not.toContain('zone_type_availability');
    expect(query.mock.calls[2][1]).toEqual([
      [2, 7],
      '43',
      'PUBLICATION AR',
      null,
    ]);
  });

  it('creates confirmed_none only through an explicit revision-pinned certification', async () => {
    const query = jest.fn().mockResolvedValue([[{ departmentCode: '49' }], 1]);
    const harness = createHarness([]);
    const asOf = new Date('2026-08-19T12:00:00.000Z');

    await harness.service.certifyZoneTypeAvailability(
      { query } as any,
      49,
      'AEP',
      'confirmed_none',
      '43',
      'https://www.maine-et-loire.gouv.fr/',
      asOf,
    );

    expect(query.mock.calls[0][0]).toContain(
      'source."publicRevision" = $6::bigint',
    );
    expect(query.mock.calls[0][0]).toContain(
      'FROM "zone_alerte_computed" zone',
    );
    expect(query.mock.calls[0][0]).toContain(
      'FROM "current_zone_recompute_request" pending',
    );
    expect(query.mock.calls[0][1]).toEqual([
      49,
      'AEP',
      'confirmed_none',
      asOf,
      'https://www.maine-et-loire.gouv.fr/',
      '43',
    ]);
  });

  it('computes all requested departments and deletes only the generations it observed', async () => {
    const harness = createHarness([
      [
        { departementId: 2, generation: '4' },
        { departementId: 7, generation: '9' },
      ],
      [],
    ]);

    await expect(
      harness.service.processPendingCurrentZoneRecomputes(),
    ).resolves.toBe('processed');

    expect(harness.askCompute).toHaveBeenCalledWith([2, 7], false, false);
    expect(
      harness.query.mock.calls.some(([sql]) =>
        sql.includes('sandre-zone-sync'),
      ),
    ).toBe(false);
    expect(
      harness.statisticDepartementService.computeDepartementStatistics,
    ).toHaveBeenCalledTimes(1);
    const [availabilitySql, availabilityParameters] = matchingQuery(
      harness.query,
      'INSERT INTO "zone_type_availability"',
    );
    expect(availabilitySql).toContain(`zone."type" IN ('SOU', 'SUP', 'AEP')`);
    expect(availabilitySql).toContain('source."publicRevision" = $2::bigint');
    expect(availabilitySql).not.toContain(
      '"officialUrl" = EXCLUDED."officialUrl"',
    );
    expect(availabilityParameters).toEqual([[2, 7], '42']);
    const [deleteSql, deleteParameters] = matchingQuery(
      harness.query,
      'DELETE FROM "current_zone_recompute_request"',
    );
    expect(deleteSql).toContain(
      'request."generation" = completed."generation"',
    );
    expect(deleteParameters).toEqual([
      [2, 7],
      ['6', '11'],
    ]);
    expect(harness.queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed generation for retry and records the error on that generation only', async () => {
    const askCompute = jest.fn().mockRejectedValue(new Error('worker failed'));
    const harness = createHarness([[{ departementId: 7, generation: '12' }]], {
      askCompute,
    });

    await expect(
      harness.service.processPendingCurrentZoneRecomputes(),
    ).rejects.toThrow('worker failed');

    expect(
      harness.query.mock.calls.some(([sql]) =>
        sql.includes('DELETE FROM "current_zone_recompute_request"'),
      ),
    ).toBe(false);
    const [updateSql, updateParameters] = matchingQuery(
      harness.query,
      'UPDATE "current_zone_recompute_request"',
    );
    expect(updateSql).toContain(
      'request."generation" = attempted."generation"',
    );
    expect(updateParameters).toEqual([
      [7],
      'worker failed',
      ['12'],
      300,
      21600,
    ]);
    expect(harness.queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('keeps a superseded generation queued without raising a generic worker error', async () => {
    const askCompute = jest.fn().mockRejectedValue(new Error('state changed'));
    const harness = createHarness(
      [[{ departementId: 7, generation: '12' }], []],
      { askCompute, generationAdvanced: true },
    );

    await expect(
      harness.service.processPendingCurrentZoneRecomputes(),
    ).resolves.toBe('superseded');

    expect(
      harness.query.mock.calls.some(([sql]) =>
        sql.includes('"supersededCount" = "supersededCount" + 1'),
      ),
    ).toBe(true);
  });

  it('rebases an overdue request to the current public revision before processing it', async () => {
    process.env.PUBLIC_SOURCE_REVISION_ENABLED = 'true';
    const harness = createHarness(
      [
        [
          {
            departementId: 7,
            generation: '12',
            targetPublicRevision: '42',
          },
        ],
        [
          {
            departementId: 7,
            generation: '13',
            targetPublicRevision: '43',
          },
        ],
        [],
      ],
      { publicRevision: '43' },
    );

    await expect(
      harness.service.processPendingCurrentZoneRecomputes(),
    ).resolves.toBe('processed');

    const [rebaseSql, rebaseParameters] = matchingQuery(
      harness.query,
      'AS observed("departementId", "generation")',
    );
    expect(rebaseSql).toContain('"generation" = request."generation" + 1');
    expect(rebaseSql).toContain('"attemptCount" = 0');
    expect(rebaseSql).toContain('"supersededCount" = "supersededCount" + 1');
    expect(rebaseParameters).toEqual([[7], ['12'], '43']);
    expect(harness.askCompute).toHaveBeenCalledTimes(1);
    expect(harness.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO "zone_type_availability"'),
      [[7], '43'],
    );
    expect(harness.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM "current_zone_recompute_request"'),
      [[7], ['15']],
    );
  });

  it('keeps a successful compute queued when its public revision changes before certification', async () => {
    process.env.PUBLIC_SOURCE_REVISION_ENABLED = 'true';
    const harness = createHarness(
      [
        [
          {
            departementId: 7,
            generation: '12',
            targetPublicRevision: '42',
          },
        ],
        [
          {
            departementId: 7,
            generation: '12',
            targetPublicRevision: '42',
          },
        ],
        [
          {
            departementId: 7,
            generation: '13',
            targetPublicRevision: '43',
          },
        ],
      ],
      {
        postComputePublicRevision: '43',
        publicRevisions: ['42', '43', '43'],
      },
    );

    await expect(
      harness.service.processPendingCurrentZoneRecomputes(),
    ).resolves.toBe('processed');

    expect(harness.askCompute).toHaveBeenCalledTimes(2);
    const queryCalls = harness.query.mock.calls as unknown as Array<
      [string, unknown[] | undefined]
    >;
    const availabilityCalls = queryCalls.filter(([sql]) =>
      sql.includes('INSERT INTO "zone_type_availability"'),
    );
    expect(availabilityCalls).toHaveLength(1);
    expect(availabilityCalls[0][1]).toEqual([[7], '43']);
    const deleteCalls = queryCalls.filter(
      ([sql]) =>
        sql.includes('DELETE FROM "current_zone_recompute_request"') &&
        sql.includes('USING unnest'),
    );
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][1]).toEqual([[7], ['15']]);
  });

  it('rebases a rolling legacy request with revision zero once enabled', async () => {
    process.env.PUBLIC_SOURCE_REVISION_ENABLED = 'true';
    const harness = createHarness(
      [
        [
          {
            departementId: 7,
            generation: '1',
            targetPublicRevision: '0',
          },
        ],
        [
          {
            departementId: 7,
            generation: '2',
            targetPublicRevision: '43',
          },
        ],
        [],
      ],
      { publicRevision: '43' },
    );

    await expect(
      harness.service.processPendingCurrentZoneRecomputes(),
    ).resolves.toBe('processed');

    const [, rebaseParameters] = matchingQuery(
      harness.query,
      'AS observed("departementId", "generation")',
    );
    expect(rebaseParameters).toEqual([[7], ['1'], '43']);
    expect(harness.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO "zone_type_availability"'),
      [[7], '43'],
    );
  });

  it('defers consumption to the dedicated worker process', async () => {
    process.env.CURRENT_ZONE_RECOMPUTE_WORKER_ENABLED = 'true';
    delete process.env.CURRENT_ZONE_RECOMPUTE_WORKER_PROCESS;
    const harness = createHarness([[{ departementId: 7, generation: '1' }]]);

    await expect(
      harness.service.processPendingCurrentZoneRecomputes(),
    ).resolves.toBe('deferred');

    expect(harness.queryRunner.connect).not.toHaveBeenCalled();
  });

  it('processes a newer generation left behind by a concurrent request', async () => {
    const harness = createHarness([
      [{ departementId: 7, generation: '12' }],
      [{ departementId: 7, generation: '13' }],
      [],
    ]);

    await expect(
      harness.service.processPendingCurrentZoneRecomputes(),
    ).resolves.toBe('processed');

    expect(harness.askCompute).toHaveBeenCalledTimes(2);
    const deleteCalls = (
      harness.query.mock.calls as unknown as Array<
        [string, unknown[] | undefined]
      >
    ).filter(
      ([sql]) =>
        sql.includes('DELETE FROM "current_zone_recompute_request"') &&
        sql.includes('USING unnest'),
    );
    expect(deleteCalls.map(([, parameters]) => parameters)).toEqual([
      [[7], ['14']],
      [[7], ['15']],
    ]);
  });

  it('lets the process holding the advisory lock own the recompute', async () => {
    const harness = createHarness([], { lockAcquired: false });

    await expect(
      harness.service.processPendingCurrentZoneRecomputes(),
    ).resolves.toBe('busy');

    expect(harness.askCompute).not.toHaveBeenCalled();
    expect(
      harness.query.mock.calls.some(([sql]) =>
        sql.includes('pg_advisory_unlock'),
      ),
    ).toBe(false);
    expect(harness.queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('leaves a versioned queue untouched while Sandre owns the global lock', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    const harness = createHarness([[{ departementId: 7, generation: '1' }]], {
      sandreLockAcquired: false,
    });

    await expect(
      harness.service.processPendingCurrentZoneRecomputes(),
    ).resolves.toBe('busy');

    expect(harness.askCompute).not.toHaveBeenCalled();
    expect(
      harness.query.mock.calls.some(([sql]) =>
        sql.includes('current_zone_recompute_request'),
      ),
    ).toBe(false);
    expect(
      harness.query.mock.calls
        .map(([sql]) => sql)
        .filter((sql) => sql.includes('pg_advisory_unlock')),
    ).toEqual([expect.stringContaining("hashtext('current-zone-recompute')")]);
    expect(harness.queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('keeps the Sandre barrier through versioned certification and releases locks in reverse order', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    const harness = createHarness([
      [{ departementId: 7, generation: '1' }],
      [],
    ]);

    await expect(
      harness.service.processPendingCurrentZoneRecomputes(),
    ).resolves.toBe('processed');

    const sqlCalls = harness.query.mock.calls.map(([sql]) => sql as string);
    const currentLockIndex = sqlCalls.findIndex(
      (sql) =>
        sql.includes('pg_try_advisory_lock') &&
        sql.includes('current-zone-recompute'),
    );
    const sandreLockIndex = sqlCalls.findIndex(
      (sql) =>
        sql.includes('pg_try_advisory_lock') &&
        sql.includes('sandre-zone-sync'),
    );
    const queueReadIndex = sqlCalls.findIndex((sql) =>
      sql.includes('WITH due_context AS'),
    );
    const certificationIndex = sqlCalls.findIndex((sql) =>
      sql.includes('INSERT INTO "zone_type_availability"'),
    );
    const acknowledgementIndex = sqlCalls.findIndex(
      (sql) =>
        sql.includes('DELETE FROM "current_zone_recompute_request"') &&
        sql.includes('USING unnest'),
    );
    const sandreUnlockIndex = sqlCalls.findIndex(
      (sql) =>
        sql.includes('pg_advisory_unlock') && sql.includes('sandre-zone-sync'),
    );
    const currentUnlockIndex = sqlCalls.findIndex(
      (sql) =>
        sql.includes('pg_advisory_unlock') &&
        sql.includes('current-zone-recompute'),
    );
    expect(currentLockIndex).toBeGreaterThanOrEqual(0);
    expect(sandreLockIndex).toBeGreaterThanOrEqual(0);
    expect(queueReadIndex).toBeGreaterThanOrEqual(0);
    expect(certificationIndex).toBeGreaterThanOrEqual(0);
    expect(acknowledgementIndex).toBeGreaterThanOrEqual(0);
    expect(sandreUnlockIndex).toBeGreaterThanOrEqual(0);
    expect(currentUnlockIndex).toBeGreaterThanOrEqual(0);
    expect(currentLockIndex).toBeLessThan(sandreLockIndex);
    expect(sandreLockIndex).toBeLessThan(queueReadIndex);
    expect(certificationIndex).toBeLessThan(sandreUnlockIndex);
    expect(acknowledgementIndex).toBeLessThan(sandreUnlockIndex);
    expect(sandreUnlockIndex).toBeLessThan(currentUnlockIndex);
    expect(harness.queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('preserves a compute error while safely cleaning up both versioned locks', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    const harness = createHarness([[{ departementId: 7, generation: '1' }]], {
      askCompute: jest.fn().mockRejectedValue(new Error('worker failed')),
      sandreUnlockError: new Error('Sandre unlock failed'),
    });

    await expect(
      harness.service.processPendingCurrentZoneRecomputes(),
    ).rejects.toThrow('worker failed');

    const sqlCalls = harness.query.mock.calls.map(([sql]) => sql as string);
    const sandreUnlockIndex = sqlCalls.findIndex(
      (sql) =>
        sql.includes('pg_advisory_unlock') && sql.includes('sandre-zone-sync'),
    );
    const currentUnlockIndex = sqlCalls.findIndex(
      (sql) =>
        sql.includes('pg_advisory_unlock') &&
        sql.includes('current-zone-recompute'),
    );
    const unlockAllIndex = sqlCalls.findIndex((sql) =>
      sql.includes('pg_advisory_unlock_all'),
    );
    expect(sandreUnlockIndex).toBeGreaterThanOrEqual(0);
    expect(currentUnlockIndex).toBeGreaterThanOrEqual(0);
    expect(unlockAllIndex).toBeGreaterThanOrEqual(0);
    expect(sandreUnlockIndex).toBeLessThan(currentUnlockIndex);
    expect(currentUnlockIndex).toBeLessThan(unlockAllIndex);
    expect(harness.queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('destroys a locked PostgreSQL connection when unlock_all also fails', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    const unlockAllError = new Error('unlock all failed');
    const harness = createHarness([[{ departementId: 7, generation: '1' }]], {
      askCompute: jest.fn().mockRejectedValue(new Error('worker failed')),
      sandreUnlockError: new Error('Sandre unlock failed'),
      unlockAllError,
    });

    await expect(
      harness.service.processPendingCurrentZoneRecomputes(),
    ).rejects.toThrow('worker failed');

    expect(harness.queryRunner.releasePostgresConnection).toHaveBeenCalledWith(
      unlockAllError,
    );
    expect(harness.queryRunner.release).not.toHaveBeenCalled();
  });

  it('coalesces concurrent prompts in one process', async () => {
    const compute = createDeferred<Record<string, never>>();
    const askCompute = jest.fn(() => compute.promise);
    const harness = createHarness(
      [[{ departementId: 7, generation: '1' }], []],
      { askCompute },
    );

    const first = harness.service.processPendingCurrentZoneRecomputes();
    const second = harness.service.processPendingCurrentZoneRecomputes();
    await new Promise((resolve) => setImmediate(resolve));

    expect(askCompute).toHaveBeenCalledTimes(1);
    compute.resolve({});
    await Promise.all([first, second]);

    expect(askCompute).toHaveBeenCalledTimes(1);
    expect(
      harness.statisticDepartementService.computeDepartementStatistics,
    ).toHaveBeenCalledTimes(1);
  });

  it('distinguishes an empty queue from a processed queue', async () => {
    const harness = createHarness([[]]);

    await expect(
      harness.service.processPendingCurrentZoneRecomputes(),
    ).resolves.toBe('empty');

    expect(harness.askCompute).not.toHaveBeenCalled();
  });

  it('does not turn a stale caller date into a historical computation', async () => {
    const harness = createHarness([
      [{ departementId: 7, generation: '1' }],
      [],
    ]);

    await expect(
      harness.service.processPendingCurrentZoneRecomputes('2026-08-13'),
    ).resolves.toBe('processed');

    expect(harness.askCompute).toHaveBeenCalledWith([7], false, false);
  });

  it.each([
    ['before', '2026-08-19T23:30:00.000Z', '2026-08-19'],
    ['after', '2026-08-20T00:30:00.000Z', '2026-08-20'],
  ])(
    'uses the national business date %s the 02:00 Paris boundary',
    async (_position, now, expectedBusinessDate) => {
      jest.useFakeTimers().setSystemTime(new Date(now));
      try {
        const harness = createHarness([
          [
            {
              departementId: 79,
              generation: '1',
              scheduledFor: expectedBusinessDate,
              pendingScheduledDates: [expectedBusinessDate],
              currentPending: false,
            },
          ],
          [],
        ]);

        await expect(
          harness.service.processPendingCurrentZoneRecomputes('2026-08-20'),
        ).resolves.toBe('processed');

        expect(harness.askCompute).toHaveBeenCalledWith(
          [79],
          false,
          false,
          false,
          undefined,
          expectedBusinessDate,
        );
        expect(harness.query).toHaveBeenCalledWith(
          expect.stringContaining('WITH due_context AS'),
          [expectedBusinessDate],
        );
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('coalesces a mature daily context and current mutation at the business date', async () => {
    const harness = createHarness([
      [
        {
          departementId: 2,
          generation: '1',
          scheduledFor: YESTERDAY,
        },
        {
          departementId: 7,
          generation: '1',
          scheduledFor: null,
        },
      ],
      [],
    ]);

    await expect(
      harness.service.processPendingCurrentZoneRecomputes(),
    ).resolves.toBe('processed');

    expect(harness.askCompute.mock.calls).toEqual([
      [[2, 7], false, false, false, undefined, BUSINESS_DATE],
    ]);
    const queryCalls = harness.query.mock.calls as unknown as Array<
      [string, unknown[] | undefined]
    >;
    const acknowledgeCall = queryCalls.find(([sql]) =>
      sql.includes('WHERE pending_date > $3::date'),
    );
    expect(acknowledgeCall?.[1]).toEqual([[2, 7], ['1', '1'], BUSINESS_DATE]);
    const availabilityCalls = queryCalls.filter(([sql]) =>
      sql.includes('INSERT INTO "zone_type_availability"'),
    );
    expect(availabilityCalls).toHaveLength(1);
    expect(availabilityCalls[0][1]).toEqual([[2, 7], '42']);
  });

  it('supersedes an old daily retry without losing the mutation on the same department', async () => {
    const harness = createHarness([
      [
        {
          departementId: 49,
          generation: '12',
          targetPublicRevision: '43',
          scheduledFor: YESTERDAY,
          currentPending: true,
        },
      ],
      [],
    ]);

    await expect(
      harness.service.processPendingCurrentZoneRecomputes('2026-08-19'),
    ).resolves.toBe('processed');

    expect(harness.askCompute.mock.calls).toEqual([
      [[49], false, false, false, undefined, BUSINESS_DATE],
    ]);
    expect(harness.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE pending_date > $3::date'),
      [[49], ['12'], BUSINESS_DATE],
    );
    expect(harness.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM "current_zone_recompute_request"'),
      [[49], ['14']],
    );
  });

  it('supersedes overdue dates into one current business-date snapshot', async () => {
    const harness = createHarness([
      [
        {
          departementId: 79,
          generation: '1',
          scheduledFor: TWO_DAYS_AGO,
          pendingScheduledDates: [TWO_DAYS_AGO, YESTERDAY],
          currentPending: false,
        },
      ],
      [],
    ]);

    await expect(
      harness.service.processPendingCurrentZoneRecomputes('2026-08-19'),
    ).resolves.toBe('processed');

    expect(harness.askCompute.mock.calls).toEqual([
      [[79], false, false, false, undefined, BUSINESS_DATE],
    ]);
    expect(harness.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE pending_date > $3::date'),
      [[79], ['1'], BUSINESS_DATE],
    );
    expect(
      harness.query.mock.calls.filter(([sql]) =>
        sql.includes('INSERT INTO "zone_type_availability"'),
      ),
    ).toHaveLength(1);
  });

  it('acknowledges all 101 mature national rows despite their backoff', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    const departementIds = Array.from({ length: 101 }, (_, index) => index + 1);
    const harness = createHarness([
      departementIds.map((departementId) => ({
        departementId,
        generation: '1',
        scheduledFor: TWO_DAYS_AGO,
        pendingScheduledDates: [TWO_DAYS_AGO, YESTERDAY],
        currentPending: departementId === 101,
      })),
      [],
    ]);

    await expect(
      harness.service.processPendingCurrentZoneRecomputes(),
    ).resolves.toBe('processed');

    expect(harness.askCompute.mock.calls).toEqual([
      [[], false, false, false, undefined, BUSINESS_DATE],
    ]);
    const queryCalls = harness.query.mock.calls as unknown as Array<
      [string, unknown[] | undefined]
    >;
    const selectCall = queryCalls.find(([sql]) =>
      sql.includes('WITH due_context AS'),
    );
    expect(selectCall?.[1]).toEqual([BUSINESS_DATE]);
    expect(selectCall?.[0]).toContain(
      'request."currentPending"\n                OR EXISTS',
    );
    const acknowledgeCall = queryCalls.find(([sql]) =>
      sql.includes('WHERE pending_date > $3::date'),
    );
    expect(acknowledgeCall?.[1]).toEqual([
      departementIds,
      Array.from({ length: 101 }, () => '1'),
      BUSINESS_DATE,
    ]);
    const availabilityCalls = queryCalls.filter(([sql]) =>
      sql.includes('INSERT INTO "zone_type_availability"'),
    );
    expect(availabilityCalls).toHaveLength(1);
    expect(availabilityCalls[0][1]).toEqual([departementIds, '42']);
  });

  it('acknowledges all 101 current rows and preserves future dated work', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    const departementIds = Array.from({ length: 101 }, (_, index) => index + 1);
    const harness = createHarness([
      departementIds.map((departementId) => ({
        departementId,
        generation: '1',
        scheduledFor: departementId === 101 ? TOMORROW : null,
        pendingScheduledDates: departementId === 101 ? [TOMORROW] : [],
        currentPending: true,
      })),
      [],
    ]);

    await expect(
      harness.service.processPendingCurrentZoneRecomputes(),
    ).resolves.toBe('processed');

    expect(harness.askCompute.mock.calls).toEqual([[[], false, false]]);
    const queryCalls = harness.query.mock.calls as unknown as Array<
      [string, unknown[] | undefined]
    >;
    const acknowledgeCall = queryCalls.find(([sql]) =>
      sql.includes('WHERE pending_date > $3::date'),
    );
    expect(acknowledgeCall?.[1]).toEqual([
      departementIds,
      Array.from({ length: 101 }, () => '1'),
      BUSINESS_DATE,
    ]);
    const preserveFutureCall = queryCalls.find(([sql]) =>
      sql.includes('AND cardinality(request."pendingScheduledDates") > 0'),
    );
    expect(preserveFutureCall?.[1]).toEqual([[101], ['2']]);
    const deleteCall = queryCalls.find(([sql]) =>
      sql.includes('DELETE FROM "current_zone_recompute_request"'),
    );
    expect(deleteCall?.[1]).toEqual([
      departementIds.slice(0, 100),
      Array.from({ length: 100 }, () => '3'),
    ]);
    expect(queryCalls).toContainEqual([
      expect.stringContaining('INSERT INTO "zone_type_availability"'),
      [departementIds, '42'],
    ]);
  });

  it('does not transition or certify a dated generation superseded by a mutation', async () => {
    process.env.PUBLIC_SOURCE_REVISION_ENABLED = 'true';
    const harness = createHarness(
      [
        [
          {
            departementId: 79,
            generation: '12',
            targetPublicRevision: '42',
            scheduledFor: YESTERDAY,
            currentPending: true,
          },
        ],
        [
          {
            departementId: 79,
            generation: '13',
            targetPublicRevision: '43',
            scheduledFor: YESTERDAY,
            currentPending: true,
          },
        ],
        [],
      ],
      {
        generationAdvanced: [true, false, false],
        postComputePublicRevisions: ['43', '43', '43', '43'],
        publicRevisions: ['42', '43'],
      },
    );

    await expect(
      harness.service.processPendingCurrentZoneRecomputes(),
    ).resolves.toBe('processed');

    const queryCalls = harness.query.mock.calls as unknown as Array<
      [string, unknown[] | undefined]
    >;
    const acknowledgeCalls = queryCalls.filter(([sql]) =>
      sql.includes('WHERE pending_date > $3::date'),
    );
    expect(acknowledgeCalls).toHaveLength(1);
    expect(acknowledgeCalls[0][1]).toEqual([[79], ['13'], BUSINESS_DATE]);
    const availabilityCalls = queryCalls.filter(([sql]) =>
      sql.includes('INSERT INTO "zone_type_availability"'),
    );
    expect(availabilityCalls).toHaveLength(1);
    expect(availabilityCalls[0][1]).toEqual([[79], '43']);
    expect(harness.query).toHaveBeenCalledWith(
      expect.stringContaining('LEFT JOIN "current_zone_recompute_request"'),
      [[79], ['12']],
    );
  });

  it('accepts a fully published legacy daily postcondition', async () => {
    const harness = createHarness([]);
    harness.managerQuery.mockResolvedValue([
      {
        snapshotStatus: 'completed',
        expectedCommuneCount: 34943,
        processedCommuneCount: 34943,
        snapshotSourceRevision: '42',
        currentSourceRevision: '42',
        currentPublishedDate: '2026-08-14',
        communeCount: 34943,
        expectedDepartementCount: 101,
        departementRestrictionCount: 101,
        departementSituationCount: 101,
        departementSituationKeyCount: 101,
        pendingQueueCount: 0,
      },
    ]);

    await expect(
      harness.service.assertLegacyDailyComputationCompleted('2026-08-14'),
    ).resolves.toEqual({ sourceRevision: '42' });

    expect(harness.managerQuery).toHaveBeenCalledWith(
      expect.stringContaining('current_zone_recompute_request'),
      ['2026-08-14'],
    );
  });

  it('rejects a daily postcondition while a newer queue generation remains', async () => {
    const harness = createHarness([]);
    harness.managerQuery.mockResolvedValue([
      {
        snapshotStatus: 'completed',
        expectedCommuneCount: 34943,
        processedCommuneCount: 34943,
        snapshotSourceRevision: '42',
        currentSourceRevision: '42',
        currentPublishedDate: '2026-08-14',
        communeCount: 34943,
        expectedDepartementCount: 101,
        departementRestrictionCount: 101,
        departementSituationCount: 101,
        departementSituationKeyCount: 101,
        pendingQueueCount: 1,
      },
    ]);

    await expect(
      harness.service.assertLegacyDailyComputationCompleted('2026-08-14'),
    ).rejects.toThrow('queue=1');
  });

  it('accepts a ready versioned snapshot without requiring the active watermark', async () => {
    const harness = createHarness([]);
    harness.managerQuery.mockResolvedValue([
      {
        snapshotStatus: 'ready',
        expectedCommuneCount: 34943,
        processedCommuneCount: 34943,
        snapshotSourceRevision: '42',
        currentSourceRevision: '42',
        currentPublishedDate: '2026-08-13',
        communeCount: 34943,
        expectedDepartementCount: 101,
        departementRestrictionCount: 101,
        departementSituationCount: 101,
        departementSituationKeyCount: 101,
        pendingQueueCount: 0,
      },
    ]);

    await expect(
      harness.service.assertVersionedDailyComputationReady('2026-08-14', '42'),
    ).resolves.toBeUndefined();
  });

  it('requests a national recompute when versioned publication is enabled', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    const harness = createHarness([
      [
        {
          departementId: 7,
          generation: '1',
          scheduledFor: YESTERDAY,
        },
      ],
      [],
    ]);

    await expect(
      harness.service.processPendingCurrentZoneRecomputes(),
    ).resolves.toBe('processed');

    expect(harness.askCompute.mock.calls).toEqual([
      [[], false, false, false, undefined, BUSINESS_DATE],
    ]);
    expect(harness.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO "zone_type_availability"'),
      [[7], '42'],
    );
  });
});
