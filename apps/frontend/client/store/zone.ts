import { defineStore } from 'pinia';
import type { Ref } from 'vue';
import type { Zone } from '../dto/zone.dto';
import type {
  ZoneAvailabilityByType,
  ZoneSearchResponse,
} from '../dto/zone-availability.dto';
import { normalizeZoneSearchResponse } from '../utils/zone-availability';

export const useZoneStore = defineStore('zoneStore', () => {
  const zones: Ref<Zone[] | null> = ref(null);
  const zone: Ref<Zone | null> = computed(() => zones.value ? zones.value[0] : null);
  const availability: Ref<ZoneAvailabilityByType | null> = ref(null);

  function setZones(value: Zone[] | ZoneSearchResponse): void {
    const response = normalizeZoneSearchResponse(value);
    zones.value = formatZones(response.zones);
    availability.value = response.availability;
  }

  function resetZones(): void {
    zones.value = null;
    availability.value = null;
  }

  function formatZones(zones: Zone[]): Zone[] {
    if (!zones || zones.length < 1) {
      return zones;
    }
    zones.forEach((zone) => {
      zone.usages = zone.usages?.sort((a, b) => a.nom.localeCompare(b.nom));
    });

    zones.sort((a, b) => utils.getRestrictionRank(b.niveauGravite) - utils.getRestrictionRank(a.niveauGravite));
    return zones;
  }

  return {
    setZones,
    resetZones,
    zones,
    zone,
    availability,
  };
});
