import { ArreteRestrictionService } from './arrete_restriction.service';

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

function createService(askCompute: jest.Mock) {
  let queueRead = false;
  const queryRunner = {
    connect: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) {
        return [{ locked: true }];
      }
      if (sql.includes('SELECT "departementId", "generation"')) {
        if (queueRead) {
          return [];
        }
        queueRead = true;
        return [{ departementId: 65, generation: '1' }];
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
      throw new Error(`Unexpected queue query: ${sql}`);
    }),
  };
  const transactionRepository = {
    query: jest.fn().mockResolvedValue([]),
  };
  const transactionManager = {
    getRepository: jest.fn(() => transactionRepository),
    query: jest.fn(async (sql: string) => {
      if (sql.includes('SELECT id FROM departement')) {
        return [{ id: 65 }];
      }
      if (sql.includes('current_zone_recompute_request')) {
        return [];
      }
      throw new Error(`Unexpected transaction query: ${sql}`);
    }),
  };
  const rootRepository = {
    manager: {
      connection: {
        createQueryRunner: jest.fn(() => queryRunner),
      },
      transaction: jest.fn(
        async (_isolation: string, callback: (manager: any) => unknown) =>
          callback(transactionManager),
      ),
    },
  };
  const statisticDepartementService = {
    computeDepartementStatistics: jest.fn().mockResolvedValue(undefined),
  };
  const service = new ArreteRestrictionService(
    rootRepository as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    { askCompute } as never,
    statisticDepartementService as never,
    undefined as never,
    { setConfig: jest.fn() } as never,
    undefined as never,
  );
  return { service, statisticDepartementService, transactionManager };
}

describe('ArreteRestrictionService scheduled status update', () => {
  const previousPublicationEnabled = process.env.ZONE_PUBLICATION_ENABLED;

  afterEach(() => {
    if (previousPublicationEnabled === undefined) {
      delete process.env.ZONE_PUBLICATION_ENABLED;
    } else {
      process.env.ZONE_PUBLICATION_ENABLED = previousPublicationEnabled;
    }
  });

  it('persists legacy debt and waits for the queued computation', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'false';
    const computation = createDeferred();
    const askCompute = jest.fn().mockReturnValue(computation.promise);
    const { service, transactionManager } = createService(askCompute);
    let completed = false;

    const update = service.updateArreteRestrictionStatut().then(() => {
      completed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(
      transactionManager.query.mock.calls.some(([sql]) =>
        sql.includes('INSERT INTO "current_zone_recompute_request"'),
      ),
    ).toBe(true);
    expect(askCompute).toHaveBeenCalledWith([65], false, false);
    expect(completed).toBe(false);

    computation.resolve();
    await update;
    expect(completed).toBe(true);
  });

  it('propagates a legacy computation failure so the daily run can retry', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'false';
    const expectedError = new Error('zone computation failed');
    const { service } = createService(
      jest.fn().mockRejectedValue(expectedError),
    );

    await expect(service.updateArreteRestrictionStatut()).rejects.toBe(
      expectedError,
    );
  });

  it('keeps the production V2 direct call when versioned publication is enabled', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    const askCompute = jest.fn().mockResolvedValue({ publicationId: 'p1' });
    const { service, transactionManager, statisticDepartementService } =
      createService(askCompute);

    await expect(
      service.updateArreteRestrictionStatut([{ id: 65 }] as never, true),
    ).resolves.toEqual({ publicationId: 'p1' });

    expect(
      transactionManager.query.mock.calls.some(([sql]) =>
        sql.includes('INSERT INTO "current_zone_recompute_request"'),
      ),
    ).toBe(false);
    expect(
      statisticDepartementService.computeDepartementStatistics,
    ).toHaveBeenCalledTimes(1);
    expect(askCompute).toHaveBeenCalledWith([65], false, true);
  });
});
