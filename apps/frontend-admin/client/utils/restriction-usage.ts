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

const usageDefinitionFields = [
  'concerneParticulier',
  'concerneEntreprise',
  'concerneCollectivite',
  'concerneExploitation',
  'concerneEso',
  'concerneEsu',
  'concerneAep',
  'descriptionVigilance',
  'descriptionAlerte',
  'descriptionAlerteRenforcee',
  'descriptionCrise',
] as const satisfies readonly (keyof RestrictionUsageDefinition)[];

export const haveSameRestrictionUsageDefinition = (first: RestrictionUsageDefinition, second: RestrictionUsageDefinition): boolean =>
  first.nom === second.nom &&
  (first.thematique?.id ?? null) === (second.thematique?.id ?? null) &&
  usageDefinitionFields.every((field) => (first[field] ?? null) === (second[field] ?? null));

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
