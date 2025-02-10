import { BaseApi } from '~/api/base-api';
import { useCustomFetch } from '~/composables/useCustomFetch';

export class ZoneAlerteApi extends BaseApi {
  importTmp = (departementCode: string, zoneType: string, file: any) => {
    let formData = new FormData();
    formData.append('file', file);

    return useCustomFetch(`/${this.resource}/${departementCode}/${zoneType}/check`, {
      method: 'POST',
      baseURL: '/api',
      body: formData,
    });
  };

  check = (departementCode: string, typeZone: any) => {
    return useCustomFetch(`/${this.resource}/${departementCode}/${typeZone}/check`, {
      method: 'GET',
      baseURL: '/api',
    });
  };

  getByArreteCadre = (acId: number) => {
    return useCustomFetch(`/${this.resource}/arrete-cadre/${acId}`, {
      method: 'GET',
      baseURL: '/api',
    }).then((res) => {
      const data: any = res.data.value;
      if (data && data.length > 0) {
        data.map((d: any) => {
          if (d.geom) {
            d.geom = JSON.parse(d.geom);
          }
          return d;
        });
      }
      return res;
    });
  };
}
