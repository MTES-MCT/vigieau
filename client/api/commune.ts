import { BaseApi } from "~/api/base-api";
import { useCustomFetch } from "~/composables/useCustomFetch";

export class CommuneApi extends BaseApi {
  listWithGeom(queryParams?: string) {
    return useCustomFetch(`/${this.resource}?withGeom=true${queryParams ? '&' + queryParams : ''}`, {
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
  }
}