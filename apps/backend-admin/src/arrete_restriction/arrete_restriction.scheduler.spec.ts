import { ArreteRestrictionService } from './arrete_restriction.service';

jest.mock('moment', () => {
  const moment = () => ({
    format: () => '2026-08-01T00:00:00.000Z',
    isBefore: () => false,
    startOf() {
      return this;
    },
  });
  return { __esModule: true, default: moment };
});

const createDeferred = () => {
  let resolve: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve: resolve! };
};

const createService = (askCompute: jest.Mock) => {
  const repository = {
    find: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({ affected: 0 }),
  };
  const statisticDepartementService = {
    computeDepartementStatistics: jest.fn().mockResolvedValue(undefined),
  };
  const service = new ArreteRestrictionService(
    repository as never,
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
  return { service, statisticDepartementService };
};

describe('ArreteRestrictionService scheduled status update', () => {
  it('does not complete before the zone computation does', async () => {
    const computation = createDeferred();
    const askCompute = jest.fn().mockReturnValue(computation.promise);
    const { service } = createService(askCompute);
    let completed = false;

    const update = service
      .updateArreteRestrictionStatut([{ id: 65 }] as never, true)
      .then(() => {
        completed = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(askCompute).toHaveBeenCalledWith([65], false, true);
    expect(completed).toBe(false);

    computation.resolve();
    await update;
    expect(completed).toBe(true);
  });

  it('propagates a zone computation failure to the scheduled caller', async () => {
    const expectedError = new Error('zone computation failed');
    const askCompute = jest.fn().mockRejectedValue(expectedError);
    const { service } = createService(askCompute);

    await expect(service.updateArreteRestrictionStatut()).rejects.toBe(
      expectedError,
    );
  });
});
