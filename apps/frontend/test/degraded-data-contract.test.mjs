import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  getStatisticStatusPresentation,
  isMissingStatisticStatusEndpoint,
  normalizeStatisticDataStatus,
  unavailableStatisticDataStatus,
} from '../client/utils/statistic-data-status.ts';
import {
  formatZoneAvailabilityDate,
  getZoneSituationState,
  isUnsupportedZoneV2Status,
  normalizeZoneSearchResponse,
} from '../client/utils/zone-availability.ts';

const makeZone = (overrides = {}) => ({
  id: 1,
  type: 'AEP',
  profil: 'particulier',
  nom: 'Zone test',
  departement: '49',
  niveauGravite: 'alerte',
  arrete: {},
  arreteMunicipalCheminFichier: '',
  usages: [],
  usagesHash: '',
  ...overrides,
});

test('mappe updating vers un mode dégradé qui conserve la date certifiée', () => {
  const status = normalizeStatisticDataStatus({
    status: 'updating',
    usable: true,
    fresh: false,
    currentFresh: false,
    latestDate: '2026-08-17',
    currentPublishedDate: '2026-08-19',
  });

  assert.equal(status?.status, 'degraded');
  assert.deepEqual(getStatisticStatusPresentation(status), {
    title: 'Mise à jour en cours',
    description:
      'Les dernières données certifiées disponibles datent du 17/08/2026. Elles restent consultables pendant la mise à jour.',
    type: 'info',
  });
});

test('n’affiche aucun bandeau lorsque les données courantes sont certifiées', () => {
  const status = normalizeStatisticDataStatus({
    status: 'ready',
    usable: true,
    fresh: true,
    currentFresh: true,
    latestDate: '2026-08-19',
    currentPublishedDate: '2026-08-19',
  });

  assert.equal(getStatisticStatusPresentation(status), null);
});

test('ne confond pas une reprise historique avec un retard des données courantes', () => {
  const status = normalizeStatisticDataStatus({
    status: 'degraded',
    usable: true,
    fresh: false,
    currentFresh: true,
    latestDate: '2026-08-19',
    currentPublishedDate: '2026-08-19',
  });

  assert.equal(getStatisticStatusPresentation(status), null);
});

test('masque uniquement le 404 de compatibilité et rend les autres pannes visibles', () => {
  assert.equal(isMissingStatisticStatusEndpoint({ statusCode: 404 }), true);
  assert.equal(
    isMissingStatisticStatusEndpoint({ response: { status: 404 } }),
    true,
  );
  assert.equal(isMissingStatisticStatusEndpoint({ statusCode: 500 }), false);
  assert.deepEqual(
    getStatisticStatusPresentation(unavailableStatisticDataStatus()),
    {
      title: 'Données temporairement indisponibles',
      description:
        'Les données certifiées ne peuvent pas être affichées pour le moment.',
      type: 'error',
    },
  );
});

test('rend une réponse legacy AEP vide indisponible plutôt que sans restriction', () => {
  const response = normalizeZoneSearchResponse(
    [
      makeZone({ id: null, type: 'AEP', niveauGravite: null }),
      makeZone({ id: 2, type: 'SUP' }),
    ],
    '49',
  );

  assert.equal(response.availability.AEP.status, 'unavailable');
  assert.equal(
    response.availability.AEP.officialUrl,
    'https://www.maine-et-loire.gouv.fr/Actions-de-l-Etat/Eau-et-Environnement/Eau-et-milieux-aquatiques/Les-restrictions-en-eau-liees-a-la-secheresse',
  );
  assert.equal(response.availability.SUP.status, 'available');
});

test('une réponse legacy vide reste indisponible pour tous les types', () => {
  const response = normalizeZoneSearchResponse([], '49');

  assert.equal(response.availability.AEP.status, 'unavailable');
  assert.equal(response.availability.SUP.status, 'unavailable');
  assert.equal(response.availability.SOU.status, 'unavailable');
});

test('respecte une absence AEP explicitement certifiée par zones v2', () => {
  const response = normalizeZoneSearchResponse(
    {
      zones: [makeZone({ id: null, type: 'AEP', niveauGravite: null })],
      availability: {
        AEP: {
          status: 'confirmed_none',
          asOf: '2026-08-19T12:00:00.000Z',
          sourceRevision: '42',
        },
      },
    },
    '79',
  );

  assert.equal(response.availability.AEP.status, 'confirmed_none');
  assert.equal(response.availability.AEP.asOf, '2026-08-19T12:00:00.000Z');
  assert.equal(response.availability.AEP.sourceRevision, '42');
});

test('conserve la dernière situation connue pendant une mise à jour', () => {
  const response = normalizeZoneSearchResponse(
    {
      zones: [makeZone({ id: 42, type: 'SUP' })],
      availability: {
        SUP: {
          status: 'available',
          freshness: 'updating',
          asOf: '2026-08-20T12:41:00.000Z',
          pendingSince: '2026-08-20T12:49:00.000Z',
        },
      },
    },
    '79',
  );

  assert.equal(response.availability.SUP.status, 'available');
  assert.equal(response.availability.SUP.freshness, 'updating');
  assert.equal(
    response.availability.SUP.pendingSince,
    '2026-08-20T12:49:00.000Z',
  );
  assert.equal(
    formatZoneAvailabilityDate(response.availability.SUP.asOf),
    '20 août 2026',
  );
});

test('refuse une date d’actualisation invalide', () => {
  assert.equal(formatZoneAvailabilityDate('date-invalide'), null);
});

test('ignore un lien non sécurisé et utilise le site officiel des Deux-Sèvres', () => {
  const response = normalizeZoneSearchResponse(
    {
      zones: [],
      availability: {
        AEP: {
          status: 'unavailable',
          officialUrl: 'javascript:alert(1)',
        },
      },
    },
    '79',
  );

  assert.equal(
    response.availability.AEP.officialUrl,
    'https://www.deux-sevres.gouv.fr/Publications/Annonces-et-avis/Arretes-de-restriction-d-eau-prelevee-a-partir-du-reseau-d-eau-potable',
  );
});

test('un arrêté municipal ne devient jamais une absence de restriction', () => {
  const municipalZone = makeZone({
    id: null,
    niveauGravite: null,
    arreteMunicipalCheminFichier: 'https://example.test/arrete-municipal.pdf',
  });

  assert.equal(
    getZoneSituationState(municipalZone, { status: 'confirmed_none' }),
    'municipal',
  );
  assert.equal(
    getZoneSituationState(municipalZone, { status: 'available' }),
    'municipal',
  );
});

test('une disponibilité incohérente sans zone échoue en état indisponible', () => {
  assert.equal(
    getZoneSituationState(undefined, { status: 'available' }),
    'unavailable',
  );
});

test('une invalidation certifiée prime sur une ancienne zone publique', () => {
  const staleZone = makeZone({ id: 42, type: 'AEP' });

  assert.equal(
    getZoneSituationState(staleZone, { status: 'unavailable' }),
    'unavailable',
  );
  assert.equal(
    getZoneSituationState(staleZone, { status: 'confirmed_none' }),
    'confirmed_none',
  );
  assert.equal(
    getZoneSituationState(staleZone, { status: 'available' }),
    'restricted',
  );
});

test('limite le fallback legacy aux statuts d’endpoint v2 non supporté', () => {
  for (const status of [400, 404, 405, 501]) {
    assert.equal(isUnsupportedZoneV2Status(status), true);
  }
  for (const status of [409, 410, 500, 503]) {
    assert.equal(isUnsupportedZoneV2Status(status), false);
  }
});

test('branche le contrat additif sans autoriser une absence AEP implicite', async () => {
  const apiSource = await readFile(
    new URL('../client/api/index.ts', import.meta.url),
    'utf8',
  );
  const headerSource = await readFile(
    new URL('../client/components/situation/Header.vue', import.meta.url),
    'utf8',
  );
  const mapSource = await readFile(
    new URL('../client/components/carte/Map.vue', import.meta.url),
    'utf8',
  );
  const legendSource = await readFile(
    new URL(
      '../client/components/mixins/NiveauGraviteLegende.vue',
      import.meta.url,
    ),
    'utf8',
  );
  const tableSource = await readFile(
    new URL('../client/components/carte/Table.vue', import.meta.url),
    'utf8',
  );
  const statisticStatusSource = await readFile(
    new URL(
      '../client/components/donnees/StatisticDataStatus.vue',
      import.meta.url,
    ),
    'utf8',
  );

  assert.match(apiSource, /getDataStatus\(\)/);
  assert.match(apiSource, /_getZoneV2Path/);
  assert.match(headerSource, /v-if="availabilityUnavailable"/);
  assert.match(headerSource, /Situation au/);
  assert.match(headerSource, /Mise à jour en cours/);
  assert.doesNotMatch(headerSource, /Lors de la dernière actualisation/);
  assert.match(
    headerSource,
    /v-if="situationState === 'restricted' \|\| availabilityConfirmedNone"/,
  );
  assert.match(headerSource, /v-else-if="municipalOnly"/);
  assert.match(
    headerSource,
    /v-else-if="availabilityConfirmedNone"[\s\S]*?pas concernée par des restrictions/,
  );
  assert.match(mapSource, /resolveCurrentRestrictionPopup\(/);
  assert.match(mapSource, /api\.searchZonesByAdress\(/);
  assert.ok(
    mapSource.indexOf("availability.status === 'unavailable'") <
      mapSource.indexOf('const restrictedZones'),
  );
  assert.match(
    mapSource,
    /const shouldResolveCurrentAvailability = showRestrictionsBtn\.value/,
  );
  assert.match(
    mapSource,
    /const initialProperties = shouldResolveCurrentAvailability \? \[\] : properties/,
  );
  assert.match(
    mapSource,
    /resolveCurrentRestrictionPopup\([\s\S]*?zonesSelected\.value = resolved\.properties/,
  );
  assert.match(legendSource, /Aucune restriction affichée/);
  assert.match(legendSource, /ne confirme pas à elle seule/);
  assert.doesNotMatch(tableSource, /label: 'Pas de restrictions'/);
  assert.match(statisticStatusSource, /if \(error\?\.value\)/);
  assert.match(statisticStatusSource, /unavailableStatisticDataStatus\(\)/);
});
