import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { reactive } from 'vue';
import {
  getRestrictionUsageOptions,
  getRestrictionUsageResetPreview,
  getRestrictionUsageSelectionState,
  getRestrictionUsagesForSeverity,
  haveEquivalentRestrictionUsageDefinition,
  haveSameRestrictionUsageDefinition,
  haveSameRestrictionUsageMeasure,
  replaceRestrictionUsageDefinition,
  resetRestrictionUsagesFromFramework,
  setRestrictionUsageChoice,
  setRestrictionUsageSelected,
  transferRestrictionUsageSelectionState,
} from '../client/utils/restriction-usage.ts';

const usage = (values = {}) => ({
  id: 1,
  nom: 'Production hydroelectrique',
  thematique: { id: 5 },
  concerneParticulier: false,
  concerneEntreprise: true,
  concerneCollectivite: false,
  concerneExploitation: false,
  concerneEsu: true,
  concerneEso: false,
  concerneAep: false,
  descriptionVigilance: 'Autorise',
  descriptionAlerte: 'Autorise sous conditions',
  descriptionAlerteRenforcee: 'Limite',
  descriptionCrise: 'Interdit',
  ...values,
});

const restriction = (values = {}) => ({ niveauGravite: 'alerte', arreteCadre: { id: 5 }, usages: [], ...values });
const changeSeverity = (zone, catalog, level) => {
  const previous = zone.niveauGravite;
  zone.niveauGravite = level;
  zone.usages = getRestrictionUsagesForSeverity(zone, catalog, level, previous);
  return zone.usages;
};

test('keeps same-name variants with different instructions, profiles, resources or themes as separate options', () => {
  const source = usage();
  const variants = [
    usage({ id: 2, descriptionCrise: 'Autorise sur derogation' }),
    usage({ id: 3, concerneEntreprise: false, concerneParticulier: true }),
    usage({ id: 4, concerneEsu: false, concerneEso: true }),
    usage({ id: 5, thematique: { id: 6 } }),
    ...['descriptionVigilance', 'descriptionAlerte', 'descriptionAlerteRenforcee'].map((field) => usage({ [field]: 'Autre consigne' })),
  ];
  const options = getRestrictionUsageOptions([source], variants);
  assert.equal(options.length, 8);
  assert.equal(options[0], source);
  assert.ok(options.slice(1).every((candidate) => candidate.id === null));
  assert.equal(variants[0].id, 2);
});

test('clones imported options without borrowing another zone or framework persisted id', () => {
  const template = usage({ id: 99 });
  const [option] = getRestrictionUsageOptions([], [template]);
  assert.equal(option.id, null);
  assert.notEqual(option, template);
  assert.equal(template.id, 99);
  assert.equal(getRestrictionUsageOptions([], [template, { ...template, id: 100 }]).length, 1);
});

test('changing an unrelated checkbox preserves all selected variants and their existing occurrences and ids', () => {
  const first = usage();
  const variant = usage({ id: 2, descriptionCrise: 'Autorise sur derogation' });
  const identicalOccurrence = usage({ id: 3 });
  const selected = [first, variant, identicalOccurrence];
  const [unrelated] = getRestrictionUsageOptions([], [usage({ id: 9, nom: 'Arrosage des jardins' })]);
  const afterChecking = setRestrictionUsageSelected(selected, unrelated, true);
  assert.deepEqual(afterChecking.map(({ id }) => id), [1, 2, 3, null]);
  selected.forEach((value, index) => assert.equal(afterChecking[index], value));
  const afterUnchecking = setRestrictionUsageSelected(afterChecking, unrelated, false);
  assert.deepEqual(afterUnchecking, selected);
  assert.deepEqual(selected.map(({ id }) => id), [1, 2, 3]);
});

test('checking an already selected definition does not merge occurrences or replace persisted ids', () => {
  const selected = [usage({ id: 12 }), usage({ id: 13 })];
  const options = getRestrictionUsageOptions(selected, [usage({ id: 40 })]);
  assert.equal(options.length, 1);
  assert.equal(setRestrictionUsageSelected(selected, options[0], true), selected);
  assert.deepEqual(selected.map(({ id }) => id), [12, 13]);
});

test('an explicit removal affects only the intended complete definition, including cloned null ids', () => {
  const selected = [usage({ id: null }), usage({ id: null, descriptionAlerte: 'Autre consigne' })];
  const afterRemoval = setRestrictionUsageSelected(selected, { ...selected[0] }, false);
  assert.deepEqual(afterRemoval, [selected[1]]);
  assert.equal(afterRemoval[0], selected[1]);
  assert.equal(selected.length, 2);
});

test('applying a removal to another zone preserves its different same-name definition and source data', () => {
  const source = usage({ id: 10 });
  const target = [usage({ id: 20 }), usage({ id: 21, concerneAep: true })];
  const updated = setRestrictionUsageSelected(target, source, false);
  assert.deepEqual(updated.map(({ id }) => id), [21]);
  assert.deepEqual(target.map(({ id }) => id), [20, 21]);
  assert.equal(source.id, 10);
});

test('typographic variants collapse into one option without modifying selected occurrences or ids', () => {
  const first = usage({
    id: 12,
    nom: "Alimentation des fontaines publiques d'ornement - cas general",
    descriptionCrise: "Interdit sauf pour l'eau recyclee - circuit ferme",
  });
  const second = usage({
    id: 13,
    nom: ' ALIMENTATION DES FONTAINES PUBLIQUES D\u2019ORNEMENT \u2013 CAS GENERAL\u00A0',
    descriptionCrise: 'Interdit sauf pour l\u02BCeau recyclee \u2014 circuit\r\nferme',
  });
  const selected = Object.freeze([Object.freeze(first), Object.freeze(second)]);
  const options = getRestrictionUsageOptions(selected, [usage({ ...second, id: 99 })]);
  assert.equal(options.length, 1);
  assert.equal(options[0], first);
  assert.equal(haveEquivalentRestrictionUsageDefinition(first, second), true);
  assert.equal(haveSameRestrictionUsageDefinition(first, second), false);
  assert.equal(setRestrictionUsageSelected(selected, second, true), selected);
  assert.deepEqual(selected.map(({ id }) => id), [12, 13]);
  assert.equal(selected[1].nom, second.nom);
  assert.equal(selected[1].descriptionCrise, second.descriptionCrise);
});

test('definition equivalence normalizes every instruction but keeps all public and resource flags distinct', () => {
  const first = usage();
  for (const field of ['nom', 'descriptionVigilance', 'descriptionAlerte', 'descriptionAlerteRenforcee', 'descriptionCrise']) {
    assert.equal(haveEquivalentRestrictionUsageDefinition(first, usage({ [field]: `\t${first[field].toUpperCase()}\n` })), true);
    assert.equal(haveEquivalentRestrictionUsageDefinition(first, usage({ [field]: `${first[field]} exception` })), false);
  }
  for (const field of [
    'concerneParticulier', 'concerneEntreprise', 'concerneCollectivite', 'concerneExploitation',
    'concerneEsu', 'concerneEso', 'concerneAep',
  ]) {
    const other = usage({ [field]: !first[field] });
    assert.equal(haveEquivalentRestrictionUsageDefinition(first, other), false);
    assert.equal(haveSameRestrictionUsageMeasure(first, other), true);
  }
  assert.equal(haveEquivalentRestrictionUsageDefinition(first, usage({ thematique: { id: 6 } })), false);
  assert.equal(haveSameRestrictionUsageMeasure(first, usage({ thematique: { id: 6 } })), false);
});

test('typographic equivalence handles Unicode forms but never removes or rewrites words', () => {
  assert.equal(haveEquivalentRestrictionUsageDefinition(usage({ nom: 'Fontaines 47' }), usage({ nom: '\uFF26ontaines \uFF14\uFF17' })), true);
  assert.equal(haveEquivalentRestrictionUsageDefinition(usage({ descriptionCrise: 'Interdit y compris le remplissage' }), usage({ descriptionCrise: 'Interdit y compris remplissage' })), false);
  assert.equal(haveEquivalentRestrictionUsageDefinition(usage({ descriptionCrise: 'Limite a 10 %' }), usage({ descriptionCrise: 'Limite a 20 %' })), false);
});

test('explicitly unchecking a typographic definition removes its equivalent occurrences only', () => {
  const first = usage({ id: 12 });
  const equivalent = usage({ id: 13, nom: first.nom.toUpperCase() });
  const conflicting = usage({ id: 14, descriptionCrise: 'Autorise' });
  const selected = [first, equivalent, conflicting];
  assert.deepEqual(setRestrictionUsageSelected(selected, equivalent, false), [conflicting]);
  assert.deepEqual(selected.map(({ id }) => id), [12, 13, 14]);
});

test('strict editing and id-matching identity never treats typographic variants as interchangeable', () => {
  const first = usage({ id: 12 });
  const equivalent = usage({ id: 13, nom: first.nom.toUpperCase() });
  const replacement = usage({ id: 99, descriptionCrise: 'Nouvelle consigne' });
  const updated = replaceRestrictionUsageDefinition([first, equivalent], first, replacement);
  assert.equal(updated[0].id, 12);
  assert.equal(updated[0].descriptionCrise, 'Nouvelle consigne');
  assert.equal(updated[1], equivalent);
  assert.equal(haveSameRestrictionUsageDefinition(first, equivalent), false);
});

test('changing severity never adds the conflicting framework variant of an old decree measure', () => {
  const oldDecreeUsage = usage({ id: 47, descriptionAlerte: 'Mesure historique', descriptionCrise: 'Interdit' });
  const currentFrameworkUsage = usage({ id: 97, descriptionAlerte: '', descriptionCrise: 'Autorise sur derogation' });
  const selected = Object.freeze([Object.freeze(oldDecreeUsage)]);
  const catalog = Object.freeze([Object.freeze(currentFrameworkUsage)]);
  const zone = restriction({ usages: selected });
  getRestrictionUsageSelectionState(zone, catalog);
  assert.deepEqual(changeSeverity(zone, catalog, 'crise'), selected);
  assert.equal(zone.usages[0], oldDecreeUsage);
  assert.deepEqual(selected.map(({ id }) => id), [47]);
  assert.equal(currentFrameworkUsage.id, 97);
});

test('inactive choices survive a save and remount but return with new ids, while active ids stay intact', () => {
  const selected = Object.freeze([
    Object.freeze(usage({ id: 12, descriptionAlerte: '', descriptionVigilance: null })),
    Object.freeze(usage({ id: 13, descriptionAlerte: '', descriptionVigilance: null })),
    usage({ id: 14, nom: 'Arrosage' }),
  ]);
  const zone = restriction({ usages: selected, niveauGravite: 'crise' });
  const catalog = [usage({ id: 99, descriptionCrise: 'Autre version' })];
  const initialState = getRestrictionUsageSelectionState(zone, catalog);
  assert.deepEqual(changeSeverity(zone, catalog, 'alerte').map(({ id }) => id), [14]);
  zone.usages[0].id = 140;
  assert.equal(getRestrictionUsageSelectionState(zone, catalog), initialState);
  assert.deepEqual(changeSeverity(zone, catalog, 'crise').map(({ id }) => id), [null, null, 140]);
  assert.notEqual(zone.usages[0], selected[0]);
  assert.equal(zone.usages[2], selected[2]);
  assert.deepEqual(selected.slice(0, 2).map(({ id }) => id), [12, 13]);
  assert.equal(initialState.intended.length, 3);
});

test('an intentionally empty selection remains empty when changing severity', () => {
  const zone = restriction();
  const catalog = [usage()];
  getRestrictionUsageSelectionState(zone, catalog);
  for (const level of ['crise', 'vigilance', 'alerte']) {
    assert.deepEqual(changeSeverity(zone, catalog, level), []);
  }
});

test('the first severity assignment initializes only applicable distinct definitions from the supplied catalog', () => {
  const template = usage({ id: 90 });
  const equivalentTemplate = usage({ id: 91, nom: template.nom.toUpperCase() });
  const noInstruction = usage({ id: 92, nom: 'Nettoyage des facades', descriptionAlerte: ' \r\n\t ' });
  const missingInstruction = usage({ id: 93, nom: 'Lavage des voitures', descriptionAlerte: null });
  const differentPublic = usage({ id: 94, concerneEntreprise: false, concerneParticulier: true });
  const catalog = [template, equivalentTemplate, noInstruction, missingInstruction, differentPublic];
  const zone = restriction({ niveauGravite: null });
  const before = JSON.stringify(zone);
  const state = getRestrictionUsageSelectionState(zone, catalog);
  assert.equal(JSON.stringify(zone), before);
  assert.equal(state.intended.length, 4);
  assert.equal(state.frameworkOnly, true);
  const defaults = changeSeverity(zone, catalog, 'alerte');
  assert.equal(defaults.length, 2);
  assert.deepEqual(defaults.map(({ id }) => id), [null, null]);
  assert.equal(defaults[0].nom, template.nom);
  assert.equal(defaults[1].concerneParticulier, true);
  assert.notEqual(defaults[0], template);
  assert.deepEqual(catalog.map(({ id }) => id), [90, 91, 92, 93, 94]);
});

test('first severity assignment preserves a copied selection instead of replacing it with framework defaults', () => {
  const selected = [usage({ id: 47, descriptionCrise: 'Consigne historique' })];
  const catalog = [usage({ id: 99, descriptionCrise: 'Consigne actuelle' })];
  const zone = restriction({ niveauGravite: null, usages: selected });
  assert.equal(getRestrictionUsageSelectionState(zone, catalog).frameworkOnly, false);
  assert.deepEqual(changeSeverity(zone, catalog, 'crise'), selected);
  assert.equal(zone.usages[0], selected[0]);
});

test('missing or unknown severity does not initialize any usages', () => {
  const zone = restriction({ niveauGravite: null });
  for (const level of [null, undefined, '', 'inconnu', 'constructor', '__proto__']) {
    assert.deepEqual(changeSeverity(zone, [usage()], level), []);
  }
});

test('a new zone with no vigilance instruction gets legitimate framework defaults at the next level', () => {
  const zone = restriction({ niveauGravite: null });
  const catalog = [usage({ id: 50, descriptionVigilance: null }), usage({ id: 51, nom: 'Arrosage', descriptionVigilance: '' })];
  getRestrictionUsageSelectionState(zone, catalog);
  assert.deepEqual(changeSeverity(zone, catalog, 'vigilance'), []);
  assert.equal(changeSeverity(zone, catalog, 'alerte').length, 2);
  const [first] = zone.usages;
  zone.usages = setRestrictionUsageChoice(zone, first, false);
  assert.deepEqual(changeSeverity(zone, catalog, 'vigilance'), []);
  assert.deepEqual(changeSeverity(zone, catalog, 'crise').map(({ nom }) => nom), ['Arrosage']);
});

test('a first level watcher also initializes a new zone when setup has not accessed the state yet', () => {
  const zone = restriction({ niveauGravite: null });
  assert.equal(changeSeverity(zone, [usage()], 'alerte').length, 1);
  assert.equal(zone.usages[0].id, null);
});

test('explicitly unchecking every choice never reinitializes or restores it on later level changes', () => {
  const zone = restriction({ usages: [usage()] });
  const catalog = [usage({ id: 99 })];
  getRestrictionUsageSelectionState(zone, catalog);
  zone.usages = setRestrictionUsageChoice(zone, zone.usages[0], false);
  for (const level of ['crise', 'vigilance', null, 'alerte']) {
    assert.deepEqual(changeSeverity(zone, catalog, level), []);
  }
});

test('an explicit removal from another zone can remove a currently inactive equivalent intention', () => {
  const source = usage({ id: 47, descriptionVigilance: null });
  const zone = restriction({ usages: [{ ...source, id: 48 }] });
  getRestrictionUsageSelectionState(zone, []);
  assert.deepEqual(changeSeverity(zone, [], 'vigilance'), []);
  zone.usages = setRestrictionUsageChoice(zone, source, false);
  assert.deepEqual(changeSeverity(zone, [], 'crise'), []);
});

test('selection state reconciles external array replacements, pushed usages, edits and explicit removals', () => {
  const zone = restriction({ usages: [usage({ id: 12 })] });
  const state = getRestrictionUsageSelectionState(zone, []);
  zone.usages = [{ ...zone.usages[0], descriptionCrise: 'Nouvelle consigne' }];
  zone.usages.push(usage({ id: null, nom: 'Arrosage' }));
  getRestrictionUsageSelectionState(zone, []);
  assert.deepEqual(state.intended.map(({ descriptionCrise }) => descriptionCrise), ['Nouvelle consigne', 'Interdit']);
  assert.deepEqual(changeSeverity(zone, [], 'crise').map(({ id }) => id), [12, null]);
  zone.usages[1].id = 99;
  getRestrictionUsageSelectionState(zone, []);
  assert.equal(state.intended[1].id, 99);
  zone.usages = [zone.usages[1]];
  assert.deepEqual(changeSeverity(zone, [], 'alerte').map(({ nom }) => nom), ['Arrosage']);
  assert.equal(state.intended.length, 1);
});

test('unsaved edits replace the previous definition instead of restoring it on a later level', () => {
  const zone = restriction({ usages: [usage({ id: null })] });
  getRestrictionUsageSelectionState(zone, []);
  zone.usages = [{ ...zone.usages[0], descriptionCrise: 'Nouvelle consigne' }];
  assert.deepEqual(changeSeverity(zone, [], 'crise').map(({ descriptionCrise }) => descriptionCrise), ['Nouvelle consigne']);
  assert.equal(getRestrictionUsageSelectionState(zone, []).intended.length, 1);
});

test('raw and Vue proxy references share state and do not duplicate selected occurrences', () => {
  const raw = restriction({ usages: [usage({ id: 12 }), usage({ id: 13 })] });
  const state = getRestrictionUsageSelectionState(raw, []);
  const proxy = reactive(raw);
  assert.equal(getRestrictionUsageSelectionState(proxy, []), state);
  assert.deepEqual(changeSeverity(proxy, [], 'crise').map(({ id }) => id), [12, 13]);
  assert.equal(state.intended.length, 2);
  assert.equal(Object.keys(raw).includes('intended'), false);
  assert.equal(JSON.stringify(raw).includes('frameworkOnly'), false);
});

test('reading a legacy selection never removes blank usages or changes its payload', () => {
  const zone = restriction({ usages: [usage({ descriptionAlerte: null })] });
  const before = JSON.stringify(zone);
  getRestrictionUsageSelectionState(zone, [usage()]);
  assert.equal(JSON.stringify(zone), before);
  assert.deepEqual(changeSeverity(zone, [], 'vigilance').map(({ nom }) => nom), [usage().nom]);
  assert.deepEqual(changeSeverity(zone, [], 'alerte'), []);
});

test('framework reset replaces the polluted selection and keeps future-level defaults outside the payload', () => {
  const selected = Array.from({ length: 58 }, (_, index) => usage({ id: index + 1, nom: `Mesure ${index % 17}`, descriptionCrise: `Ancienne variante ${index}` }));
  const catalog = Array.from({ length: 17 }, (_, index) => usage({ id: index + 100, nom: `Mesure ${index}`, descriptionVigilance: null }));
  const zone = restriction({ usages: selected, niveauGravite: 'crise' });
  const original = JSON.stringify(selected);
  getRestrictionUsageSelectionState(zone, catalog);
  const preview = getRestrictionUsageResetPreview(selected, catalog, 'crise');
  assert.equal(preview.usages.length, 17);
  assert.equal(preview.groups.length, 17);
  assert.equal(preview.groups.reduce((count, group) => count + group.before.length, 0), 58);
  assert.equal(preview.groups.reduce((count, group) => count + group.after.length, 0), 17);
  assert.ok(preview.groups.every(({ change }) => change === 'changed'));
  zone.usages = resetRestrictionUsagesFromFramework(zone, catalog);
  assert.equal(zone.usages.length, 17);
  assert.ok(zone.usages.every(({ id }) => id === null));
  const state = getRestrictionUsageSelectionState(zone, catalog);
  assert.equal(state.frameworkOnly, true);
  assert.equal(state.intended.length, 17);
  assert.equal(JSON.stringify(selected), original);
  assert.deepEqual(changeSeverity(zone, catalog, 'vigilance'), []);
  assert.equal(changeSeverity(zone, catalog, 'alerte').length, 17);
});

test('reset preview distinguishes added, removed and changed measures and keeps duplicate counts', () => {
  const selected = [usage({ id: 12 }), usage({ id: 13, nom: usage().nom.toUpperCase() }), usage({ id: 14, nom: 'Ancienne mesure' })];
  const catalog = [usage({ id: 90 }), usage({ id: 91, nom: 'Nouvelle mesure' }), usage({ id: 92, nom: 'Inapplicable', descriptionAlerte: null })];
  const preview = getRestrictionUsageResetPreview(selected, catalog, 'alerte');
  assert.deepEqual(preview.groups.map(({ change }) => change), ['changed', 'removed', 'added', 'added']);
  assert.equal(preview.groups[0].before.length, 2);
  assert.equal(preview.groups[0].after.length, 1);
  assert.equal(preview.groups[0].before[0], selected[0]);
  assert.deepEqual(getRestrictionUsageResetPreview([usage()], [usage({ id: 99, nom: usage().nom.toUpperCase() })], 'alerte').groups, []);
});

test('reset preview discloses removal and addition of future-level intentions even with no active usages', () => {
  const selected = [usage({ nom: 'Ancienne mesure de crise', descriptionAlerte: null })];
  const catalog = [usage({ nom: 'Nouvelle mesure de crise', descriptionAlerte: null })];
  const preview = getRestrictionUsageResetPreview(selected, catalog, 'alerte');
  assert.deepEqual(preview.usages, []);
  assert.deepEqual(preview.groups.map(({ name, change }) => ({ name, change })), [
    { name: 'Ancienne mesure de crise', change: 'removed' },
    { name: 'Nouvelle mesure de crise', change: 'added' },
  ]);
});

test('reset preview compares all levels, public flags, resources and themes without mixing frameworks', () => {
  const selected = [usage()];
  for (const change of [{ descriptionCrise: 'Autre consigne' }, { concerneParticulier: true }, { concerneAep: true }]) {
    assert.equal(getRestrictionUsageResetPreview(selected, [usage(change)], 'alerte').groups[0].change, 'changed');
  }
  assert.deepEqual(getRestrictionUsageResetPreview(selected, [usage({ thematique: { id: 6 } })], 'alerte').groups.map(({ change }) => change), ['removed', 'added']);
  const first = restriction({ usages: [usage()], arreteCadre: { id: 1 } });
  const second = restriction({ usages: [usage({ id: 2 })], arreteCadre: { id: 2 } });
  getRestrictionUsageSelectionState(second, []);
  first.usages = resetRestrictionUsagesFromFramework(first, [usage({ id: 100, descriptionCrise: 'AC 1' })]);
  assert.equal(second.usages[0].descriptionCrise, 'Interdit');
  assert.equal(getRestrictionUsageSelectionState(second, []).frameworkOnly, false);
});

test('cloning an AEP group under the same framework transfers inactive choices and reset scope', () => {
  const source = restriction({ niveauGravite: 'crise' });
  const catalog = [usage({ descriptionVigilance: null })];
  source.usages = resetRestrictionUsagesFromFramework(source, catalog);
  source.usages[0].id = 123;
  changeSeverity(source, catalog, 'vigilance');
  const target = JSON.parse(JSON.stringify(source));
  transferRestrictionUsageSelectionState(source, target);
  assert.equal(getRestrictionUsageSelectionState(target, catalog).frameworkOnly, true);
  assert.deepEqual(changeSeverity(target, catalog, 'crise').map(({ id }) => id), [null]);
  assert.deepEqual(source.usages, []);
});

test('another framework cannot inherit inactive choices after replacing or mutating a group', () => {
  const source = restriction({ usages: [usage({ descriptionVigilance: null })] });
  getRestrictionUsageSelectionState(source, []);
  changeSeverity(source, [], 'vigilance');
  const target = JSON.parse(JSON.stringify(source));
  target.arreteCadre.id = 99;
  transferRestrictionUsageSelectionState(source, target);
  assert.deepEqual(changeSeverity(target, [usage({ id: 90, nom: 'AC 99' })], 'crise'), []);
  source.arreteCadre.id = 100;
  assert.deepEqual(changeSeverity(source, [usage({ id: 91, nom: 'AC 100' })], 'crise'), []);
});

test('form selection uses complete definitions, stable local checkbox ids and a local action by default', async () => {
  const form = await readFile(new URL('../client/components/arreteRestriction/form/restriction.vue', import.meta.url), 'utf8');
  const zones = await readFile(new URL('../client/components/arreteRestriction/form/gravite.vue', import.meta.url), 'utf8');
  assert.match(form, /setRestrictionUsageChoice\(props\.restriction, usage, checked\)/);
  assert.match(form, /new WeakMap<UsageArreteCadre, string>/);
  assert.match(form, /:model-value="isUsageSelected\(usageArreteCadre\)"/);
  assert.match(form, /getUsageVariantLabel\(usageArreteCadre\)/);
  assert.ok(form.indexOf("label: 'Appliquer seulement") < form.indexOf("label: 'Appliquer à toutes"));
  assert.doesNotMatch(form, /usagesSelected|filterUsages\(\)/);
  assert.match(zones, /setRestrictionUsageChoice\(r, usage, false\)/);
  assert.match(zones, /arrete-restriction-zone-\$\{arreteRestriction\.restrictions\.indexOf\(r\)\}/);
});
