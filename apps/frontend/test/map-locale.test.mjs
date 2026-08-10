import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  getFrenchMapLocale,
  MAPLIBRE_FRENCH_LOCALE,
} from '../client/utils/map-locale.ts';

const mapSource = await readFile(
  new URL('../client/components/carte/Map.vue', import.meta.url),
  'utf8',
);

test('localise les noms des contrôles cartographiques au clavier', () => {
  assert.equal(
    MAPLIBRE_FRENCH_LOCALE['NavigationControl.ZoomIn'],
    'Zoomer sur la carte',
  );
  assert.equal(
    MAPLIBRE_FRENCH_LOCALE['GeolocateControl.FindMyLocation'],
    'Afficher ma position',
  );
  assert.equal(
    MAPLIBRE_FRENCH_LOCALE['FullscreenControl.Enter'],
    'Afficher la carte en plein écran',
  );
});

test('permet de donner un nom précis à chaque carte', () => {
  const locale = getFrenchMapLocale(
    'Carte interactive des restrictions d’usage de l’eau',
  );

  assert.equal(
    locale['Map.Title'],
    'Carte interactive des restrictions d’usage de l’eau',
  );
  assert.equal(locale['NavigationControl.ZoomOut'], 'Dézoomer sur la carte');
});

test('relie les instructions et sélectionne le point central au clavier', () => {
  assert.match(
    mapSource,
    /canvas\.setAttribute\('aria-describedby', props\.accessibleDescriptionId\)/,
  );
  assert.match(mapSource, /\['Enter', ' ', 'Spacebar'\]\.includes\(event\.key\)/);
  assert.match(mapSource, /const coordinates = mapInstance\.getCenter\(\)/);
  assert.match(
    mapSource,
    /selectMapPoint\([\s\S]*?mapInstance\.project\(coordinates\),[\s\S]*?coordinates/,
  );
});
