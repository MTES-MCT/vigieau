import { BaseApiPagination } from '~/api/base-api-pagination';
import { useCustomFetch } from "~/composables/useCustomFetch";

export class ArreteMunicipalApi extends BaseApiPagination {
  
  create(payload: any) {
    const formData = new FormData();
    formData.append('file', payload.file);
    formData.append('communes', JSON.stringify(payload.communes));
    formData.append('dateDebut', payload.dateDebut);
    formData.append('dateFin', payload.dateFin);
    formData.append('userEmail', payload.userEmail);
    formData.append('userPhone', payload.userPhone);
    formData.append('userFirstName', payload.userFirstName);
    formData.append('userLastName', payload.userLastName);
    
    return useCustomFetch(`/${this.resource}`, {
      method: 'POST',
      baseURL: '/api',
      body: formData,
    });
  }

  update(id: string, payload: any) {
    const formData = new FormData();
    formData.append('file', payload.file);
    formData.append('communes', JSON.stringify(payload.communes));
    formData.append('dateDebut', payload.dateDebut);
    formData.append('dateFin', payload.dateFin);
    formData.append('userEmail', payload.userEmail);
    formData.append('userPhone', payload.userPhone);
    formData.append('userFirstName', payload.userFirstName);
    formData.append('userLastName', payload.userLastName);
    
    return useCustomFetch(`/${this.resource}/${id}`, {
      method: 'PATCH',
      baseURL: '/api',
      body: formData,
    });
  }
  
  publish = (id: string, payload: any) => {
    const formData = new FormData();
    formData.append('file', payload.file);
    formData.append('dateDebut', payload.dateDebut);
    if (payload.dateFin) {
      formData.append('dateFin', payload.dateFin);
    }
    if (payload.dateSignature) {
      formData.append('dateSignature', payload.dateSignature);
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
