import { toRaw } from 'vue';

export type RestrictionWaterType = 'SUP' | 'SOU' | 'AEP';

interface RestrictionUsageSource {
  id: number | null;
  arreteCadre?: { id?: number | null } | null;
}

interface RestrictionUsageWaterTypes {
  concerneEsu: boolean;
  concerneEso: boolean;
  concerneAep: boolean;
}

interface RestrictionUsageDefinition extends RestrictionUsageWaterTypes {
  id?: number | null;
  nom: string | null;
  thematique?: { id?: number | null } | null;
  concerneParticulier?: boolean;
  concerneEntreprise?: boolean;
  concerneCollectivite?: boolean;
  concerneExploitation?: boolean;
  descriptionVigilance?: string | null;
  descriptionAlerte?: string | null;
  descriptionAlerteRenforcee?: string | null;
  descriptionCrise?: string | null;
}

interface RestrictionUsageFramework {
  id: number | null;
  usages: RestrictionUsageDefinition[];
}

interface RestrictionUsageTarget extends RestrictionUsageSource {
  isAep: boolean;
  zoneAlerte?: { type?: RestrictionWaterType } | null;
}

const usageFlagByWaterType = {
  SUP: 'concerneEsu',
  SOU: 'concerneEso',
  AEP: 'concerneAep',
} as const;

export const concernsAnyWaterType = (usage: RestrictionUsageWaterTypes, waterTypes: readonly RestrictionWaterType[]) =>
  waterTypes.some((waterType) => usage[usageFlagByWaterType[waterType]]);

export const canReuseRestrictionUsages = (
  source: RestrictionUsageSource,
  currentRestrictionId: number | null,
  currentArreteCadreId: number | null | undefined,
): boolean => currentArreteCadreId != null && source.id !== currentRestrictionId && source.arreteCadre?.id === currentArreteCadreId;

const usageFlagFields = [
  'concerneParticulier',
  'concerneEntreprise',
  'concerneCollectivite',
  'concerneExploitation',
  'concerneEso',
  'concerneEsu',
  'concerneAep',
] as const satisfies readonly (keyof RestrictionUsageDefinition)[];

const usageDescriptionFields = [
  'descriptionVigilance',
  'descriptionAlerte',
  'descriptionAlerteRenforcee',
  'descriptionCrise',
] as const satisfies readonly (keyof RestrictionUsageDefinition)[];

const usageDefinitionFields = [...usageFlagFields, ...usageDescriptionFields] as const;

const normalizeUsageTypography = (value: string | null | undefined): string =>
  (value ?? '')
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u02BC\uFF07]/gu, "'")
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase('fr-FR');

export const haveSameRestrictionUsageMeasure = (first: RestrictionUsageDefinition, second: RestrictionUsageDefinition): boolean =>
  normalizeUsageTypography(first.nom) === normalizeUsageTypography(second.nom) &&
  (first.thematique?.id ?? null) === (second.thematique?.id ?? null);

export const haveSameRestrictionUsageDefinition = (first: RestrictionUsageDefinition, second: RestrictionUsageDefinition): boolean =>
  first.nom === second.nom &&
  (first.thematique?.id ?? null) === (second.thematique?.id ?? null) &&
  usageDefinitionFields.every((field) => (first[field] ?? null) === (second[field] ?? null));

export const haveEquivalentRestrictionUsageDefinition = (first: RestrictionUsageDefinition, second: RestrictionUsageDefinition): boolean =>
  haveSameRestrictionUsageMeasure(first, second) &&
  usageFlagFields.every((field) => (first[field] ?? null) === (second[field] ?? null)) &&
  usageDescriptionFields.every((field) => normalizeUsageTypography(first[field]) === normalizeUsageTypography(second[field]));

export const getRestrictionUsageOptions = <T extends RestrictionUsageDefinition>(selected: T[], candidates: T[]): T[] => {
  const options: T[] = [];
  selected.forEach((usage) => {
    if (!options.some((candidate) => haveEquivalentRestrictionUsageDefinition(candidate, usage))) {
      options.push(usage);
    }
  });
  candidates.forEach((usage) => {
    if (!options.some((candidate) => haveEquivalentRestrictionUsageDefinition(candidate, usage))) {
      options.push({ ...usage, id: null });
    }
  });
  return options;
};

export const setRestrictionUsageSelected = <T extends RestrictionUsageDefinition>(selected: T[], usage: T, checked: boolean): T[] => {
  if (!checked) {
    return selected.filter((candidate) => !haveEquivalentRestrictionUsageDefinition(candidate, usage));
  }
  // Keep existing occurrences and persisted IDs instead of rebuilding the selection from options.
  return selected.some((candidate) => haveEquivalentRestrictionUsageDefinition(candidate, usage)) ? selected : [...selected, usage];
};

const usageDescriptionBySeverity = {
  vigilance: 'descriptionVigilance',
  alerte: 'descriptionAlerte',
  alerte_renforcee: 'descriptionAlerteRenforcee',
  crise: 'descriptionCrise',
} as const satisfies Record<string, (typeof usageDescriptionFields)[number]>;

interface RestrictionUsageSelectionTarget<T extends RestrictionUsageDefinition> {
  usages: T[];
  niveauGravite?: string | null;
  arreteCadre?: { id?: number | null } | null;
}

export interface RestrictionUsageSelectionState<T extends RestrictionUsageDefinition> {
  intended: T[];
  active: T[];
  frameworkOnly: boolean;
}

interface RestrictionUsageSelectionCache {
  frameworkId: number | null;
  state: RestrictionUsageSelectionState<RestrictionUsageDefinition>;
}

// Keep temporarily inactive choices outside the serialized decree and across component remounts.
const restrictionUsageSelections = new WeakMap<object, RestrictionUsageSelectionCache>();

const hasUsageDescriptionForSeverity = (usage: RestrictionUsageDefinition, severity: string | null | undefined): boolean => {
  if (!severity || !Object.prototype.hasOwnProperty.call(usageDescriptionBySeverity, severity)) {
    return false;
  }
  return normalizeUsageTypography(usage[usageDescriptionBySeverity[severity as keyof typeof usageDescriptionBySeverity]]) !== '';
};

const findMatchingUsageIndex = <T extends RestrictionUsageDefinition>(usages: T[], usage: T): number => {
  const persistedIndex = usage.id == null ? -1 : usages.findIndex((candidate) => candidate.id === usage.id);
  return persistedIndex >= 0 ? persistedIndex : usages.findIndex((candidate) => haveSameRestrictionUsageDefinition(candidate, usage));
};

const synchronizeRestrictionUsageSelection = <T extends RestrictionUsageDefinition>(
  restriction: RestrictionUsageSelectionTarget<T>,
  state: RestrictionUsageSelectionState<T>,
) => {
  const incoming = [...restriction.usages];
  const intended = [...state.intended];
  const consumedIntentionIndices = new Set<number>();
  const removedIntentionIndices = new Set<number>();

  state.active.forEach((previous) => {
    const availableIndices = intended.map((_, index) => index).filter((index) => !consumedIntentionIndices.has(index));
    const intentionMatch = findMatchingUsageIndex(availableIndices.map((index) => intended[index]), previous);
    const intentionIndex = intentionMatch < 0 ? -1 : availableIndices[intentionMatch];
    const incomingIndex = findMatchingUsageIndex(incoming, previous);
    if (intentionIndex >= 0) {
      consumedIntentionIndices.add(intentionIndex);
    }
    if (incomingIndex < 0) {
      if (intentionIndex >= 0) {
        removedIntentionIndices.add(intentionIndex);
      }
      return;
    }
    const [current] = incoming.splice(incomingIndex, 1);
    if (intentionIndex >= 0) {
      intended[intentionIndex] = current;
    } else {
      intended.push(current);
      consumedIntentionIndices.add(intended.length - 1);
    }
  });

  state.intended = intended.filter((_, index) => !removedIntentionIndices.has(index)).concat(incoming);
  state.active = [...restriction.usages];
};

export const getRestrictionUsageSelectionState = <T extends RestrictionUsageDefinition>(
  restriction: RestrictionUsageSelectionTarget<T>,
  catalog: T[],
): RestrictionUsageSelectionState<T> => {
  const key = toRaw(restriction);
  const frameworkId = restriction.arreteCadre?.id ?? null;
  let cached = restrictionUsageSelections.get(key);
  if (!cached || cached.frameworkId !== frameworkId) {
    const isNewZone = restriction.niveauGravite == null && restriction.usages.length === 0;
    cached = {
      frameworkId,
      state: {
        intended: isNewZone ? getRestrictionUsageOptions([], catalog) : [...restriction.usages],
        active: [...restriction.usages],
        frameworkOnly: isNewZone,
      },
    };
    restrictionUsageSelections.set(key, cached);
  }
  const state = cached.state as RestrictionUsageSelectionState<T>;
  synchronizeRestrictionUsageSelection(restriction, state);
  return state;
};

const activateRestrictionUsageSelection = <T extends RestrictionUsageDefinition>(
  state: RestrictionUsageSelectionState<T>,
  severity: string | null | undefined,
): T[] => {
  const previousActive = [...state.active];
  const active: T[] = [];
  state.intended = state.intended.map((usage) => {
    if (!hasUsageDescriptionForSeverity(usage, severity)) {
      return usage;
    }
    const activeIndex = findMatchingUsageIndex(previousActive, usage);
    // Saving another level can delete inactive persisted rows, so restored choices need new IDs.
    const selected = activeIndex < 0 ? { ...usage, id: null } : usage;
    if (activeIndex >= 0) {
      previousActive.splice(activeIndex, 1);
    }
    active.push(selected);
    return selected;
  });
  state.active = [...active];
  return active;
};

export const getRestrictionUsagesForSeverity = <T extends RestrictionUsageDefinition>(
  restriction: RestrictionUsageSelectionTarget<T>,
  catalog: T[],
  newSeverity: string | null | undefined,
  oldSeverity: string | null | undefined,
): T[] => {
  // The UI has already assigned the new level when its watcher invokes this function.
  const key = toRaw(restriction);
  const cached = restrictionUsageSelections.get(key);
  if (!cached || cached.frameworkId !== (restriction.arreteCadre?.id ?? null)) {
    const original = { ...restriction, niveauGravite: oldSeverity };
    const state = getRestrictionUsageSelectionState(original, catalog);
    restrictionUsageSelections.set(key, { frameworkId: restriction.arreteCadre?.id ?? null, state });
    restrictionUsageSelections.delete(original);
  }
  return activateRestrictionUsageSelection(getRestrictionUsageSelectionState(restriction, catalog), newSeverity);
};

export const setRestrictionUsageChoice = <T extends RestrictionUsageDefinition>(
  restriction: RestrictionUsageSelectionTarget<T>,
  usage: T,
  checked: boolean,
): T[] => {
  const state = getRestrictionUsageSelectionState(restriction, []);
  state.intended = setRestrictionUsageSelected(state.intended, usage, checked);
  return activateRestrictionUsageSelection(state, restriction.niveauGravite);
};

export const resetRestrictionUsagesFromFramework = <T extends RestrictionUsageDefinition>(
  restriction: RestrictionUsageSelectionTarget<T>,
  catalog: T[],
): T[] => {
  const state: RestrictionUsageSelectionState<T> = {
    intended: getRestrictionUsageOptions([], catalog),
    active: [],
    frameworkOnly: true,
  };
  restrictionUsageSelections.set(toRaw(restriction), { frameworkId: restriction.arreteCadre?.id ?? null, state });
  return activateRestrictionUsageSelection(state, restriction.niveauGravite);
};

export const transferRestrictionUsageSelectionState = <T extends RestrictionUsageDefinition>(
  source: RestrictionUsageSelectionTarget<T>,
  target: RestrictionUsageSelectionTarget<T>,
): void => {
  const cached = restrictionUsageSelections.get(toRaw(source));
  const frameworkId = source.arreteCadre?.id ?? null;
  if (!cached || cached.frameworkId !== frameworkId || frameworkId !== (target.arreteCadre?.id ?? null)) {
    restrictionUsageSelections.delete(toRaw(target));
    return;
  }
  const sourceState = cached.state as RestrictionUsageSelectionState<T>;
  synchronizeRestrictionUsageSelection(source, sourceState);
  const state = {
    intended: [...sourceState.intended],
    active: [...sourceState.active],
    frameworkOnly: sourceState.frameworkOnly,
  };
  synchronizeRestrictionUsageSelection(target, state);
  restrictionUsageSelections.set(toRaw(target), { frameworkId, state });
};

export interface RestrictionUsageResetGroup<T extends RestrictionUsageDefinition> {
  name: string;
  before: T[];
  after: T[];
  change: 'added' | 'removed' | 'changed';
}

export const getRestrictionUsageResetPreview = <T extends RestrictionUsageDefinition>(
  selected: T[],
  catalog: T[],
  severity: string | null | undefined,
): { usages: T[]; groups: RestrictionUsageResetGroup<T>[] } => {
  const frameworkUsages = getRestrictionUsageOptions([], catalog);
  const usages = frameworkUsages.filter((usage) => hasUsageDescriptionForSeverity(usage, severity));
  const grouped = new Map<string, { name: string; before: T[]; after: T[] }>();
  const addToGroup = (usage: T, side: 'before' | 'after') => {
    const key = JSON.stringify([normalizeUsageTypography(usage.nom), usage.thematique?.id ?? null]);
    const group = grouped.get(key) ?? { name: usage.nom ?? '', before: [], after: [] };
    group[side].push(usage);
    grouped.set(key, group);
  };
  selected.forEach((usage) => addToGroup(usage, 'before'));
  frameworkUsages.forEach((usage) => addToGroup(usage, 'after'));
  const groups: RestrictionUsageResetGroup<T>[] = [];
  grouped.forEach((group) => {
    const remaining = [...group.after];
    const unchanged = group.before.length === group.after.length && group.before.every((usage) => {
      const index = remaining.findIndex((candidate) => haveEquivalentRestrictionUsageDefinition(candidate, usage));
      if (index < 0) {
        return false;
      }
      remaining.splice(index, 1);
      return true;
    });
    if (!unchanged) {
      groups.push({ ...group, change: group.before.length === 0 ? 'added' : group.after.length === 0 ? 'removed' : 'changed' });
    }
  });
  return { usages, groups };
};

export const replaceRestrictionUsageDefinition = <T extends RestrictionUsageDefinition>(
  usages: T[],
  source: RestrictionUsageDefinition,
  updated: RestrictionUsageDefinition,
): T[] =>
  usages.map((candidate) =>
    haveSameRestrictionUsageDefinition(candidate, source) ? ({ ...updated, id: candidate.id ?? null } as T) : candidate,
  );

export interface RestrictionUsageAssignment<T extends RestrictionUsageTarget> {
  restriction: T;
  usage: RestrictionUsageDefinition;
}

export const getUsageTargetAssignments = <T extends RestrictionUsageTarget>(
  restrictions: T[],
  frameworks: RestrictionUsageFramework[],
  usage: RestrictionUsageDefinition,
): RestrictionUsageAssignment<T>[] => {
  const matchingTemplatesByFrameworkId = new Map<number, RestrictionUsageDefinition>();
  frameworks.forEach((framework) => {
    if (framework.id == null) {
      return;
    }
    const template = framework.usages.find((candidate) => candidate.nom === usage.nom && candidate.thematique?.id === usage.thematique?.id);
    if (template) {
      matchingTemplatesByFrameworkId.set(framework.id, template);
    }
  });

  return restrictions.flatMap((restriction) => {
    const frameworkTemplate = matchingTemplatesByFrameworkId.get(restriction.arreteCadre?.id ?? -1);
    if (matchingTemplatesByFrameworkId.size > 0 && !frameworkTemplate) {
      return [];
    }
    const assignedUsage = frameworkTemplate ?? usage;
    const waterType = restriction.isAep ? 'AEP' : restriction.zoneAlerte?.type;
    if (!waterType || !concernsAnyWaterType(assignedUsage, [waterType])) {
      return [];
    }
    return [{ restriction, usage: assignedUsage }];
  });
};
