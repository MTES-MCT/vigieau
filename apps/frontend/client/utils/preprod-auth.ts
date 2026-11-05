import { ref } from 'vue';

export const preprodAuthenticationRequired = ref(false);

interface ApiConfig {
  apiSecheresseUrl: string;
  preprodAuthEnabled?: boolean;
}

/** The preproduction gateway uses a marker distinct from business JWT errors. */
export function isPreprodAuthenticationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const failure = error as {
    status?: number;
    statusCode?: number;
    data?: { error?: unknown; statusCode?: unknown; message?: unknown };
    response?: { status?: number; _data?: { error?: unknown; statusCode?: unknown; message?: unknown } };
  };
  const status = failure.statusCode ?? failure.status ?? failure.response?.status;
  const body = failure.data ?? failure.response?._data;
  return status === 401
    && body !== null
    && typeof body === 'object'
    && !Array.isArray(body)
    && Object.keys(body).length === 1
    && body.error === 'preprod_auth_required';
}

export function publicApiRequestOptions(config: ApiConfig) {
  return {
    baseURL: config.apiSecheresseUrl,
    ...(config.preprodAuthEnabled === true
      ? {
          onResponseError({ response }: {
            response: { status: number; _data?: unknown };
          }) {
            if (isPreprodAuthenticationError({ response })) {
              preprodAuthenticationRequired.value = true;
            }
          },
        }
      : {}),
  };
}

/** Keep the post-login destination on this origin, including its query/hash. */
export function preprodLoginUrl(returnPath: string): string {
  let safePath = '/';
  if (returnPath.startsWith('/')
    && !returnPath.startsWith('//')
    && !hasUnsafePathCharacters(returnPath)) {
    try {
      const origin = 'https://vigieau.incubateur.net';
      const url = new URL(returnPath, origin);
      // Avoid nested login redirects, as well as encoded slash/backslash bypasses.
      const decodedPath = decodeURIComponent(url.pathname);
      if (url.origin === origin
        && !decodedPath.startsWith('//')
        && !hasUnsafePathCharacters(decodedPath)
        && !/^\/_preprod(?:\/|$)/.test(decodedPath)) {
        safePath = `${url.pathname}${url.search}${url.hash}`;
      }
    } catch {
      // Malformed URL/encoding: return to the application home page.
    }
  }
  return `/_preprod/login?${new URLSearchParams({ rd: safePath })}`;
}

function hasUnsafePathCharacters(path: string): boolean {
  return [...path].some(character => character === '\\'
    || character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127);
}
