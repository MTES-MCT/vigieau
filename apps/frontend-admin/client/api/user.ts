import { BaseApi } from '~/api/base-api';
import { useCustomFetch } from "~/composables/useCustomFetch";

export class UserApi extends BaseApi {
  me = () => {
    return useCustomFetch(`/${this.resource}/me`, {
      method: 'GET',
      baseURL: '/api',
    });
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
  }
}
