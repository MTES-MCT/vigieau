import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  normalizeRestrictionUsageLabel,
  resolvePublicRestrictionUsages,
} from '../client/utils/restriction-conflicts.ts';

const makeUsage = (overrides = {}) => ({
  id: 1,
  thematique: 'Arroser',
  nom: "Arrosage d'un jardin - potager",
  description: 'Interdit de 8 h à 20 h',
  erreur: '',
  concerneParticulier: true,
  concerneEntreprise: false,
  concerneCollectivite: false,
  concerneExploitation: false,
  ...overrides,
});

test('canonicalise les variantes Unicode sans supprimer la ponctuation métier', () => {
  assert.equal(
    normalizeRestrictionUsageLabel(
      '  ARROSAGE\u00A0D’UN\u2003JARDIN – POTAGER  ',
    ),
    "arrosage d'un jardin - potager",
  );
  assert.notEqual(
    normalizeRestrictionUsageLabel('Arrosage: jardins'),
    normalizeRestrictionUsageLabel('Arrosage jardins'),
  );
  assert.equal(
    normalizeRestrictionUsageLabel('ACTIVITE\u0301S'),
    normalizeRestrictionUsageLabel('activités'),
  );
});

test('réduit les doublons équivalents à une seule carte', () => {
  const result = resolvePublicRestrictionUsages([
    makeUsage(),
    makeUsage({
      id: 2,
      thematique: 'ARROSER',
      nom: 'Arrosage d’un jardin – potager',
    }),
  ]);

  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(
    result.usages.map(({ id }) => id),
    [1],
  );
});

test('masque toutes les variantes contradictoires sans choisir une consigne', () => {
  const result = resolvePublicRestrictionUsages([
    makeUsage(),
    makeUsage({
      id: 2,
      nom: 'Arrosage d’un jardin – potager',
      description: 'Interdit de 0 h à 4 h et de 8 h à 20 h',
    }),
    makeUsage({ id: 3, nom: 'Lavage des véhicules' }),
  ]);

  assert.deepEqual(
    result.usages.map(({ id }) => id),
    [3],
  );
  assert.deepEqual(result.conflicts, [
    { nom: "Arrosage d'un jardin - potager", thematique: 'Arroser' },
  ]);
});

test('masque le conflit réel avec un article facultatif après y compris', () => {
  const result = resolvePublicRestrictionUsages([
    makeUsage({
      nom: 'Arrosage des jardins potagers (y compris les serres non-agricoles)',
    }),
    makeUsage({
      id: 2,
      nom: 'Arrosage des jardins potagers (y compris serres non-agricoles)',
      description: 'Interdit de 0 h à 4 h et de 8 h à 20 h',
    }),
  ]);

  assert.deepEqual(result.usages, []);
  assert.equal(result.conflicts.length, 1);
});

test('ne regroupe pas deux usages de thématiques ou libellés différents', () => {
  const result = resolvePublicRestrictionUsages([
    makeUsage(),
    makeUsage({ id: 2, thematique: 'Prélever' }),
    makeUsage({ id: 3, nom: 'Arrosage des espaces verts' }),
  ]);

  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(
    result.usages.map(({ id }) => id),
    [1, 2, 3],
  );
});

test('affiche une seule alerte officielle et aucun faux état sans restriction', async () => {
  const source = await readFile(
    new URL('../client/components/situation/Restrictions.vue', import.meta.url),
    'utf8',
  );

  assert.equal((source.match(/v-if="hasConflictingUsages"/g) ?? []).length, 1);
  assert.match(source, /:href="zone\.arrete\.cheminFichier"/);
  assert.match(
    source,
    /thematiqueTagsFiltered\.length === 0 && !hasConflictingUsages/,
  );
});
