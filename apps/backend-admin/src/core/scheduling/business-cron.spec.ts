import {
  areScheduledJobsDisabled,
  BusinessCron,
  BUSINESS_SCHEDULER_PROCESS_ENV,
  DISABLE_SCHEDULED_JOBS_ENV,
  isBusinessSchedulerProcess,
  shouldRunWebScheduledJobs,
} from './business-cron';

describe('business scheduling process role', () => {
  const previousRole = process.env[BUSINESS_SCHEDULER_PROCESS_ENV];
  const previousDisabled = process.env[DISABLE_SCHEDULED_JOBS_ENV];

  afterEach(() => {
    if (previousRole === undefined) {
      delete process.env[BUSINESS_SCHEDULER_PROCESS_ENV];
    } else {
      process.env[BUSINESS_SCHEDULER_PROCESS_ENV] = previousRole;
    }
    if (previousDisabled === undefined) {
      delete process.env[DISABLE_SCHEDULED_JOBS_ENV];
    } else {
      process.env[DISABLE_SCHEDULED_JOBS_ENV] = previousDisabled;
    }
  });

  it('keeps publication heartbeats on web by default', () => {
    delete process.env[BUSINESS_SCHEDULER_PROCESS_ENV];

    expect(isBusinessSchedulerProcess()).toBe(false);
    expect(shouldRunWebScheduledJobs()).toBe(true);
  });

  it('runs business jobs and disables web heartbeats on clock', () => {
    process.env[BUSINESS_SCHEDULER_PROCESS_ENV] = 'true';

    expect(isBusinessSchedulerProcess()).toBe(true);
    expect(shouldRunWebScheduledJobs()).toBe(false);
  });

  it('recognizes the global maintenance switch', () => {
    process.env[DISABLE_SCHEDULED_JOBS_ENV] = ' TRUE ';
    expect(areScheduledJobsDisabled()).toBe(true);
    expect(shouldRunWebScheduledJobs()).toBe(false);
    process.env[DISABLE_SCHEDULED_JOBS_ENV] = 'false';
    expect(areScheduledJobsDisabled()).toBe(false);
  });

  it('disables business cron registration while maintenance is enabled', () => {
    process.env[BUSINESS_SCHEDULER_PROCESS_ENV] = 'true';
    process.env[DISABLE_SCHEDULED_JOBS_ENV] = 'true';

    class ScheduledService {
      @BusinessCron('* * * * * *')
      run(): void {}
    }

    expect(
      Reflect.getMetadata(
        'SCHEDULE_CRON_OPTIONS',
        ScheduledService.prototype.run,
      ),
    ).toMatchObject({ disabled: true, waitForCompletion: true });
  });
});
