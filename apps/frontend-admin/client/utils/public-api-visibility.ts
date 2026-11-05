export type PublicApiVisibility = 'visible' | 'empty' | 'authentication-required' | 'forbidden' | 'unavailable';

// Only a successful array response can establish that no prefectural order applies.
export function getPublicApiVisibility(data: unknown, error: unknown): PublicApiVisibility {
  if (error) {
    const response = error as { statusCode?: number; status?: number; data?: unknown };
    const status = response.statusCode ?? response.status;
    if (status === 409) {
      return 'visible';
    }
    if (
      status === 401 &&
      response.data !== null &&
      typeof response.data === 'object' &&
      !Array.isArray(response.data) &&
      Object.keys(response.data).length === 1 &&
      'error' in response.data &&
      response.data.error === 'preprod_auth_required'
    ) {
      return 'authentication-required';
    }
    if (status === 403) {
      return 'forbidden';
    }
    return 'unavailable';
  }
  if (!Array.isArray(data)) {
    return 'unavailable';
  }
  return data.length > 0 ? 'visible' : 'empty';
}
