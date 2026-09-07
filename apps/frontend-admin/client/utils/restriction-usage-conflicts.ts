interface RestrictionUsageConflictSource {
  nom?: string | null;
  thematique?: { nom?: string | null } | null;
  concerneParticulier?: boolean;
  concerneEntreprise?: boolean;
  concerneCollectivite?: boolean;
  concerneExploitation?: boolean;
  concerneEso?: boolean;
  concerneEsu?: boolean;
  concerneAep?: boolean;
  descriptionVigilance?: string | null;
  descriptionAlerte?: string | null;
  descriptionAlerteRenforcee?: string | null;
  descriptionCrise?: string | null;
}

const profileFields = ['concerneParticulier', 'concerneEntreprise', 'concerneCollectivite', 'concerneExploitation'] as const;
const resourceFields = ['concerneEso', 'concerneEsu', 'concerneAep'] as const;
const descriptionFields = ['descriptionVigilance', 'descriptionAlerte', 'descriptionAlerteRenforcee', 'descriptionCrise'] as const;

export interface RestrictionUsageConflict {
  restrictionIndex: number;
  usageIndices: number[];
  usageName: string;
  differingFields: (typeof descriptionFields)[number][];
}

// Keep this normalization aligned with restriction.service.ts; parity is covered by tests.
const normalize = (value: string | null | undefined): string =>
  (value ?? '')
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u02BC\uFF07]/gu, "'")
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/gu, '-')
    .replace(/\s+/gu, ' ')
    .replace(/\by compris (?:le|la|les|des) /giu, 'y compris ')
    .trim()
    .toLocaleLowerCase('fr-FR');

export const findRestrictionUsageConflicts = (
  restrictions: readonly { usages?: readonly RestrictionUsageConflictSource[] | null }[] = [],
): RestrictionUsageConflict[] => {
  const conflicts: RestrictionUsageConflict[] = [];

  restrictions.forEach((restriction, restrictionIndex) => {
    const groups = new Map<string, { usage: RestrictionUsageConflictSource; index: number }[]>();
    (restriction.usages ?? []).forEach((usage, index) => {
      const theme = normalize(usage.thematique?.nom);
      const name = normalize(usage.nom);
      if (!theme || !name) {
        return;
      }
      const key = `${theme}\u0000${name}`;
      const group = groups.get(key) ?? [];
      group.push({ usage, index });
      groups.set(key, group);
    });

    groups.forEach((group) => {
      const conflictingIndices = new Set<number>();
      const differingFields = new Set<(typeof descriptionFields)[number]>();
      group.forEach(({ usage: first, index: firstIndex }, groupIndex) => {
        group.slice(groupIndex + 1).forEach(({ usage: second, index: secondIndex }) => {
          if (
            !profileFields.some((field) => first[field] === true && second[field] === true) ||
            !resourceFields.some((field) => first[field] === true && second[field] === true)
          ) {
            return;
          }
          const differences = descriptionFields.filter((field) => normalize(String(first[field] ?? '')) !== normalize(String(second[field] ?? '')));
          if (differences.length === 0) {
            return;
          }
          conflictingIndices.add(firstIndex);
          conflictingIndices.add(secondIndex);
          differences.forEach((field) => differingFields.add(field));
        });
      });
      if (conflictingIndices.size > 0) {
        conflicts.push({
          restrictionIndex,
          usageIndices: [...conflictingIndices].sort((first, second) => first - second),
          usageName: group[0].usage.nom!,
          differingFields: descriptionFields.filter((field) => differingFields.has(field)),
        });
      }
    });
  });

  return conflicts;
};
