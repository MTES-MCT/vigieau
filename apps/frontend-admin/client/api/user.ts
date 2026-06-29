import { BaseApi } from '~/api/base-api';
import { useCustomFetch } from '~/composables/useCustomFetch';

export class UserApi extends BaseApi {
  me = (showAlert = true) => {
    return useCustomFetch(
      `/${this.resource}/me`,
      {
        method: 'GET',
        baseURL: '/api',
      },
      10000,
      showAlert,
    );
  };
  listDev = () => {
    return useCustomFetch(`/${this.resource}/dev`, {
      method: 'GET',
      baseURL: '/api',
    });
  };

  checkRules = () => {
    return useCustomFetch(`/${this.resource}/check_rules`, {
      method: 'POST',
      baseURL: '/api',
    });
  };
}
