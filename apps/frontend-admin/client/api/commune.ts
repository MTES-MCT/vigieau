import { BaseApi } from '~/api/base-api';
import { useCustomFetch } from '~/composables/useCustomFetch';

const communeGeomFetches = new Map<string, Promise<any>>();

export class CommuneApi extends BaseApi {
  listWithGeom(queryParams?: string) {
    const url = `/${this.resource}?withGeom=true${queryParams ? '&' + queryParams : ''}`;
    if (communeGeomFetches.has(url)) {
      return communeGeomFetches.get(url);
    }

    const fetchPromise = useCustomFetch(
      url,
      {
        method: 'GET',
        baseURL: '/api',
      },
      30000,
    )
      .then((res) => {
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
      })
      .finally(() => {
        communeGeomFetches.delete(url);
      });

    communeGeomFetches.set(url, fetchPromise);
    return fetchPromise;
  }
}
