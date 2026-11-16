export const DATABASE_POOL_MAX_DEFAULT = 10;
export const DATABASE_POOL_MAX_LIMIT = 20;

export function createDatabasePoolOptions(poolMax?: string, nodeEnv?: string) {
  // pg-pool's connectionTimeoutMillis also limits waiting for a free client.
  // Geometry workers share this configuration and can legitimately queue for
  // longer than five seconds. Keep audit deadlines local to AuditService.
  return {
    max: parseDatabasePoolMax(poolMax),
    ...(nodeEnv !== 'local' ? { ssl: { rejectUnauthorized: false } } : {}),
  };
}

export function parseDatabasePoolMax(value?: string): number {
  if (value === undefined || value.trim() === '') {
    return DATABASE_POOL_MAX_DEFAULT;
  }
  const normalized = value.trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error('DATABASE_POOL_MAX must be a positive integer');
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed > DATABASE_POOL_MAX_LIMIT) {
    throw new Error(
      `DATABASE_POOL_MAX must be at most ${DATABASE_POOL_MAX_LIMIT}`,
    );
  }
  return parsed;
}
