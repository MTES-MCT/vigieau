import { BaseApiPagination } from '~/api/base-api-pagination';
import { useCustomFetch } from "~/composables/useCustomFetch";

export class ArreteCadreApi extends BaseApiPagination {
  publish = (id: string, payload: any) => {
    const formData = new FormData();
    formData.append('file', payload.file);
    formData.append('dateDebut', payload.dateDebut);
    if (payload.dateFin) {
      formData.append('dateFin', payload.dateFin);
    }

    return useCustomFetch(`/${this.resource}/${id}/publier`, {
      method: 'POST',
      baseURL: '/api',
      body: formData,
    });
  };

  repeal = (id: string, payload: any) => {
    payload = JSON.parse(JSON.stringify(payload));
    return useCustomFetch(`/${this.resource}/${id}/abroger`, {
      method: 'POST',
      baseURL: '/api',
      body: payload,
    });
  };
}
