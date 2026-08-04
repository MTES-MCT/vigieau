import { ArreteRestrictionService } from './arrete_restriction.service';

interface RecomputeRequest {
  departementId: number;
  generation: string;
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
    askCompute?: jest.Mock;
  } = {},
) {
  let requestBatchIndex = 0;
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('pg_try_advisory_lock')) {
      return [{ locked: options.lockAcquired ?? true }];
    }
    if (
      sql.includes('SELECT "departementId", "generation"') &&
      sql.includes('current_zone_recompute_request')
    ) {
      return requestBatches[requestBatchIndex++] ?? [];
    }
    if (sql.includes('pg_advisory_unlock')) {
      return [{ pg_advisory_unlock: true }];
    }
    if (
      sql.includes('DELETE FROM "current_zone_recompute_request"') ||
      sql.includes('UPDATE "current_zone_recompute_request"')
    ) {
      return [];
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const queryRunner = {
    connect: jest.fn().mockResolvedValue(undefined),
    query,
    release: jest.fn().mockResolvedValue(undefined),
  };
  const repository = {
    manager: {
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
  });

  afterAll(() => {
    if (previousZonePublicationEnabled === undefined) {
      delete process.env.ZONE_PUBLICATION_ENABLED;
    } else {
      process.env.ZONE_PUBLICATION_ENABLED = previousZonePublicationEnabled;
    }
  });

  it('coalesces sorted department ids and increments their generations transactionally', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const harness = createHarness([]);

    await harness.service.enqueueCurrentZoneRecomputeWithManager(
      { query } as any,
      [7, 2, 7, 2],
    );

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual([[2, 7]]);
    expect(query.mock.calls[0][0]).toContain(
      'ON CONFLICT ("departementId") DO UPDATE',
    );
    expect(query.mock.calls[0][0]).toContain(
      '"generation" = "current_zone_recompute_request"."generation" + 1',
    );
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

  it('computes all requested departments and deletes only the generations it observed', async () => {
    const harness = createHarness([
      [
        { departementId: 2, generation: '4' },
        { departementId: 7, generation: '9' },
      ],
      [],
    ]);

    await harness.service.processPendingCurrentZoneRecomputes();

    expect(harness.askCompute).toHaveBeenCalledWith([2, 7], false, false);
    expect(
      harness.statisticDepartementService.computeDepartementStatistics,
    ).toHaveBeenCalledTimes(1);
    const [deleteSql, deleteParameters] = matchingQuery(
      harness.query,
      'DELETE FROM "current_zone_recompute_request"',
    );
    expect(deleteSql).toContain(
      'request."generation" = completed."generation"',
    );
    expect(deleteParameters).toEqual([
      [2, 7],
      ['4', '9'],
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
    expect(updateParameters).toEqual([[7], 'worker failed', ['12']]);
    expect(harness.queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('processes a newer generation left behind by a concurrent request', async () => {
    const harness = createHarness([
      [{ departementId: 7, generation: '12' }],
      [{ departementId: 7, generation: '13' }],
      [],
    ]);

    await harness.service.processPendingCurrentZoneRecomputes();

    expect(harness.askCompute).toHaveBeenCalledTimes(2);
    const deleteCalls = (
      harness.query.mock.calls as unknown as Array<
        [string, unknown[] | undefined]
      >
    ).filter(([sql]) =>
      sql.includes('DELETE FROM "current_zone_recompute_request"'),
    );
    expect(deleteCalls.map(([, parameters]) => parameters)).toEqual([
      [[7], ['12']],
      [[7], ['13']],
    ]);
  });

  it('lets the process holding the advisory lock own the recompute', async () => {
    const harness = createHarness([], { lockAcquired: false });

    await harness.service.processPendingCurrentZoneRecomputes();

    expect(harness.askCompute).not.toHaveBeenCalled();
    expect(
      harness.query.mock.calls.some(([sql]) =>
        sql.includes('pg_advisory_unlock'),
      ),
    ).toBe(false);
    expect(harness.queryRunner.release).toHaveBeenCalledTimes(1);
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

  it('requests a national recompute when versioned publication is enabled', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    const harness = createHarness([
      [{ departementId: 7, generation: '1' }],
      [],
    ]);

    await harness.service.processPendingCurrentZoneRecomputes();

    expect(harness.askCompute).toHaveBeenCalledWith([], false, false);
  });
});
