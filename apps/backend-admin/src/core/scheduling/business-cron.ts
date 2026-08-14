import { Cron, type CronOptions } from '@nestjs/schedule';
import type { CronJobParams } from 'cron';

export const BUSINESS_SCHEDULER_PROCESS_ENV = 'RUN_BUSINESS_SCHEDULED_JOBS';
export const DISABLE_SCHEDULED_JOBS_ENV = 'DISABLE_SCHEDULED_JOBS';

export function areScheduledJobsDisabled(): boolean {
  return (
    process.env[DISABLE_SCHEDULED_JOBS_ENV]?.trim().toLowerCase() === 'true'
  );
}

export function isBusinessSchedulerProcess(): boolean {
  return process.env[BUSINESS_SCHEDULER_PROCESS_ENV]?.trim() === 'true';
}

export function shouldRunWebScheduledJobs(): boolean {
  return !isBusinessSchedulerProcess() && !areScheduledJobsDisabled();
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
