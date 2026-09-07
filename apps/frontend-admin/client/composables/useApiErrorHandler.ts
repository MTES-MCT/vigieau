import { useAlertStore } from '~/stores/alert';
import { createClientErrorDeduplicator, getClientErrorTags } from '~/utils/client-error-context';

const clientErrorDeduplicator = createClientErrorDeduplicator();

const normalizeMessages = (value: unknown): string[] => {
  if (value === undefined || value === null || value === '') {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(normalizeMessages);
  }

  if (typeof value === 'object') {
    return Object.values(value).flatMap(normalizeMessages);
  }

  return String(value)
    .split('\n')
    .map((message) => message.trim())
    .filter(Boolean);
};

export const getApiErrorMessage = (error: any, fallback = 'Une erreur est survenue lors de l’appel à l’API.') => {
  const messages = [error?.data?.message, error?.data?.error, error?.statusMessage, error?.message].flatMap(normalizeMessages);

  return [...new Set(messages)].filter(Boolean).join(', ') || fallback;
};

export const captureClientError = (error: unknown, context: Record<string, unknown> = {}) => {
  if (!import.meta.client || !clientErrorDeduplicator.reserve(error)) {
    return;
  }

  const exception = error instanceof Error ? error : new Error(getApiErrorMessage(error, 'Erreur applicative côté client.'));

  void import('@sentry/vue')
    .then((Sentry) => {
      Sentry.withScope((scope) => {
        scope.setTags(getClientErrorTags(error, context));
        Object.entries(context).forEach(([key, value]) => {
          scope.setExtra(key, value);
        });
        Sentry.captureException(exception);
      });
    })
    .catch(() => clientErrorDeduplicator.release(error));
};

export const useApiErrorHandler = () => {
  const alertStore = useAlertStore();

  const showError = (error: unknown, title: string, fallback?: string, context: Record<string, unknown> = {}) => {
    const description = getApiErrorMessage(error, fallback);

    alertStore.addAlert({
      title,
      description,
      type: 'error',
    });
    captureClientError(error, { ...context, title, description });
  };

  return {
    showError,
    captureClientError,
    getApiErrorMessage,
  };
};
