import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { findRestrictionUsageConflicts } from '../client/utils/restriction-usage-conflicts.ts';

const serverSource = await readFile(new URL('../../backend-admin/src/restriction/restriction.service.ts', import.meta.url), 'utf8');
const serverRules = serverSource.slice(serverSource.indexOf('const usageProfileFields'), serverSource.indexOf('@Injectable()'));
// eslint-disable-next-line no-new-func -- Execute only the checked-in pure rules to test parity without loading Nest dependencies.
const getServerConflicts = new Function(`${stripTypeScriptTypes(serverRules.replace('export const ', 'const '))}; return getConflictingUsageLabels;`)();

const usage = (overrides = {}) => ({
  nom: 'Usage local',
  thematique: { nom: 'Industrie' },
  concerneEntreprise: true,
  concerneEsu: true,
  descriptionVigilance: '',
  descriptionAlerte: '',
  descriptionAlerteRenforcee: '',
  descriptionCrise: 'Interdit',
  ...overrides,
});

const checkParity = (restrictions) => {
  const actual = findRestrictionUsageConflicts(restrictions);
  restrictions.forEach((restriction, restrictionIndex) => {
    assert.deepEqual(
      actual.filter((conflict) => conflict.restrictionIndex === restrictionIndex).map((conflict) => conflict.usageName),
      getServerConflicts(restriction.usages ?? []),
    );
  });
  return actual;
};

test('reports conflicting ICPE instructions in the Lot Bonnette zone', () => {
  const restrictions = [{
    zoneAlerte: { nom: 'La Bonnette' },
    usages: [
      usage({ nom: 'ICPE', descriptionAlerte: 'Reduction de 10 %' }),
      usage({ nom: 'ICPE', descriptionAlerte: 'Reduction de 20 %' }),
    ],
  }];
  assert.deepEqual(checkParity(restrictions), [{
    restrictionIndex: 0,
    usageIndices: [0, 1],
    usageName: 'ICPE',
    differingFields: ['descriptionAlerte'],
  }]);
});

test('matches apostrophe variants in Lot-et-Garonne hydroelectric instructions', () => {
  const first = usage({ nom: "Production d'energie hydroelectrique" });
  const second = usage({ nom: 'Production d\u2019energie hydroelectrique', descriptionCrise: 'Autorise' });
  assert.deepEqual(checkParity([{ usages: [first, second] }])[0]?.usageIndices, [0, 1]);
});

test('keeps fountain duplicates with identical multiline instructions valid', () => {
  const first = usage({ nom: 'Fontaines', descriptionCrise: 'Interdit\r\ny compris les fontaines' });
  const second = usage({ nom: 'Fontaines', descriptionCrise: '  INTERDIT y compris fontaines  ' });
  assert.deepEqual(checkParity([{ usages: [first, second] }]), []);
});

test('normalizes Unicode compatibility, apostrophes, dashes, spaces, case and y compris articles', () => {
  const first = usage({
    nom: '\uFF29\uFF23\uFF30\uFF25',
    thematique: { nom: ' INDUSTRIE\u00A0' },
    descriptionCrise: "Reduction - de l'eau y compris le lavage",
  });
  for (const apostrophe of ['\u2018', '\u2019', '\u02BC', '\uFF07']) {
    for (const dash of ['\u2010', '\u2011', '\u2012', '\u2013', '\u2014', '\u2015', '\u2212', '\uFE58', '\uFE63', '\uFF0D']) {
      for (const article of ['le', 'la', 'les', 'des']) {
        const second = usage({ nom: 'icpe', descriptionCrise: `REDUCTION ${dash} DE L${apostrophe}EAU\nY COMPRIS ${article} LAVAGE` });
        assert.deepEqual(checkParity([{ usages: [first, second] }]), []);
      }
    }
  }
});

test('requires an overlapping profile and an overlapping resource', () => {
  const first = usage();
  const disjointProfile = usage({ concerneEntreprise: false, concerneParticulier: true, descriptionCrise: 'Autorise' });
  const disjointResource = usage({ concerneEsu: false, concerneAep: true, descriptionCrise: 'Autorise' });
  assert.deepEqual(checkParity([{ usages: [first, disjointProfile] }, { usages: [first, disjointResource] }]), []);
});

test('checks all profiles and resources using strict true booleans', () => {
  for (const profile of ['concerneParticulier', 'concerneEntreprise', 'concerneCollectivite', 'concerneExploitation']) {
    for (const resource of ['concerneEso', 'concerneEsu', 'concerneAep']) {
      const first = usage({ concerneEntreprise: false, concerneEsu: false, [profile]: true, [resource]: true });
      const second = { ...first, descriptionCrise: 'Autorise' };
      assert.equal(checkParity([{ usages: [first, second] }]).length, 1);
      assert.deepEqual(checkParity([{ usages: [first, { ...second, [profile]: 'true' }] }]), []);
      assert.deepEqual(checkParity([{ usages: [first, { ...second, [resource]: 1 }] }]), []);
    }
  }
});

test('allows identical usage names in distinct themes regardless of theme IDs', () => {
  const first = usage({ thematique: { id: 1, nom: 'Industrie' } });
  const second = usage({ thematique: { id: 1, nom: 'Agriculture' }, descriptionCrise: 'Autorise' });
  assert.deepEqual(checkParity([{ usages: [first, second] }]), []);
  assert.equal(checkParity([{ usages: [first, { ...second, thematique: { id: 2, nom: 'Industrie' } }] }]).length, 1);
});

test('does not compare usages from different restrictions or require persisted IDs', () => {
  const first = usage({ id: null });
  const second = usage({ descriptionCrise: 'Autorise' });
  assert.deepEqual(checkParity([{ usages: [first] }, { usages: [second] }]), []);
  assert.equal(checkParity([{ usages: [structuredClone(first), structuredClone(second)] }]).length, 1);
});

test('omits same-label variants not participating in a conflicting pair', () => {
  const unrelated = usage({ concerneEsu: false, concerneAep: true, descriptionCrise: 'Autre consigne' });
  const first = usage();
  const second = usage({ descriptionCrise: 'Autorise' });
  assert.deepEqual(checkParity([{ usages: [unrelated, first, second] }])[0]?.usageIndices, [1, 2]);
});

test('collects every differing level in stable order without duplicate indices', () => {
  const first = usage();
  const second = usage({ descriptionAlerte: 'Limite', descriptionCrise: 'Autorise' });
  const third = usage({ descriptionVigilance: 'Information', descriptionAlerteRenforcee: 'Limite' });
  assert.deepEqual(checkParity([{ usages: [first, second, third] }]), [{
    restrictionIndex: 0,
    usageIndices: [0, 1, 2],
    usageName: 'Usage local',
    differingFields: ['descriptionVigilance', 'descriptionAlerte', 'descriptionAlerteRenforcee', 'descriptionCrise'],
  }]);
});

test('keeps restriction indices and distinct conflict groups', () => {
  const usages = [usage(), usage({ descriptionCrise: 'Autorise' })];
  const otherName = usages.map((item) => ({ ...item, nom: 'Autre usage' }));
  assert.deepEqual(checkParity([{}, { usages: [...usages, ...otherName] }]).map(({ restrictionIndex, usageIndices }) => ({ restrictionIndex, usageIndices })), [
    { restrictionIndex: 1, usageIndices: [0, 1] },
    { restrictionIndex: 1, usageIndices: [2, 3] },
  ]);
});

test('ignores missing labels and treats absent descriptions like empty strings', () => {
  assert.deepEqual(checkParity([{ usages: [
    usage({ nom: null }),
    usage({ nom: null, descriptionCrise: 'Autorise' }),
    usage({ thematique: null }),
    usage({ thematique: null, descriptionCrise: 'Autorise' }),
    usage({ descriptionCrise: null }),
    usage({ descriptionCrise: undefined }),
    usage({ descriptionCrise: '' }),
  ] }]), []);
  assert.deepEqual(findRestrictionUsageConflicts(), []);
});

test('never mutates restriction data', () => {
  const restrictions = [{ usages: [usage(), usage({ descriptionCrise: 'Autorise' })] }];
  const before = structuredClone(restrictions);
  checkParity(restrictions);
  assert.deepEqual(restrictions, before);
});
