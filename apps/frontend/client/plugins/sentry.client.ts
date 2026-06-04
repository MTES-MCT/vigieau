import * as Sentry from '@sentry/vue';

type SentryInitOptions = Parameters<typeof Sentry.init>[0] & {
  enableLogs?: boolean;
  profileSessionSampleRate?: number;
  profileLifecycle?: 'trace';
};

const toTrimmedString = (value: unknown) => {
  if (value === undefined || value === null) {
    return '';
  }

  return String(value).trim();
};

export default defineNuxtPlugin((nuxtApp) => {
  const runtimeConfig = useRuntimeConfig();
  const sentryDsn = toTrimmedString(runtimeConfig.public.sentryDsn);

  if (!sentryDsn) {
    return;
  }

  const router = useRouter();
  const integrations: any[] = [];

  const browserTracingIntegration = (Sentry as any).browserTracingIntegration;
  if (typeof browserTracingIntegration === 'function') {
    integrations.push(browserTracingIntegration({ router }));
  }

  const browserProfilingIntegration = (Sentry as any).browserProfilingIntegration;
  if (typeof browserProfilingIntegration === 'function') {
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
    tracesSampleRate: 1.0,
    profileSessionSampleRate: 1.0,
    profileLifecycle: 'trace',
    sendDefaultPii: true,
  } as SentryInitOptions);
});
