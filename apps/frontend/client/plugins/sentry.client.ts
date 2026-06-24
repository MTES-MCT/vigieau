import * as Sentry from '@sentry/vue';

type SentryInitOptions = Parameters<typeof Sentry.init>[0] & {
  enableLogs?: boolean;
  profilesSampleRate?: number;
};

const toTrimmedString = (value: unknown) => {
  if (value === undefined || value === null) {
    return '';
  }

  return String(value).trim();
};

const toNumber = (value: unknown, fallback: number): number => {
  const stringValue = toTrimmedString(value);
  if (!stringValue) {
    return fallback;
  }

  const parsed = Number(stringValue);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toBoolean = (value: unknown): boolean =>
  toTrimmedString(value).toLowerCase() === 'true';

export default defineNuxtPlugin((nuxtApp) => {
  const runtimeConfig = useRuntimeConfig();
  const sentryDsn = toTrimmedString(runtimeConfig.public.sentryDsn);

  if (!sentryDsn) {
    return;
  }

  const router = useRouter();
  const tracesSampleRate = toNumber(
    runtimeConfig.public.sentryTracesSampleRate,
    0.1,
  );
  const profilesSampleRate = toNumber(
    runtimeConfig.public.sentryProfilesSampleRate,
    0,
  );
  const integrations: any[] = [];

  const browserTracingIntegration = (Sentry as any).browserTracingIntegration;
  if (typeof browserTracingIntegration === 'function') {
    integrations.push(browserTracingIntegration({ router }));
  }

  const browserProfilingIntegration = (Sentry as any)
    .browserProfilingIntegration;
  if (
    profilesSampleRate > 0 &&
    typeof browserProfilingIntegration === 'function'
  ) {
    integrations.push(browserProfilingIntegration());
  }

  Sentry.init({
    app: nuxtApp.vueApp,
    dsn: sentryDsn,
    environment:
      toTrimmedString(runtimeConfig.public.sentryEnv) ||
      toTrimmedString(runtimeConfig.public.appEnv) ||
      'local',
    integrations,
    enableLogs: true,
    tracesSampleRate,
    profilesSampleRate,
    sendDefaultPii: toBoolean(runtimeConfig.public.sentrySendDefaultPii),
  } as SentryInitOptions);
});
