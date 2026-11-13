export function isPreprodPublicApiBridgeEnabled(env: Record<string, string | undefined>) {
  if (![undefined, '', 'false', 'true'].includes(env.VIGIEAU_PREPROD_PUBLIC_API_BRIDGE)) {
    throw new Error('VIGIEAU_PREPROD_PUBLIC_API_BRIDGE must be true or false');
  }
  if (env.VIGIEAU_PREPROD_PUBLIC_API_BRIDGE !== 'true') {
    return false;
  }
  if (env.APP !== 'regleau-front-preprod') {
    throw new Error('VIGIEAU_PREPROD_PUBLIC_API_BRIDGE is only supported on regleau-front-preprod');
  }
  return true;
}
