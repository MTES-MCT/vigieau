import { useAddressStore } from '../store/address';
import { storeToRefs } from 'pinia';
import api from '../api';
import utils from '../utils';
import { parseSituationPoint } from '../utils/situation-link';

export default defineNuxtRouteMiddleware(async (to: any) => {
  const addressStore = useAddressStore();
  const { address, geo, profile, typeEau } = storeToRefs(addressStore);
  const profil = typeof to.query.profil === 'string' ? to.query.profil : profile.value;
  const eau = typeof to.query.typeEau === 'string' ? to.query.typeEau : typeEau.value;
  const point = parseSituationPoint(to.query);

  if (point.kind === 'invalid') {
    throw createError({
      statusCode: 400,
      statusMessage: 'Lien de situation invalide',
      fatal: true,
      data: { code: 'INVALID_SITUATION_COORDINATES' },
    });
  }

  if (point.kind === 'point') {
    const current = address.value;
    if (current?.properties.type === 'point'
      && current.geometry.coordinates[0] === point.address.geometry.coordinates[0]
      && current.geometry.coordinates[1] === point.address.geometry.coordinates[1]
      && current.properties.citycode === point.address.properties.citycode) {
      addressStore.setProfile(profil);
      addressStore.setTypeEau(eau);
      return true;
    }
    // An explicit location must never reuse a different location from the store.
    addressStore.resetAddress();
    await utils.searchZones(point.address, null, profil, eau, useRouter());
  } else {
    if (address.value || geo.value) return true;
    const addressString = typeof to.query.adresse === 'string' ? to.query.adresse : null;
    if (!addressString) return navigateTo({ path: '/', query: to.query });

    const { data } = await api.searchAddresses(addressString);
    const firstAddress = data.value?.features[0];
    if (!firstAddress) return navigateTo({ path: '/', query: to.query });
    await utils.searchZones(firstAddress, null, profil, eau, useRouter());
  }

  if (!address.value && !geo.value) {
    return navigateTo({ path: '/', query: to.query });
  }
});
