import { DataSource } from 'typeorm';
import {
  BUSINESS_SCHEDULER_PROCESS_ENV,
  DISABLE_SCHEDULED_JOBS_ENV,
} from '../core/scheduling/business-cron';
import { RegleauLogger } from '../logger/regleau.logger';
import { automaticallyAttestHistoryBySourceEquivalence } from '../scripts/automatic-history-equivalence';
import {
  HISTORY_RECOVERY_BOOTSTRAP_DELAY_MS,
  HISTORY_RECOVERY_RETRY_DELAY_MS,
  HistoryRecoverySchedulerService,
} from './history-recovery-scheduler.service';

jest.mock('../scripts/automatic-history-equivalence', () => ({
  automaticallyAttestHistoryBySourceEquivalence: jest.fn(),
}));

describe('HistoryRecoverySchedulerService', () => {
  const savedEnvironment = {
    business: process.env[BUSINESS_SCHEDULER_PROCESS_ENV],
    disabled: process.env[DISABLE_SCHEDULED_JOBS_ENV],
    replay: process.env.HISTORIC_MUTABLE_GEOMETRY_REPLAY_ENABLED,
  };
  const attest = jest.mocked(automaticallyAttestHistoryBySourceEquivalence);
  let log: jest.SpyInstance;
  let errorLog: jest.SpyInstance;
  let service: HistoryRecoverySchedulerService;
  let dataSource: DataSource;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    process.env[BUSINESS_SCHEDULER_PROCESS_ENV] = 'true';
    process.env[DISABLE_SCHEDULED_JOBS_ENV] = 'false';
    process.env.HISTORIC_MUTABLE_GEOMETRY_REPLAY_ENABLED = 'false';
    attest.mockReset().mockResolvedValue({ status: 'ALREADY_ATTESTED' });
    log = jest.spyOn(RegleauLogger.prototype, 'log').mockImplementation();
    errorLog = jest
      .spyOn(RegleauLogger.prototype, 'error')
      .mockImplementation();
    dataSource = {} as DataSource;
    service = new HistoryRecoverySchedulerService(dataSource);
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  afterAll(() => {
    for (const [key, value] of [
      [BUSINESS_SCHEDULER_PROCESS_ENV, savedEnvironment.business],
      [DISABLE_SCHEDULED_JOBS_ENV, savedEnvironment.disabled],
      ['HISTORIC_MUTABLE_GEOMETRY_REPLAY_ENABLED', savedEnvironment.replay],
    ]) {
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    }
  });

  it.each([undefined, 'false', 'TRUE'])(
    'does nothing on a non-clock process (%s)',
    async (value) => {
      if (value === undefined)
        delete process.env[BUSINESS_SCHEDULER_PROCESS_ENV];
      else process.env[BUSINESS_SCHEDULER_PROCESS_ENV] = value;
      service.onApplicationBootstrap();
      await service.recoverIfDue();
      await jest.advanceTimersByTimeAsync(HISTORY_RECOVERY_BOOTSTRAP_DELAY_MS);
      expect(attest).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('does nothing when scheduling is disabled, including direct calls', async () => {
    process.env[DISABLE_SCHEDULED_JOBS_ENV] = 'true';
    service.onApplicationBootstrap();
    await service.recoverIfDue();
    await jest.advanceTimersByTimeAsync(HISTORY_RECOVERY_BOOTSTRAP_DELAY_MS);
    expect(attest).not.toHaveBeenCalled();
  });

  it('delays bootstrap once and does not enable unsafe geometry replay', async () => {
    service.onApplicationBootstrap();
    service.onApplicationBootstrap();
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(
      HISTORY_RECOVERY_BOOTSTRAP_DELAY_MS - 1,
    );
    expect(attest).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(attest).toHaveBeenCalledTimes(1);
    expect(attest).toHaveBeenCalledWith(dataSource);
    expect(process.env.HISTORIC_MUTABLE_GEOMETRY_REPLAY_ENABLED).toBe('false');
  });

  it('rechecks process eligibility when the delayed bootstrap fires', async () => {
    service.onApplicationBootstrap();
    process.env[DISABLE_SCHEDULED_JOBS_ENV] = 'true';
    await jest.advanceTimersByTimeAsync(HISTORY_RECOVERY_BOOTSTRAP_DELAY_MS);
    expect(attest).not.toHaveBeenCalled();
  });

  it('cancels delayed bootstrap and future attempts on shutdown', async () => {
    service.onApplicationBootstrap();
    service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(HISTORY_RECOVERY_BOOTSTRAP_DELAY_MS);
    await service.recoverIfDue();
    expect(attest).not.toHaveBeenCalled();
  });

  it('never overlaps an ongoing recovery with another tick or bootstrap', async () => {
    let finish!: () => void;
    attest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ status: 'ALREADY_ATTESTED' });
        }),
    );
    const running = service.recoverIfDue();
    service.onApplicationBootstrap();
    await service.recoverIfDue();
    await jest.advanceTimersByTimeAsync(HISTORY_RECOVERY_BOOTSTRAP_DELAY_MS);
    expect(attest).toHaveBeenCalledTimes(1);
    finish();
    await running;
    await service.recoverIfDue();
    expect(attest).toHaveBeenCalledTimes(2);
  });

  it.each(['ALREADY_ATTESTED', 'NOT_APPLICABLE'] as const)(
    'does not report a new repair for %s',
    async (status) => {
      attest.mockResolvedValue({ status });
      await service.recoverIfDue();
      await service.recoverIfDue();
      expect(attest).toHaveBeenCalledTimes(2);
      expect(log).not.toHaveBeenCalled();
      expect(errorLog).not.toHaveBeenCalled();
    },
  );

  it('reports only a verified attestation as repaired', async () => {
    attest.mockResolvedValue({
      status: 'ATTESTED',
      attestationId: 'repair-attestation',
      revision: '844',
    });
    await service.recoverIfDue();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('HISTORY RECOVERY ATTESTED'),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('revision=844'));
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('defers on contention without reporting certification', async () => {
    attest.mockResolvedValue({ status: 'BUSY' });
    await service.recoverIfDue();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('HISTORY RECOVERY DEFERRED'),
    );
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('keeps changed sources provisional and retries after a bounded backoff', async () => {
    attest.mockRejectedValueOnce(new Error('Source inputs differ from anchor'));
    await expect(service.recoverIfDue()).resolves.toBeUndefined();
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('HISTORY RECOVERY NEEDS REVIEW'),
      'Source inputs differ from anchor',
    );
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('historical data remains provisional'),
      expect.any(String),
    );
    expect(log).not.toHaveBeenCalled();
    await service.recoverIfDue();
    await jest.advanceTimersByTimeAsync(HISTORY_RECOVERY_RETRY_DELAY_MS - 1);
    await service.recoverIfDue();
    expect(attest).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await service.recoverIfDue();
    expect(attest).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it('starts backoff when the failed inspection ends, not when it started', async () => {
    let fail!: () => void;
    attest.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = () => reject(new Error('Inspection timed out'));
        }),
    );
    const running = service.recoverIfDue();
    await jest.advanceTimersByTimeAsync(15 * 60_000);
    fail();
    await running;
    await jest.advanceTimersByTimeAsync(HISTORY_RECOVERY_RETRY_DELAY_MS - 1);
    await service.recoverIfDue();
    expect(attest).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await service.recoverIfDue();
    expect(attest).toHaveBeenCalledTimes(2);
  });
});
