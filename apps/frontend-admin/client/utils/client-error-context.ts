const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};

export const getClientErrorTags = (error: unknown, context: Record<string, unknown>): Record<string, string> => {
  const tags: Record<string, string> = {};
  const exception = record(error);
  const status = Number(exception.statusCode ?? exception.status ?? record(exception.response).status ?? record(exception.data).statusCode);
  if (Number.isInteger(status) && status >= 100 && status <= 599) {
    tags.http_status = String(status);
  }
  if (typeof context.action === 'string' && /^[a-z][\w-]{0,79}$/i.test(context.action)) {
    tags.action = context.action;
  }
  const entity = context.arreteType ?? context.entity;
  if (typeof entity === 'string' && ['arrete_restriction', 'arrete_cadre', 'arrete_municipal'].includes(entity)) {
    tags.arrete_type = entity;
  }
  if (typeof context.departement === 'string' && /^(?:\d{2,3}|2[AB])$/.test(context.departement)) {
    tags.departement = context.departement;
  }
  return tags;
};

export const createClientErrorDeduplicator = () => {
  const captured = new WeakSet<object>();
  return {
    reserve(error: unknown): boolean {
      if (!error || typeof error !== 'object') {
        return true;
      }
      if (captured.has(error)) {
        return false;
      }
      captured.add(error);
      return true;
    },
    release(error: unknown) {
      if (error && typeof error === 'object') {
        captured.delete(error);
      }
    },
  };
};
