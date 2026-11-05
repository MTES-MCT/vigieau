import { useCustomFetch } from '~/composables/useCustomFetch';

export class VigiEauApi {
  getZonesByCommune(codeCommune: string) {
    const runtimeConfig = useRuntimeConfig();

    const url = `/zones?commune=${codeCommune}`;
    return useCustomFetch(
      url,
      {
        method: 'GET',
        baseURL: runtimeConfig.public.apiSecheresseUrl,
        ...(runtimeConfig.public.preprodPublicApiBridge ? { credentials: 'same-origin', retry: false } : {}),
      },
      runtimeConfig.public.preprodPublicApiBridge ? 10000 : 0,
      false,
    );
  }
}
