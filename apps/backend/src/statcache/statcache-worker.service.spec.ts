import { DataService } from '../data/data.service';
import { StatcacheWorkerService } from './statcache-worker.service';

describe('StatcacheWorkerService', () => {
  const originalRole = process.env.VIGIEAU_PROCESS_ROLE;
  const dataService = {
    reconcileStatisticCacheCandidate: jest.fn(),
  };

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllTimers();
    jest.useRealTimers();
    if (originalRole === undefined) {
      delete process.env.VIGIEAU_PROCESS_ROLE;
    } else {
      process.env.VIGIEAU_PROCESS_ROLE = originalRole;
    }
  });

  it('does not schedule itself in a web process', () => {
    process.env.VIGIEAU_PROCESS_ROLE = 'web';
    const worker = new StatcacheWorkerService(
      dataService as unknown as DataService,
    );
    const schedule = jest.spyOn(worker as any, 'schedule');

    worker.onModuleInit();

    expect(schedule).not.toHaveBeenCalled();
  });

  it('keeps one worker poll scheduled until shutdown', () => {
    jest.useFakeTimers();
    process.env.VIGIEAU_PROCESS_ROLE = 'statcache';
    const worker = new StatcacheWorkerService(
      dataService as unknown as DataService,
    );

    worker.onModuleInit();
    expect(jest.getTimerCount()).toBe(1);

    worker.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('coalesces overlapping executions', async () => {
    let resolve: (() => void) | undefined;
    dataService.reconcileStatisticCacheCandidate.mockReturnValue(
      new Promise((done) => {
        resolve = () => done({ outcome: 'up-to-date', reason: 'stable' });
      }),
    );
    const worker = new StatcacheWorkerService(
      dataService as unknown as DataService,
    );

    const first = worker.runOnce();
    const second = worker.runOnce();
    resolve?.();
    await Promise.all([first, second]);

    expect(dataService.reconcileStatisticCacheCandidate).toHaveBeenCalledTimes(
      1,
    );
  });
});
