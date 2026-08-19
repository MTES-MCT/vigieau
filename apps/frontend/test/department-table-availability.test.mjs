import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getDepartmentAepSituation } from '../client/utils/department-availability.ts';

test('does not let a surface-water restriction mask unavailable AEP data', () => {
  const situation = getDepartmentAepSituation({
    code: '49',
    nom: 'Maine-et-Loire',
    niveauGraviteMax: 'crise',
    niveauGraviteSupMax: 'crise',
    niveauGraviteAepMax: null,
    availability: { AEP: { status: 'unavailable' } },
  });

  assert.deepEqual(situation, {
    status: 'unavailable',
    level: null,
    officialUrl:
      'https://www.maine-et-loire.gouv.fr/Actions-de-l-Etat/Eau-et-Environnement/Eau-et-milieux-aquatiques/Les-restrictions-en-eau-liees-a-la-secheresse',
  });
});

test('only maps confirmed_none to an explicit absence of AEP restrictions', () => {
  assert.equal(
    getDepartmentAepSituation({
      code: '79',
      nom: 'Deux-Sevres',
      niveauGraviteAepMax: null,
      availability: { AEP: { status: 'confirmed_none' } },
    }).status,
    'confirmed_none',
  );
  assert.equal(
    getDepartmentAepSituation({
      code: '79',
      nom: 'Deux-Sevres',
      niveauGraviteAepMax: null,
      availability: { AEP: { status: 'available' } },
    }).status,
    'unavailable',
  );
});

test('keeps a restricted legacy row usable but fails closed on an empty one', () => {
  assert.equal(
    getDepartmentAepSituation({
      code: '01',
      nom: 'Ain',
      niveauGraviteAepMax: 'alerte',
    }).status,
    'restricted',
  );
  assert.equal(
    getDepartmentAepSituation({
      code: '79',
      nom: 'Deux-Sevres',
      niveauGraviteAepMax: null,
    }).status,
    'unavailable',
  );
});

test('fails closed on a malformed additive contract and rejects unsafe URLs', () => {
  const situation = getDepartmentAepSituation({
    code: '01',
    nom: 'Ain',
    niveauGraviteAepMax: 'alerte',
    availability: {
      AEP: {
        status: 'broken',
        officialUrl: 'javascript:alert(1)',
      },
    },
  });

  assert.deepEqual(situation, {
    status: 'unavailable',
    level: null,
    officialUrl: null,
  });
  assert.equal(
    getDepartmentAepSituation({
      code: '01',
      nom: 'Ain',
      niveauGraviteAepMax: 'alerte',
      availability: {},
    }).status,
    'unavailable',
  );
});

test('wires the public table to AEP and renders the official fallback link', async () => {
  const [wrapper, tableSource] = await Promise.all([
    readFile(
      new URL('../client/components/carte/Wrapper.vue', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL('../client/components/carte/Table.vue', import.meta.url),
      'utf8',
    ),
  ]);

  assert.match(
    wrapper,
    /<CarteTable[\s\S]*?:publication-pin="displayedPublicationPin"[\s\S]*?type-eau="AEP"/,
  );
  assert.match(tableSource, /getDepartmentAepSituation\(department\)/);
  assert.match(tableSource, /situation\.status === 'confirmed_none'/);
  assert.match(tableSource, /Données indisponibles - consulter le site/);
  assert.match(tableSource, /component: 'a'/);
  assert.match(tableSource, /rel: 'noopener noreferrer'/);
  assert.match(tableSource, /getDepartmentCellText\(cell\)/);
});
