import { Cron, type CronOptions } from '@nestjs/schedule';
import type { CronJobParams } from 'cron';

export const BUSINESS_SCHEDULER_PROCESS_ENV = 'RUN_BUSINESS_SCHEDULED_JOBS';
export const DISABLE_SCHEDULED_JOBS_ENV = 'DISABLE_SCHEDULED_JOBS';
export const CURRENT_ZONE_RECOMPUTE_WORKER_ENABLED_ENV =
  'CURRENT_ZONE_RECOMPUTE_WORKER_ENABLED';
export const CURRENT_ZONE_RECOMPUTE_WORKER_PROCESS_ENV =
  'CURRENT_ZONE_RECOMPUTE_WORKER_PROCESS';

export function areScheduledJobsDisabled(): boolean {
  return (
    process.env[DISABLE_SCHEDULED_JOBS_ENV]?.trim().toLowerCase() === 'true'
  );
}

export function isBusinessSchedulerProcess(): boolean {
  return process.env[BUSINESS_SCHEDULER_PROCESS_ENV]?.trim() === 'true';
}

export function isCurrentZoneRecomputeWorkerEnabled(): boolean {
  return (
    process.env[
      CURRENT_ZONE_RECOMPUTE_WORKER_ENABLED_ENV
    ]?.trim().toLowerCase() === 'true'
  );
}

export function isCurrentZoneRecomputeWorkerProcess(): boolean {
  return (
    process.env[
      CURRENT_ZONE_RECOMPUTE_WORKER_PROCESS_ENV
    ]?.trim().toLowerCase() === 'true'
  );
}

export function shouldRunWebScheduledJobs(): boolean {
  return (
    !isBusinessSchedulerProcess() &&
    !isCurrentZoneRecomputeWorkerProcess() &&
    !areScheduledJobsDisabled()
  );
}

export function BusinessCron(
  cronTime: CronJobParams['cronTime'],
  options: CronOptions = {},
): MethodDecorator {
  return Cron(cronTime, {
    ...options,
    disabled:
      options.disabled === true ||
      !isBusinessSchedulerProcess() ||
      areScheduledJobsDisabled(),
    waitForCompletion: options.waitForCompletion ?? true,
  });
}

export function CurrentZoneRecomputeCron(
  cronTime: CronJobParams['cronTime'],
  options: CronOptions = {},
): MethodDecorator {
  const dedicatedWorkerEnabled = isCurrentZoneRecomputeWorkerEnabled();
  return Cron(cronTime, {
    ...options,
    disabled:
      options.disabled === true ||
      areScheduledJobsDisabled() ||
      (dedicatedWorkerEnabled
        ? !isCurrentZoneRecomputeWorkerProcess()
        : !isBusinessSchedulerProcess()),
    waitForCompletion: options.waitForCompletion ?? true,
  });
}
