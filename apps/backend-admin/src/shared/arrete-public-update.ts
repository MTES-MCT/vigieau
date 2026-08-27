import type { ArreteCadre } from '@shared/entities/arrete_cadre.entity';
import type { ArreteRestriction } from '@shared/entities/arrete_restriction.entity';
import type { Restriction } from '@shared/entities/restriction.entity';
import type { Usage } from '@shared/entities/usage.entity';
import type { CreateUpdateArreteCadreDto } from '../arrete_cadre/dto/create_update_arrete_cadre.dto';
import type { CreateUpdateArreteRestrictionDto } from '../arrete_restriction/dto/create_update_arrete_restriction.dto';
import type { CreateUpdateRestrictionDto } from '../restriction/dto/create_update_restriction.dto';
import type { CreateUpdateUsageDto } from '../usage/dto/create_usage.dto';

type Identified = { id?: number | null };

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const normalizeOptional = <T>(value: T | null | undefined): T | null =>
  value ?? null;

const canonicalizeList = <T>(
  values: readonly T[] | null | undefined,
  canonicalize: (value: T) => unknown,
): unknown[] =>
  [...(values ?? [])]
    .map(canonicalize)
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );

const canonicalizeIds = (
  values: readonly Identified[] | null | undefined,
): number[] =>
  [...(values ?? [])]
    .map(({ id }) => Number(id))
    .sort((left, right) => left - right);

const canonicalizeUsage = (
  usage: Partial<Usage> | CreateUpdateUsageDto,
  current?: Partial<Usage>,
) => {
  const requested = usage as Partial<Usage>;
  const value = <K extends keyof Usage>(key: K): Partial<Usage>[K] =>
    hasOwn(requested, key) && requested[key] !== undefined
      ? requested[key]
      : current?.[key];

  return {
    id: normalizeOptional(value('id')),
    nom: normalizeOptional(value('nom')),
    thematiqueId: normalizeOptional(value('thematique')?.id),
    concerneParticulier: normalizeOptional(value('concerneParticulier')),
    concerneEntreprise: normalizeOptional(value('concerneEntreprise')),
    concerneCollectivite: normalizeOptional(value('concerneCollectivite')),
    concerneExploitation: normalizeOptional(value('concerneExploitation')),
    concerneEso: normalizeOptional(value('concerneEso')),
    concerneEsu: normalizeOptional(value('concerneEsu')),
    concerneAep: normalizeOptional(value('concerneAep')),
    descriptionVigilance: normalizeOptional(value('descriptionVigilance')),
    descriptionAlerte: normalizeOptional(value('descriptionAlerte')),
    descriptionAlerteRenforcee: normalizeOptional(
      value('descriptionAlerteRenforcee'),
    ),
    descriptionCrise: normalizeOptional(value('descriptionCrise')),
  };
};

const canonicalizeUsages = (
  usages: readonly (Partial<Usage> | CreateUpdateUsageDto)[] | null | undefined,
  current?: readonly Partial<Usage>[] | null,
): unknown[] => {
  const currentById = new Map(
    (current ?? []).map((usage) => [usage.id, usage]),
  );
  return canonicalizeList(usages, (usage) =>
    canonicalizeUsage(usage, usage.id ? currentById.get(usage.id) : undefined),
  );
};

const canonicalizePersistedRestriction = (
  restriction: Partial<Restriction>,
) => {
  const isAep = !restriction.zoneAlerte;

  return {
    id: normalizeOptional(restriction.id),
    isAep,
    nomGroupementAep: isAep
      ? normalizeOptional(restriction.nomGroupementAep?.trim())
      : null,
    zoneAlerteId: isAep ? null : normalizeOptional(restriction.zoneAlerte?.id),
    arreteCadreId: normalizeOptional(restriction.arreteCadre?.id),
    niveauGravite: normalizeOptional(restriction.niveauGravite),
    communeIds: isAep ? canonicalizeIds(restriction.communes) : [],
    usages: canonicalizeUsages(restriction.usages),
  };
};

const canonicalizeRequestedRestriction = (
  restriction: CreateUpdateRestrictionDto,
  current?: Restriction,
) => {
  // RestrictionService.normalizeAndValidate treats an omitted isAep as false.
  const isAep = restriction.isAep === true;
  const usages = hasOwn(restriction, 'usages')
    ? restriction.usages
    : current?.usages;

  return {
    id: normalizeOptional(restriction.id),
    isAep,
    nomGroupementAep: isAep
      ? normalizeOptional(
          hasOwn(restriction, 'nomGroupementAep')
            ? restriction.nomGroupementAep?.trim()
            : current?.nomGroupementAep?.trim(),
        )
      : null,
    zoneAlerteId: isAep
      ? null
      : normalizeOptional(
          hasOwn(restriction, 'zoneAlerte')
            ? restriction.zoneAlerte?.id
            : current?.zoneAlerte?.id,
        ),
    arreteCadreId: normalizeOptional(
      hasOwn(restriction, 'arreteCadre')
        ? restriction.arreteCadre?.id
        : current?.arreteCadre?.id,
    ),
    niveauGravite: normalizeOptional(
      hasOwn(restriction, 'niveauGravite')
        ? restriction.niveauGravite
        : current?.niveauGravite,
    ),
    communeIds: isAep ? canonicalizeIds(restriction.communes) : [],
    usages: canonicalizeUsages(usages, current?.usages),
  };
};

const canonicalizeRestrictions = (
  current: readonly Restriction[] | null | undefined,
  requested?: readonly CreateUpdateRestrictionDto[] | null,
): unknown[] => {
  const currentById = new Map(
    (current ?? []).map((restriction) => [restriction.id, restriction]),
  );
  return requested
    ? canonicalizeList(requested, (restriction) =>
        canonicalizeRequestedRestriction(
          restriction,
          restriction.id ? currentById.get(restriction.id) : undefined,
        ),
      )
    : canonicalizeList(current ?? [], canonicalizePersistedRestriction);
};

const canonicalizeZones = (
  zones:
    | readonly {
        id?: number | null;
        communes?: readonly Identified[] | null;
      }[]
    | null
    | undefined,
): unknown[] =>
  canonicalizeList(zones, (zone) => ({
    id: normalizeOptional(zone.id),
    communeIds: canonicalizeIds(zone.communes),
  }));

export function hasArreteRestrictionPublicUpdate(
  current: ArreteRestriction,
  requested: Partial<CreateUpdateArreteRestrictionDto>,
): boolean {
  if (hasOwn(requested, 'numero') && requested.numero !== current.numero) {
    return true;
  }
  if (
    hasOwn(requested, 'departement') &&
    requested.departement?.id !== current.departement?.id
  ) {
    return true;
  }
  if (
    hasOwn(requested, 'niveauGraviteSpecifiqueEap') &&
    requested.niveauGraviteSpecifiqueEap !== current.niveauGraviteSpecifiqueEap
  ) {
    return true;
  }
  if (
    hasOwn(requested, 'ressourceEapCommunique') &&
    requested.ressourceEapCommunique !== current.ressourceEapCommunique
  ) {
    return true;
  }
  if (
    hasOwn(requested, 'arreteRestrictionAbroge') &&
    requested.arreteRestrictionAbroge?.id !==
      current.arreteRestrictionAbroge?.id
  ) {
    return true;
  }
  if (
    hasOwn(requested, 'arretesCadre') &&
    JSON.stringify(canonicalizeIds(requested.arretesCadre)) !==
      JSON.stringify(canonicalizeIds(current.arretesCadre))
  ) {
    return true;
  }
  return (
    hasOwn(requested, 'restrictions') &&
    JSON.stringify(
      canonicalizeRestrictions(current.restrictions, requested.restrictions),
    ) !== JSON.stringify(canonicalizeRestrictions(current.restrictions))
  );
}

export function hasArreteCadrePublicUpdate(
  current: ArreteCadre,
  requested: Partial<CreateUpdateArreteCadreDto>,
): boolean {
  if (hasOwn(requested, 'numero') && requested.numero !== current.numero) {
    return true;
  }
  if (
    hasOwn(requested, 'arreteCadreAbroge') &&
    requested.arreteCadreAbroge?.id !== current.arreteCadreAbroge?.id
  ) {
    return true;
  }
  if (
    hasOwn(requested, 'departements') &&
    JSON.stringify(canonicalizeIds(requested.departements)) !==
      JSON.stringify(canonicalizeIds(current.departements))
  ) {
    return true;
  }
  if (
    requested.departements?.length > 1 &&
    requested.departements[0].id !== current.departementPilote?.id
  ) {
    return true;
  }
  if (
    hasOwn(requested, 'zonesAlerte') &&
    JSON.stringify(canonicalizeZones(requested.zonesAlerte)) !==
      JSON.stringify(canonicalizeZones(current.zonesAlerte))
  ) {
    return true;
  }
  return (
    hasOwn(requested, 'usages') &&
    JSON.stringify(canonicalizeUsages(requested.usages, current.usages)) !==
      JSON.stringify(canonicalizeUsages(current.usages))
  );
}
