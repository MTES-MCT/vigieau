import type { Usage } from '../dto/usage.dto';

export interface PublicRestrictionUsageConflict {
  nom: string;
  thematique: string;
}

export interface PublicRestrictionUsageResolution {
  usages: Usage[];
  conflicts: PublicRestrictionUsageConflict[];
}

export const normalizeRestrictionUsageLabel = (value: string): string =>
  (value ?? '')
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u02BC\uFF07]/gu, "'")
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/gu, '-')
    .replace(/\s+/gu, ' ')
    .replace(/\by compris (?:le|la|les|des) /giu, 'y compris ')
    .trim()
    .toLocaleLowerCase('fr-FR');

export const resolvePublicRestrictionUsages = (
  usages: Usage[],
): PublicRestrictionUsageResolution => {
  const usagesByLabel = new Map<string, Usage[]>();

  for (const [index, usage] of (usages ?? []).entries()) {
    const theme = normalizeRestrictionUsageLabel(usage.thematique);
    const name = normalizeRestrictionUsageLabel(usage.nom);
    const key = theme && name ? `${theme}\u0000${name}` : `usage:${index}`;
    usagesByLabel.set(key, [...(usagesByLabel.get(key) ?? []), usage]);
  }

  const resolvedUsages: Usage[] = [];
  const conflicts: PublicRestrictionUsageConflict[] = [];
  for (const groupedUsages of usagesByLabel.values()) {
    const descriptions = new Set(
      groupedUsages.map((usage) =>
        normalizeRestrictionUsageLabel(usage.description ?? ''),
      ),
    );
    if (descriptions.size > 1) {
      conflicts.push({
        nom: groupedUsages[0].nom,
        thematique: groupedUsages[0].thematique,
      });
      continue;
    }
    resolvedUsages.push(groupedUsages[0]);
  }

  return { usages: resolvedUsages, conflicts };
};
