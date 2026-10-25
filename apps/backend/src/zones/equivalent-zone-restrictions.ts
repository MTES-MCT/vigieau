type EvidenceRecord = Record<string, unknown>;

const profileFields = [
  'concerneParticulier',
  'concerneEntreprise',
  'concerneCollectivite',
  'concerneExploitation',
] as const;

const sourceIdentityFields = new Set([
  'id',
  'idSandre',
  'code',
  'nom',
  'gid',
  'CdZAS',
  'LbZAS',
]);

function isRecord(value: unknown): value is EvidenceRecord {
  return (
    value !== null &&
    typeof value === 'object' &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isDate(value: unknown): boolean {
  return value instanceof Date
    ? Number.isFinite(value.getTime())
    : isText(value) && Number.isFinite(Date.parse(value));
}

// Do not let JSON.stringify silently erase undefined, non-finite numbers or
// unsupported values: missing evidence must never establish equivalence.
function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return JSON.stringify(value.toISOString());
  }
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${Array.from(value, canonicalJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  throw new Error('Incomplete zone restriction evidence');
}

function restrictionEvidence(zone: unknown): string | null {
  if (
    !isRecord(zone) ||
    !['SUP', 'SOU', 'AEP'].includes(zone.type as string) ||
    !isText(zone.departement) ||
    zone.ressourceInfluencee !== false ||
    !['vigilance', 'alerte', 'alerte_renforcee', 'crise'].includes(
      zone.niveauGravite as string,
    ) ||
    !isRecord(zone.arrete) ||
    !Number.isSafeInteger(zone.arrete.id) ||
    Number(zone.arrete.id) <= 0 ||
    !isDate(zone.arrete.dateDebutValidite) ||
    (zone.arrete.dateFinValidite !== null &&
      !isDate(zone.arrete.dateFinValidite)) ||
    !isText(zone.arrete.cheminFichier) ||
    !isText(zone.arrete.cheminFichierArreteCadre) ||
    !Array.isArray(zone.usages) ||
    zone.usages.length === 0
  ) {
    return null;
  }

  const usages: string[] = [];
  for (const usage of zone.usages) {
    if (
      !isRecord(usage) ||
      !isText(usage.nom) ||
      !isText(usage.thematique) ||
      !isText(usage.description) ||
      !profileFields.every((field) => typeof usage[field] === 'boolean')
    ) {
      return null;
    }
    // Preserve every prescription field, including future additions. Only the
    // technical usage ID and the order of the complete usage list may differ.
    usages.push(
      canonicalJson(
        Object.fromEntries(
          Object.entries(usage).filter(([key]) => key !== 'id'),
        ),
      ),
    );
  }

  return canonicalJson({
    // Coordinates have already established coverage. Preserve any additional
    // prescription fields instead of silently ignoring future payload changes.
    ...Object.fromEntries(
      Object.entries(zone).filter(
        ([key]) => !sourceIdentityFields.has(key) && key !== 'usages',
      ),
    ),
    usages: usages.sort(),
  });
}

/** Compare unfiltered prescriptions, without choosing or merging a source zone. */
export function haveEquivalentZoneRestrictions(
  zones: readonly unknown[],
): boolean {
  if (zones.length < 2) return false;
  try {
    const reference = restrictionEvidence(zones[0]);
    return (
      reference !== null &&
      zones.slice(1).every((zone) => restrictionEvidence(zone) === reference)
    );
  } catch {
    return false;
  }
}
