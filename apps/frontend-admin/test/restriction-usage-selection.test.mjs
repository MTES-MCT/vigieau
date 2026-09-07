import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getRestrictionUsageOptions, setRestrictionUsageSelected } from '../client/utils/restriction-usage.ts';

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

test('form selection uses exact definitions, stable local checkbox ids and a local action by default', async () => {
  const form = await readFile(new URL('../client/components/arreteRestriction/form/restriction.vue', import.meta.url), 'utf8');
  const zones = await readFile(new URL('../client/components/arreteRestriction/form/gravite.vue', import.meta.url), 'utf8');
  assert.match(form, /setRestrictionUsageSelected\(props\.restriction\.usages, usage, checked\)/);
  assert.match(form, /new WeakMap<UsageArreteCadre, string>/);
  assert.match(form, /:model-value="isUsageSelected\(usageArreteCadre\)"/);
  assert.match(form, /getUsageVariantLabel\(usageArreteCadre\)/);
  assert.ok(form.indexOf("label: 'Appliquer seulement") < form.indexOf("label: 'Appliquer à toutes"));
  assert.doesNotMatch(form, /usagesSelected|filterUsages\(\)/);
  assert.match(zones, /setRestrictionUsageSelected\(r\.usages, usage, false\)/);
  assert.match(zones, /arrete-restriction-zone-\$\{arreteRestriction\.restrictions\.indexOf\(r\)\}/);
});
