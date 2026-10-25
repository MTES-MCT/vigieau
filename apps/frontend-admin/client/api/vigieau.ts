import { useCustomFetch } from '~/composables/useCustomFetch';

export class VigiEauApi {
  getZonesByCommune(codeCommune: string) {
    const runtimeConfig = useRuntimeConfig();

    const url = `/zones?commune=${codeCommune}`;
    return useCustomFetch(url, {
      method: 'GET',
      baseURL: runtimeConfig.public.apiSecheresseUrl,
    }, 0, false);
  }
}
