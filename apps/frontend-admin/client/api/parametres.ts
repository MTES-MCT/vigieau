import { BaseApi } from '~/api/base-api';
import { useCustomFetch } from "~/composables/useCustomFetch";

export class ParametresApi extends BaseApi {
  save(payload: any, depCode: string) {
    payload = JSON.parse(JSON.stringify(payload));
    return useCustomFetch(`/${this.resource}/${depCode}`, {
      method: 'POST',
      baseURL: '/api',
      body: payload,
    });
  };
}
