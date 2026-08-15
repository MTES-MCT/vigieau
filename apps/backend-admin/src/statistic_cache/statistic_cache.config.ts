export function isStatisticCacheArtifactRequired(): boolean {
  const configured =
    process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED?.trim().toLowerCase() ||
    'false';
  if (configured !== 'true' && configured !== 'false') {
    throw new Error(
      `Unsupported STATISTIC_CACHE_ARTIFACT_REQUIRED: ${configured}`,
    );
  }
  return configured === 'true';
}

export function readStatisticCachePositiveInteger(
  name: string,
  fallback: number,
): number {
  const configured = process.env[name]?.trim();
  if (!configured) {
    return fallback;
  }
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
