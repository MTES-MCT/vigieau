/**
 * Only the public preproduction API runs behind the authentication gateway.
 * Refuse a misplaced or mistyped flag before trusting its rate-limit header.
 */
export function isPreproductionAuthEnabled(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  const enabled = environment.VIGIEAU_PREPROD_AUTH_ENABLED;
  if (enabled === undefined || enabled === '' || enabled === 'false')
    return false;
  if (enabled !== 'true') {
    throw new Error('VIGIEAU_PREPROD_AUTH_ENABLED must be true or false');
  }
  if (environment.APP !== 'vigieau-api-preprod') {
    throw new Error(
      'Preproduction authentication is only supported on vigieau-api-preprod',
    );
  }
  return true;
}
