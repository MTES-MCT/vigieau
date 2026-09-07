const levels = ['vigilance', 'alerte', 'alerte_renforcee', 'crise'];

const isRecord = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isSeverity = (value: unknown) => value === null || levels.includes(value as string);

export function isAreaStatisticSeries(value: unknown, waterType: string): value is any[] {
  return Array.isArray(value) && value.every((row) =>
    isRecord(row) && typeof row.date === 'string' && isRecord(row[waterType]) &&
    levels.every((level) => {
      const amount = row[waterType][level];
      return (typeof amount === 'number' || (typeof amount === 'string' && amount.trim() !== '')) &&
        Number.isFinite(Number(amount));
    }),
  );
}

export function isDepartmentStatisticSeries(value: unknown): value is any[] {
  return Array.isArray(value) && value.every((row) =>
    isRecord(row) && typeof row.date === 'string' && Array.isArray(row.departements) &&
    row.departements.every((department) => isRecord(department) &&
      ['niveauGravite', 'niveauGraviteSup', 'niveauGraviteSou', 'niveauGraviteAep']
        .every((field) => isSeverity(department[field]))),
  );
}

export function isCommuneStatisticData(value: unknown): value is { commune: { nom: string }; restrictions: any[] } {
  return isRecord(value) && isRecord(value.commune) && typeof value.commune.nom === 'string' &&
    Array.isArray(value.restrictions) && value.restrictions.every((row) =>
      isRecord(row) && typeof row.date === 'string' &&
      ['AEP', 'SUP', 'SOU'].every((waterType) => isSeverity(row[waterType])),
    );
}
