import { useCustomFetch } from "~/composables/useCustomFetch";

export class BaseApi {
  resource: string;
  constructor(resource: string) {
    this.resource = resource;
  }

  list(queryParams?: string) {
    return useCustomFetch(`/${this.resource}${queryParams ? '?' + queryParams : ''}`, {
      method: 'GET',
      baseURL: '/api',
    });
  }

  create(payload: any) {
    payload = JSON.parse(JSON.stringify(payload));
    return useCustomFetch(`/${this.resource}`, {
      method: 'POST',
      baseURL: '/api',
      body: payload,
    });
  }

  get(id: string) {
    return useCustomFetch(`/${this.resource}/${id}`, {
      method: 'GET',
      baseURL: '/api',
    });
  }

  update(id: string, payload: any) {
    payload = JSON.parse(JSON.stringify(payload));
    return useCustomFetch(`/${this.resource}/${id}`, {
      method: 'PATCH',
      baseURL: '/api',
      body: payload,
    });
  }

  delete(id: string) {
    return useCustomFetch(`/${this.resource}/${id}`, {
      method: 'DELETE',
      baseURL: '/api',
    });
  }
}
