import * as path from 'path';
import * as dotenv from 'dotenv';
import * as Sentry from '@sentry/nestjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

[
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'apps/backend-admin/.env'),
].forEach((envFile) => {
  dotenv.config({ path: envFile, override: false });
});

const sentryDsn = process.env.SENTRY_DSN?.trim();
const toNumber = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toBoolean = (value: string | undefined): boolean =>
  value?.trim().toLowerCase() === 'true';

const tracesSampleRate = toNumber(process.env.SENTRY_TRACES_SAMPLE_RATE, 0.1);
const profilesSampleRate = toNumber(process.env.SENTRY_PROFILES_SAMPLE_RATE, 0);

if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment:
      process.env.SENTRY_ENV?.trim() || process.env.NODE_ENV || 'local',
    integrations:
      profilesSampleRate > 0 ? [nodeProfilingIntegration()] : undefined,
    enableLogs: true,
    tracesSampleRate,
    profilesSampleRate,
    sendDefaultPii: toBoolean(process.env.SENTRY_SEND_DEFAULT_PII),
  });
}
