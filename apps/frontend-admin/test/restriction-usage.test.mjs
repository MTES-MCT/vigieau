import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  canReuseRestrictionUsages,
  concernsAnyWaterType,
  getUsageTargetAssignments,
  haveSameRestrictionUsageDefinition,
  replaceRestrictionUsageDefinition,
} from '../client/utils/restriction-usage.ts';

const usage = (waterTypes = {}) => ({
  concerneEsu: false,
  concerneEso: false,
  concerneAep: false,
  ...waterTypes,
});

test('matches each water type with its usage flag', () => {
  assert.equal(concernsAnyWaterType(usage({ concerneEsu: true }), ['SUP']), true);
  assert.equal(concernsAnyWaterType(usage({ concerneEso: true }), ['SOU']), true);
  assert.equal(concernsAnyWaterType(usage({ concerneAep: true }), ['AEP']), true);
});

test('matches an ESO-only usage when several water types are displayed', () => {
  assert.equal(concernsAnyWaterType(usage({ concerneEso: true }), ['SUP', 'SOU', 'AEP']), true);
});

test('rejects usages unrelated to the displayed water types', () => {
  assert.equal(concernsAnyWaterType(usage({ concerneEso: true }), ['SUP']), false);
  assert.equal(concernsAnyWaterType(usage({ concerneEsu: true }), ['AEP']), false);
  assert.equal(concernsAnyWaterType(usage({ concerneEsu: true }), []), false);
});

test('reuses usages only between restrictions of the same framework order', () => {
  assert.equal(canReuseRestrictionUsages({ id: 2, arreteCadre: { id: 10 } }, 1, 10), true);
  assert.equal(canReuseRestrictionUsages({ id: 2, arreteCadre: { id: 11 } }, 1, 10), false);
  assert.equal(canReuseRestrictionUsages({ id: 1, arreteCadre: { id: 10 } }, 1, 10), false);
  assert.equal(canReuseRestrictionUsages({ id: 2 }, 1, undefined), false);
});

test('adds a framework usage only to compatible restrictions of that framework', () => {
  const targetUsage = {
    ...usage({ concerneEso: true }),
    nom: 'Irrigation agricole',
    thematique: { id: 5 },
  };
  const restrictions = [
    { id: 1, arreteCadre: { id: 10 }, isAep: false, zoneAlerte: { type: 'SOU' } },
    { id: 2, arreteCadre: { id: 11 }, isAep: false, zoneAlerte: { type: 'SOU' } },
    { id: 3, arreteCadre: { id: 10 }, isAep: false, zoneAlerte: { type: 'SUP' } },
  ];
  const frameworks = [
    { id: 10, usages: [targetUsage] },
    { id: 11, usages: [] },
  ];

  assert.deepEqual(
    getUsageTargetAssignments(restrictions, frameworks, targetUsage).map(({ restriction }) => restriction.id),
    [1],
  );
});

test('keeps each framework template when labels match but instructions differ', () => {
  const selectedUsage = {
    ...usage({ concerneEso: true }),
    nom: 'Irrigation agricole',
    thematique: { id: 5 },
    descriptionCrise: 'Valeur de la recherche globale',
  };
  const framework10Usage = {
    ...selectedUsage,
    descriptionCrise: 'Interdit par AC 10',
  };
  const framework11Usage = {
    ...selectedUsage,
    descriptionCrise: 'Autorisé par AC 11',
  };
  const restrictions = [
    { id: 1, arreteCadre: { id: 10 }, isAep: false, zoneAlerte: { type: 'SOU' } },
    { id: 2, arreteCadre: { id: 11 }, isAep: false, zoneAlerte: { type: 'SOU' } },
  ];

  const assignments = getUsageTargetAssignments(
    restrictions,
    [
      { id: 10, usages: [framework10Usage] },
      { id: 11, usages: [framework11Usage] },
    ],
    selectedUsage,
  );

  assert.deepEqual(
    assignments.map(({ restriction, usage: assignedUsage }) => [restriction.id, assignedUsage.descriptionCrise]),
    [
      [1, 'Interdit par AC 10'],
      [2, 'Autorisé par AC 11'],
    ],
  );
});

test('adds a custom usage to every compatible resource when no framework defines it', () => {
  const targetUsage = {
    ...usage({ concerneEsu: true, concerneAep: true }),
    nom: 'Usage local',
    thematique: { id: 8 },
  };
  const restrictions = [
    { id: 1, arreteCadre: { id: 10 }, isAep: false, zoneAlerte: { type: 'SUP' } },
    { id: 2, arreteCadre: { id: 11 }, isAep: false, zoneAlerte: { type: 'SOU' } },
    { id: 3, arreteCadre: { id: 11 }, isAep: true, zoneAlerte: null },
  ];

  assert.deepEqual(
    getUsageTargetAssignments(restrictions, [], targetUsage).map(({ restriction }) => restriction.id),
    [1, 3],
  );
});

test('compares the complete business definition before editing an existing usage', () => {
  const reference = {
    ...usage({ concerneEso: true }),
    nom: 'Irrigation agricole',
    thematique: { id: 5 },
    concerneParticulier: true,
    descriptionCrise: 'Interdit par AC 10',
  };

  assert.equal(haveSameRestrictionUsageDefinition(reference, { ...reference, id: 99 }), true);
  assert.equal(
    haveSameRestrictionUsageDefinition(reference, {
      ...reference,
      descriptionCrise: 'Autorisé par AC 11',
    }),
    false,
  );
});

test('edits only the exact variant and preserves each persisted usage id', () => {
  const source = {
    ...usage({ concerneEso: true }),
    id: 12,
    nom: 'Irrigation agricole',
    thematique: { id: 5 },
    concerneParticulier: true,
    descriptionCrise: 'Interdit par AC 10',
  };
  const otherFrameworkVariant = {
    ...source,
    id: 34,
    descriptionCrise: 'Autorisé par AC 11',
  };

  const updated = replaceRestrictionUsageDefinition([source, otherFrameworkVariant], source, {
    ...source,
    id: null,
    descriptionCrise: 'Nouvelle consigne AC 10',
  });

  assert.deepEqual(
    updated.map(({ id, descriptionCrise }) => [id, descriptionCrise]),
    [
      [12, 'Nouvelle consigne AC 10'],
      [34, 'Autorisé par AC 11'],
    ],
  );
});

test('labels ambiguous variants with their framework and crisis instruction', async () => {
  const restrictionUsageForm = await readFile(new URL('../client/components/arreteRestriction/form/usages.vue', import.meta.url), 'utf8');
  const usageList = await readFile(new URL('../client/components/arreteCadre/usageList.vue', import.meta.url), 'utf8');

  assert.match(restrictionUsageForm, /:usage-labels="arreteRestrictionUsageLabels"/);
  assert.match(restrictionUsageForm, /crise : \$\{crisisLabel\}/);
  assert.match(usageList, /props\.usageLabels\?\.\[index\] \?\? u\.nom/);
});
