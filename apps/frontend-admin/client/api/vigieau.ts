export class VigiEauApi {
  getZonesByCommune(codeCommune: string) {
    const runtimeConfig = useRuntimeConfig();

    let url = `/zones?commune=${codeCommune}`;
    return useFetch(url, {
      method: 'GET',
      baseURL: runtimeConfig.public.apiSecheresseUrl,
    });
  }
}