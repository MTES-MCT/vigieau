import { $fetch } from 'ofetch';
import { ref } from 'vue';
import { Address } from '../dto/address.dto';
import { Geo } from '../dto/geo.dto';
import { useZonePublicationStore } from '../store/zonePublication';
import { fetchAsRefResponse } from '../utils/fetch-response';
import {
  buildPublishedZonePath,
  getDepartmentsApiDate,
  shouldRefreshZonePublication,
} from '../utils/zone-publication';

const _adresseOptions: string = '&limit=10';

export interface ZonePublicationPin {
  publicationId: string | null;
}

const index = {
  searchAddresses(addressQuery: string, exactAddress = false): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    return useFetch(`/search/?q=${addressQuery}${_adresseOptions}${exactAddress ? '&type=housenumber' : ''}`, {
      method: 'GET',
      baseURL: runtimeConfig.public.apiAdresseUrl,
      parseResponse: _formatAddresses,
    });
  },

  searchAddressByLatlon(lon: string, lat: string): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    return useFetch(`/reverse?lon=${lon}&lat=${lat}`, {
      method: 'GET',
      baseURL: runtimeConfig.public.apiAdresseUrl,
    });
  },

  searchGeoByLatlon(lon: string, lat: string): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    return useFetch(`/communes?lon=${lon}&lat=${lat}`, {
      method: 'GET',
      baseURL: runtimeConfig.public.apiGeoUrl,
    });
  },

  async searchZonesByAdress(
    address: Address,
    publicationPin?: ZonePublicationPin,
  ): Promise<any> {
    const citycode = address.properties.citycode;
    const coordinates = address.geometry?.coordinates;
    const params = new URLSearchParams();
    if (['municipality'].includes(address.properties.type) && citycode) {
      params.set('commune', citycode);
    } else {
      if (coordinates?.length >= 2) {
        params.set('lon', String(coordinates[0]));
        params.set('lat', String(coordinates[1]));
      }
      if (citycode) {
        params.set('commune', citycode);
      }
    }
    return _searchZones('/zones', params, publicationPin);
  },

  async searchZonesByGeo(
    geo: Geo,
    publicationPin?: ZonePublicationPin,
  ): Promise<any> {
    return _searchZones(
      '/zones',
      new URLSearchParams({ commune: geo.code }),
      publicationPin,
    );
  },

  subscribeMail(form: any): Promise<any> {
    for (const key in form) {
      if (!form[key]) {
        delete form[key];
      }
    }
    const runtimeConfig = useRuntimeConfig();
    return useFetch(`/subscriptions`, {
      method: 'POST',
      baseURL: runtimeConfig.public.apiSecheresseUrl,
      body: form,
    });
  },

  getRefData(): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    return useFetch(`/data`, {
      method: 'GET',
      baseURL: runtimeConfig.public.apiSecheresseUrl,
    });
  },

  getDepartmentsData(date: string, area?: string): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    const apiDate = getDepartmentsApiDate(date);
    return useFetch(`/departements?date=${apiDate}&${area ? area : ''}`, {
      method: 'GET',
      baseURL: runtimeConfig.public.apiSecheresseUrl,
    });
  },

  getDataArea(dateDebut: string, dateFin: string, area?: string): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    return useFetch(`/data/area?dateDebut=${dateDebut}&dateFin=${dateFin}&${area ? area : ''}`, {
      method: 'GET',
      baseURL: runtimeConfig.public.apiSecheresseUrl,
    });
  },

  getDataDepartement(dateDebut: string, dateFin: string, area?: string): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    return useFetch(`/data/departement?dateDebut=${dateDebut}&dateFin=${dateFin}&${area ? area : ''}`, {
      method: 'GET',
      baseURL: runtimeConfig.public.apiSecheresseUrl,
    });
  },

  getDataDuree(): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    return useFetch(`/data/duree`, {
      method: 'GET',
      baseURL: runtimeConfig.public.apiSecheresseUrl,
    });
  },

  getDataCommune(codeInsee: string, dateDebut?: string, dateFin?: string): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    return useFetch(`/data/commune/${codeInsee}?${dateDebut ? 'dateDebut=' + dateDebut : ''}&${dateFin ? 'dateFin=' + dateFin : ''}`, {
      method: 'GET',
      baseURL: runtimeConfig.public.apiSecheresseUrl,
    });
  },

  getArretesRestrictions(date: string, area?: string): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    return useFetch(`/arretes_restrictions?date=${date}&${area ? area : ''}`, {
      method: 'GET',
      baseURL: runtimeConfig.public.apiSecheresseUrl,
    });
  },

  getUserSubscriptions(token: string): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    return useFetch(`/subscriptions`, {
      method: 'GET',
      baseURL: runtimeConfig.public.apiSecheresseUrl,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  },

  unsubscribe(id: string, token: string): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    return useFetch(`/subscriptions/${id}`, {
      method: 'DELETE',
      baseURL: runtimeConfig.public.apiSecheresseUrl,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  },

  unsubscribeAll(token: string): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    return useFetch(`/subscriptions/all`, {
      method: 'DELETE',
      baseURL: runtimeConfig.public.apiSecheresseUrl,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  },

  getStats(): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    return useFetch(`/statistics`, {
      method: 'GET',
      baseURL: runtimeConfig.public.apiSecheresseUrl,
    });
  },

  signalRestriction(usageId: number, feedbackComment: string): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    return useFetch(`/usage/feedback/${usageId}`, {
      method: 'POST',
      baseURL: runtimeConfig.public.apiSecheresseUrl,
      body: {
        feedback: feedbackComment,
      },
    });
  },

  async getZonesByDepartement(depCode: string): Promise<any> {
    return _searchZones(`/zones/departement/${depCode}`);
  },
};

const _searchZones = async (
  path: string,
  searchParams = new URLSearchParams(),
  publicationPin?: ZonePublicationPin,
): Promise<any> => {
  const apiSecheresseUrl = useRuntimeConfig().public.apiSecheresseUrl;
  const publicationStore = publicationPin
    ? null
    : useZonePublicationStore();
  let publicationId = publicationPin?.publicationId;
  if (publicationStore) {
    try {
      publicationId = (await publicationStore.loadPublication())?.id;
    } catch {
      return _manifestUnavailableResponse();
    }
  }
  let response = await _fetchZones(
    path,
    searchParams,
    apiSecheresseUrl,
    publicationId,
  );

  if (
    shouldRefreshZonePublication(
      _getErrorStatus(response),
      Boolean(publicationPin),
    ) &&
    publicationStore
  ) {
    try {
      publicationId = (await publicationStore.loadPublication(true))?.id;
    } catch {
      return _manifestUnavailableResponse();
    }
    response = await _fetchZones(
      path,
      searchParams,
      apiSecheresseUrl,
      publicationId,
    );
  }

  return response;
};

const _fetchZones = (
  path: string,
  searchParams: URLSearchParams,
  baseURL: string,
  publicationId?: string | null,
): Promise<any> => {
  return fetchAsRefResponse(() =>
    $fetch(buildPublishedZonePath(path, searchParams, publicationId), {
      method: 'GET',
      baseURL,
    }),
  );
};

const _getErrorStatus = (response: any): number | undefined =>
  response.error?.value?.statusCode ?? response.error?.value?.status;

const _manifestUnavailableResponse = () => ({
  data: ref(null),
  error: ref({
    statusCode: 503,
    statusMessage: 'Manifest des zones indisponible.',
  }),
});

const _formatAddresses = (response: string): Address[] => {
  const addresses = JSON.parse(response);
  addresses.features.map((a: Address) => {
    if (a.properties.type === 'municipality') {
      a.properties.label = `${a.properties.label}, ${a.properties.citycode >= '97' ? a.properties.citycode.slice(0, 3) : a.properties.citycode.slice(0, 2)}`;
    }
    return a;
  });
  return addresses;
};

export default index;
