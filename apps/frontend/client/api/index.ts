import { $fetch } from 'ofetch';
import { ref } from 'vue';
import { Address } from '../dto/address.dto';
import { Geo } from '../dto/geo.dto';
import type { DepartementSituation } from '../dto/departement.dto';
import type { ZoneSearchResponse } from '../dto/zone-availability.dto';
import { useZonePublicationStore } from '../store/zonePublication';
import { fetchAsRefResponse } from '../utils/fetch-response';
import { publicApiRequestOptions } from '../utils/preprod-auth';
import {
  buildPublishedZonePath,
  getDepartmentsApiDate,
  getHttpErrorStatus,
  shouldRefreshZonePublication,
} from '../utils/zone-publication';
import {
  getDepartmentCodeFromCommune,
  isUnsupportedZoneV2Status,
  normalizeZoneSearchResponse,
} from '../utils/zone-availability';

export interface ZonePublicationPin {
  publicationId: string | null;
}

const index = {
  searchAddresses(addressQuery: string, exactAddress = false): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    const params = new URLSearchParams({ q: addressQuery, limit: '10' });
    if (exactAddress) params.set('type', 'housenumber');
    return fetchAsRefResponse(() => $fetch(
      `/search/?${params.toString()}`,
      {
        method: 'GET',
        baseURL: runtimeConfig.public.apiAdresseUrl,
        parseResponse: _formatAddresses,
      },
    ));
  },

  searchAddressByLatlon(lon: string, lat: string): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    return fetchAsRefResponse(() => $fetch(`/reverse?lon=${lon}&lat=${lat}`, {
      method: 'GET',
      baseURL: runtimeConfig.public.apiAdresseUrl,
    }));
  },

  searchGeoByLatlon(lon: string, lat: string): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    return fetchAsRefResponse(() => $fetch(`/communes?lon=${lon}&lat=${lat}`, {
      method: 'GET',
      baseURL: runtimeConfig.public.apiGeoUrl,
    }));
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
    const body = Object.fromEntries(Object.entries(form).filter(
      ([, value]) => value !== null && value !== undefined && value !== '',
    ));
    const runtimeConfig = useRuntimeConfig();
    return fetchAsRefResponse(() => $fetch(`/subscriptions`, {
      method: 'POST',
      ...publicApiRequestOptions(runtimeConfig.public),
      body,
      retry: false,
    }));
  },

  getRefData(): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    return fetchAsRefResponse(() => $fetch(`/data`, {
      method: 'GET',
      ...publicApiRequestOptions(runtimeConfig.public),
    }));
  },

  getDepartmentsData(
    date: string,
    area?: string,
    publicationPin?: ZonePublicationPin | null,
  ): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    const apiDate = getDepartmentsApiDate(date);
    const params = new URLSearchParams(area || '');
    params.set('date', apiDate);
    if (publicationPin?.publicationId) {
      params.set('publicationId', publicationPin.publicationId);
    }
    return fetchAsRefResponse(() => $fetch<DepartementSituation[]>(
      `/departements?${params.toString()}`,
      {
        method: 'GET',
        ...publicApiRequestOptions(runtimeConfig.public),
      },
    ));
  },

  getDataArea(dateDebut: string, dateFin: string, area?: string, includeProvisional = false): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    const params = new URLSearchParams(area || '');
    params.set('dateDebut', dateDebut);
    params.set('dateFin', dateFin);
    if (includeProvisional) {
      params.set('includeProvisional', 'true');
    }
    return fetchAsRefResponse(() => $fetch(
      `/data/area?${params.toString()}`,
      {
        method: 'GET',
        ...publicApiRequestOptions(runtimeConfig.public),
      },
    ));
  },

  getDataDepartement(
    dateDebut: string,
    dateFin: string,
    area?: string,
    includeProvisional = false,
  ): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    const params = new URLSearchParams(area || '');
    params.set('dateDebut', dateDebut);
    params.set('dateFin', dateFin);
    if (includeProvisional) {
      params.set('includeProvisional', 'true');
    }
    return fetchAsRefResponse(() => $fetch(
      `/data/departement?${params.toString()}`,
      {
        method: 'GET',
        ...publicApiRequestOptions(runtimeConfig.public),
      },
    ));
  },

  getDataDuree(): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    return fetchAsRefResponse(() => $fetch(`/data/duree`, {
      method: 'GET',
      ...publicApiRequestOptions(runtimeConfig.public),
    }));
  },

  getDataStatus(): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    return fetchAsRefResponse(() => $fetch(`/data/status`, {
      method: 'GET',
      ...publicApiRequestOptions(runtimeConfig.public),
    }));
  },

  getDataCommune(
    codeInsee: string,
    dateDebut?: string,
    dateFin?: string,
    includeProvisional = false,
  ): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    const params = new URLSearchParams();
    if (dateDebut) params.set('dateDebut', dateDebut);
    if (dateFin) params.set('dateFin', dateFin);
    if (includeProvisional) params.set('includeProvisional', 'true');
    return fetchAsRefResponse(() => $fetch(
      `/data/commune/${codeInsee}?${params.toString()}`,
      {
        method: 'GET',
        ...publicApiRequestOptions(runtimeConfig.public),
      },
    ));
  },

  getArretesRestrictions(date: string, area?: string): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    return fetchAsRefResponse(() => $fetch(`/arretes_restrictions?date=${date}&${area ? area : ''}`, {
      method: 'GET',
      ...publicApiRequestOptions(runtimeConfig.public),
    }));
  },

  getUserSubscriptions(token: string): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    return fetchAsRefResponse(() => $fetch(`/subscriptions`, {
      method: 'GET',
      ...publicApiRequestOptions(runtimeConfig.public),
      retry: false,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }));
  },

  requestSubscriptionManagementLink(email: string): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    return fetchAsRefResponse(() => $fetch('/subscriptions/management-link', {
      method: 'POST',
      ...publicApiRequestOptions(runtimeConfig.public),
      body: { email },
      retry: false,
    }));
  },

  unsubscribe(id: string, token: string): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    return fetchAsRefResponse(() => $fetch(`/subscriptions/${id}`, {
      method: 'DELETE',
      ...publicApiRequestOptions(runtimeConfig.public),
      retry: false,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }));
  },

  unsubscribeAll(token: string): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    return fetchAsRefResponse(() => $fetch(`/subscriptions`, {
      method: 'DELETE',
      ...publicApiRequestOptions(runtimeConfig.public),
      retry: false,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }));
  },

  getStats(): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    return useFetch(`/statistics`, {
      method: 'GET',
      ...publicApiRequestOptions(runtimeConfig.public),
    });
  },

  signalRestriction(usageId: number, feedbackComment: string): Promise<any> {
    const runtimeConfig = useRuntimeConfig();
    return fetchAsRefResponse(() => $fetch(`/usage/feedback/${usageId}`, {
      method: 'POST',
      ...publicApiRequestOptions(runtimeConfig.public),
      retry: false,
      body: {
        feedback: feedbackComment,
      },
    }));
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
  const apiOptions = publicApiRequestOptions(useRuntimeConfig().public);
  const publicationStore = publicationPin ? null : useZonePublicationStore();
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
    apiOptions,
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
      apiOptions,
      publicationId,
    );
  }

  return response;
};

const _fetchZones = (
  path: string,
  searchParams: URLSearchParams,
  apiOptions: ReturnType<typeof publicApiRequestOptions>,
  publicationId?: string | null,
): Promise<any> => {
  const departmentCode = _getRequestedDepartmentCode(path, searchParams);
  return fetchAsRefResponse<ZoneSearchResponse>(async () => {
    try {
      const response = await $fetch(
        buildPublishedZonePath(
          _getZoneV2Path(path),
          searchParams,
          publicationId,
        ),
        { method: 'GET', ...apiOptions },
      );
      return normalizeZoneSearchResponse(response, departmentCode);
    } catch (error) {
      if (!isUnsupportedZoneV2Status(getHttpErrorStatus(error))) {
        throw error;
      }
      const legacyResponse = await $fetch(
        buildPublishedZonePath(path, searchParams, publicationId),
        { method: 'GET', ...apiOptions },
      );
      return normalizeZoneSearchResponse(legacyResponse, departmentCode);
    }
  });
};

const _getZoneV2Path = (path: string): string =>
  path === '/zones' ? '/zones/v2' : path.replace('/zones/', '/zones/v2/');

const _getRequestedDepartmentCode = (
  path: string,
  searchParams: URLSearchParams,
): string | null => {
  const departmentPath = /^\/zones\/departement\/([^/?]+)/.exec(path);
  if (departmentPath) {
    return decodeURIComponent(departmentPath[1]);
  }
  return getDepartmentCodeFromCommune(searchParams.get('commune'));
};

const _getErrorStatus = (response: any): number | undefined =>
  getHttpErrorStatus(response.error?.value);

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
