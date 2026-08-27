import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, FindOneOptions, In, Not, Repository } from 'typeorm';
import { Commune } from '@shared/entities/commune.entity';
import { Restriction } from '@shared/entities/restriction.entity';
import { Usage } from '@shared/entities/usage.entity';
import { UsageService } from '../usage/usage.service';
import { CreateUpdateArreteRestrictionDto } from '../arrete_restriction/dto/create_update_arrete_restriction.dto';
import { CreateUpdateRestrictionDto } from './dto/create_update_restriction.dto';

const usageProfileFields = [
  'concerneParticulier',
  'concerneEntreprise',
  'concerneCollectivite',
  'concerneExploitation',
] as const satisfies readonly (keyof Usage)[];

const usageResourceFields = [
  'concerneEso',
  'concerneEsu',
  'concerneAep',
] as const satisfies readonly (keyof Usage)[];

const usageDescriptionFields = [
  'descriptionVigilance',
  'descriptionAlerte',
  'descriptionAlerteRenforcee',
  'descriptionCrise',
] as const satisfies readonly (keyof Usage)[];

const normalizeRestrictionUsageText = (value: string): string =>
  (value ?? '')
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u02BC\uFF07]/gu, "'")
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/gu, '-')
    .replace(/\s+/gu, ' ')
    .replace(/\by compris (?:le|la|les|des) /giu, 'y compris ')
    .trim()
    .toLocaleLowerCase('fr-FR');

export const normalizeRestrictionUsageLabel = normalizeRestrictionUsageText;

const usagesOverlapOn = (
  first: Usage,
  second: Usage,
  fields: readonly (keyof Usage)[],
): boolean =>
  fields.some((field) => first[field] === true && second[field] === true);

const usagesHaveDifferentDescriptions = (
  first: Usage,
  second: Usage,
): boolean =>
  usageDescriptionFields.some(
    (field) =>
      normalizeRestrictionUsageText(String(first[field] ?? '')) !==
      normalizeRestrictionUsageText(String(second[field] ?? '')),
  );

const getConflictingUsageLabels = (usages: Usage[] = []): string[] => {
  const usagesByLabel = new Map<string, Usage[]>();

  for (const usage of usages) {
    const theme = normalizeRestrictionUsageLabel(usage.thematique?.nom);
    const name = normalizeRestrictionUsageLabel(usage.nom);
    if (!theme || !name) {
      continue;
    }
    const key = `${theme}\u0000${name}`;
    usagesByLabel.set(key, [...(usagesByLabel.get(key) ?? []), usage]);
  }

  const conflicts: string[] = [];
  for (const groupedUsages of usagesByLabel.values()) {
    const hasConflict = groupedUsages.some((first, firstIndex) =>
      groupedUsages
        .slice(firstIndex + 1)
        .some(
          (second) =>
            usagesOverlapOn(first, second, usageProfileFields) &&
            usagesOverlapOn(first, second, usageResourceFields) &&
            usagesHaveDifferentDescriptions(first, second),
        ),
    );
    if (hasConflict) {
      conflicts.push(groupedUsages[0].nom);
    }
  }

  return conflicts;
};

@Injectable()
export class RestrictionService {
  constructor(
    @InjectRepository(Restriction)
    private readonly restrictionRepository: Repository<Restriction>,
    private readonly usageService: UsageService,
  ) {}

  async updateAll(
    arreteRestriction: CreateUpdateArreteRestrictionDto,
    arId: number,
    manager?: EntityManager,
  ): Promise<Restriction[]> {
    const repository = manager
      ? manager.getRepository(Restriction)
      : this.restrictionRepository;
    const shouldUpdateUsages = (arreteRestriction.restrictions ?? []).map(
      (restriction) =>
        !restriction.id ||
        Object.prototype.hasOwnProperty.call(restriction, 'usages'),
    );
    const restrictions = await this.normalizeAndValidate(
      arreteRestriction,
      manager ?? repository.manager,
    );
    const restrictionsId = restrictions
      .map(({ id }) => id)
      .filter((id): id is number => id !== null && id !== undefined);
    if (
      restrictionsId.some((id) => !Number.isInteger(id) || id <= 0) ||
      new Set(restrictionsId).size !== restrictionsId.length
    ) {
      throw new BadRequestException(
        `Les identifiants des restrictions à modifier sont invalides.`,
      );
    }
    if (restrictionsId.length > 0) {
      const ownedRestrictions: Array<{ id: number | string }> = await (
        manager ?? repository.manager
      ).query(
        `
          SELECT restriction.id
          FROM restriction
          WHERE restriction.id = ANY($1::integer[])
            AND restriction."arreteRestrictionId" = $2
          FOR UPDATE
        `,
        [restrictionsId, arId],
      );
      const ownedIds = new Set(ownedRestrictions.map(({ id }) => Number(id)));
      if (
        ownedIds.size !== restrictionsId.length ||
        restrictionsId.some((id) => !ownedIds.has(id))
      ) {
        throw new BadRequestException(
          `Une restriction à modifier n'appartient pas à cet arrêté de restriction.`,
        );
      }
    }
    if (restrictionsId.length > 0) {
      await repository.delete({
        arreteRestriction: {
          id: arId,
        },
        id: Not(In(restrictionsId)),
      });
    } else {
      await repository.delete({
        arreteRestriction: {
          id: arId,
        },
      });
    }
    const restrictionsToSave = restrictions.map((restriction) => ({
      ...restriction,
      arreteRestriction: { id: arId },
    }));
    const rToReturn: Restriction[] = await repository.save(
      restrictionsToSave as unknown as Restriction[],
    );
    await Promise.all(
      rToReturn.map(async (r, index) => {
        r.usages = shouldUpdateUsages[index]
          ? await this.usageService.updateAllByRestriction(r, manager)
          : await this.usageService.findByRestriction(r.id, manager);
        return r;
      }),
    );
    return rToReturn;
  }

  getPublicationValidationErrors(
    restrictions: Array<
      Pick<
        Restriction,
        | 'zoneAlerte'
        | 'arreteCadre'
        | 'nomGroupementAep'
        | 'communes'
        | 'niveauGravite'
        | 'usages'
      > & { isAep?: boolean }
    >,
    arreteCadreIds?: readonly number[],
  ): string[] {
    const errors: string[] = [];
    const allowedArreteCadreIds = arreteCadreIds
      ? new Set(arreteCadreIds)
      : null;
    const groupNames = new Set<string>();
    const communeIds = new Set<number>();

    for (const restriction of restrictions ?? []) {
      for (const usageName of getConflictingUsageLabels(
        restriction.usages ?? [],
      )) {
        errors.push(
          `L'usage « ${usageName} » possède des consignes contradictoires pour des profils et ressources identiques dans une même zone.`,
        );
      }
      if (!restriction.niveauGravite) {
        errors.push(`Chaque zone de l'arrêté doit avoir un niveau de gravité.`);
      }
      if (!restriction.arreteCadre?.id) {
        errors.push(`Chaque zone doit être liée à un arrêté cadre.`);
      } else if (
        allowedArreteCadreIds &&
        !allowedArreteCadreIds.has(restriction.arreteCadre.id)
      ) {
        errors.push(
          `Chaque zone doit être liée à un arrêté cadre associé à cet arrêté de restriction.`,
        );
      }
      const isAep =
        typeof restriction.isAep === 'boolean'
          ? restriction.isAep
          : !restriction.zoneAlerte;
      if (!isAep) {
        if (!restriction.zoneAlerte?.id) {
          errors.push(
            `Chaque restriction hors eau potable doit être liée à une zone d'alerte.`,
          );
        }
        continue;
      }

      const normalizedName = restriction.nomGroupementAep
        ?.trim()
        .normalize('NFKC')
        .toLocaleLowerCase('fr-FR');
      if (!normalizedName) {
        errors.push(
          `Le nom de chaque groupement d'eau potable est obligatoire.`,
        );
      } else if (groupNames.has(normalizedName)) {
        errors.push(
          `Les noms des groupements d'eau potable doivent être uniques.`,
        );
      } else {
        groupNames.add(normalizedName);
      }
      if (!restriction.communes?.length) {
        errors.push(
          `Chaque groupement d'eau potable doit contenir au moins une commune.`,
        );
        continue;
      }
      for (const commune of restriction.communes) {
        if (communeIds.has(commune.id)) {
          errors.push(
            `Une commune ne peut appartenir qu'à un seul groupement d'eau potable.`,
          );
          break;
        }
        communeIds.add(commune.id);
      }
    }

    return [...new Set(errors)];
  }

  async getZoneAlerteRelationValidationErrors(
    restrictions: Array<{
      zoneAlerte?: { id: number } | null;
      arreteCadre?: { id: number } | null;
      isAep?: boolean;
    }>,
    departementId: number | null | undefined,
    manager: EntityManager = this.restrictionRepository.manager,
  ): Promise<string[]> {
    const relations = (restrictions ?? [])
      .filter((restriction) => {
        const isAep =
          typeof restriction.isAep === 'boolean'
            ? restriction.isAep
            : !restriction.zoneAlerte;
        return (
          !isAep &&
          restriction.arreteCadre?.id !== null &&
          restriction.arreteCadre?.id !== undefined &&
          restriction.zoneAlerte?.id !== null &&
          restriction.zoneAlerte?.id !== undefined
        );
      })
      .map((restriction) => ({
        arreteCadreId: restriction.arreteCadre.id,
        zoneAlerteId: restriction.zoneAlerte.id,
      }));
    if (relations.length === 0) {
      return [];
    }
    if (!Number.isInteger(departementId) || departementId <= 0) {
      return [`Le département de l'arrêté de restriction est obligatoire.`];
    }

    const arreteCadreIds = [
      ...new Set(relations.map(({ arreteCadreId }) => arreteCadreId)),
    ];
    const zoneAlerteIds = [
      ...new Set(relations.map(({ zoneAlerteId }) => zoneAlerteId)),
    ];
    const linkedZones: Array<{
      arreteCadreId: number | string;
      zoneAlerteId: number | string;
      departementId: number | string;
    }> = await manager.query(
      `
        SELECT
          link."arreteCadreId" AS "arreteCadreId",
          link."zoneAlerteId" AS "zoneAlerteId",
          zone."departementId" AS "departementId"
        FROM arrete_cadre_zone_alerte link
        JOIN zone_alerte zone ON zone.id = link."zoneAlerteId"
        WHERE link."arreteCadreId" = ANY($1::integer[])
          AND link."zoneAlerteId" = ANY($2::integer[])
        FOR KEY SHARE OF link, zone
      `,
      [arreteCadreIds, zoneAlerteIds],
    );
    const linkedByPair = new Map(
      linkedZones.map((row) => [
        `${Number(row.arreteCadreId)}:${Number(row.zoneAlerteId)}`,
        Number(row.departementId),
      ]),
    );
    const errors: string[] = [];
    for (const { arreteCadreId, zoneAlerteId } of relations) {
      const linkedDepartementId = linkedByPair.get(
        `${arreteCadreId}:${zoneAlerteId}`,
      );
      if (linkedDepartementId === undefined) {
        errors.push(
          `Chaque zone d'alerte hors eau potable doit appartenir à l'arrêté cadre de sa restriction.`,
        );
      } else if (linkedDepartementId !== departementId) {
        errors.push(
          `Chaque zone d'alerte hors eau potable doit appartenir au département de l'arrêté de restriction.`,
        );
      }
    }
    return [...new Set(errors)];
  }

  private async normalizeAndValidate(
    arreteRestriction: CreateUpdateArreteRestrictionDto,
    manager: EntityManager,
  ): Promise<CreateUpdateRestrictionDto[]> {
    const restrictions = (arreteRestriction.restrictions ?? []).map(
      (restriction) => ({
        ...restriction,
        usages:
          !restriction.id ||
          Object.prototype.hasOwnProperty.call(restriction, 'usages')
            ? [...(restriction.usages ?? [])]
            : undefined,
        communes: restriction.isAep ? [...(restriction.communes ?? [])] : null,
        zoneAlerte: restriction.isAep ? null : restriction.zoneAlerte,
        nomGroupementAep: restriction.isAep
          ? restriction.nomGroupementAep?.trim()
          : null,
      }),
    );
    const arreteCadreIds = new Set(
      (arreteRestriction.arretesCadre ?? []).map(({ id }) => id),
    );
    const groupNames = new Set<string>();
    const communeIds = new Set<number>();

    for (const restriction of restrictions) {
      const [conflictingUsage] = getConflictingUsageLabels(
        (restriction.usages ?? []) as Usage[],
      );
      if (conflictingUsage) {
        throw new BadRequestException(
          `L'usage « ${conflictingUsage} » possède des consignes contradictoires pour des profils et ressources identiques dans une même zone.`,
        );
      }
      if (
        restriction.arreteCadre?.id &&
        !arreteCadreIds.has(restriction.arreteCadre.id)
      ) {
        throw new BadRequestException(
          `Une restriction est liée à un arrêté cadre qui n'appartient pas à cet arrêté de restriction.`,
        );
      }
      if (!restriction.isAep) {
        continue;
      }

      const normalizedName = restriction.nomGroupementAep
        ?.normalize('NFKC')
        .toLocaleLowerCase('fr-FR');
      if (normalizedName) {
        if (groupNames.has(normalizedName)) {
          throw new BadRequestException(
            `Les noms des groupements d'eau potable doivent être uniques.`,
          );
        }
        groupNames.add(normalizedName);
      }

      if (!restriction.communes?.length) {
        continue;
      }
      for (const commune of restriction.communes) {
        if (!Number.isInteger(commune.id) || commune.id <= 0) {
          throw new BadRequestException(
            `Chaque commune d'un groupement d'eau potable doit avoir un identifiant valide.`,
          );
        }
        if (communeIds.has(commune.id)) {
          throw new BadRequestException(
            `Une commune ne peut appartenir qu'à un seul groupement d'eau potable.`,
          );
        }
        communeIds.add(commune.id);
      }
    }

    if (communeIds.size > 0) {
      const departementId = arreteRestriction.departement?.id;
      if (!departementId) {
        throw new BadRequestException(
          `Le département de l'arrêté de restriction est obligatoire.`,
        );
      }
      const communes = await manager.getRepository(Commune).find({
        select: { id: true },
        where: {
          id: In([...communeIds]),
          departement: { id: departementId },
        },
      });
      const validIds = new Set(communes.map(({ id }) => id));
      if (
        validIds.size !== communeIds.size ||
        [...communeIds].some((id) => !validIds.has(id))
      ) {
        throw new BadRequestException(
          `Toutes les communes des groupements d'eau potable doivent appartenir au département de l'arrêté.`,
        );
      }
    }

    const relationErrors = await this.getZoneAlerteRelationValidationErrors(
      restrictions,
      arreteRestriction.departement?.id,
      manager,
    );
    if (relationErrors.length > 0) {
      throw new BadRequestException(relationErrors[0]);
    }

    return restrictions;
  }

  async deleteZonesByArreteCadreId(
    zonesId: number[],
    acId: number,
    manager?: EntityManager,
  ) {
    if (zonesId.length < 1) {
      return;
    }
    const repository = manager
      ? manager.getRepository(Restriction)
      : this.restrictionRepository;
    const restrictionIds = await repository
      .createQueryBuilder('restriction')
      .select('restriction.id')
      .leftJoin('restriction.arreteRestriction', 'arreteRestriction')
      .leftJoin('arreteRestriction.arretesCadre', 'arretesCadre')
      .leftJoin('restriction.zoneAlerte', 'zoneAlerte')
      .where('arretesCadre.id = :acId', { acId: acId })
      .andWhere('arreteRestriction.statut != :statut', { statut: 'abroge' })
      .andWhere('zoneAlerte.id IN (:...zonesId)', { zonesId: zonesId })
      .getMany();
    return repository.delete({
      id: In(restrictionIds.map((r) => r.id)),
    });
  }

  async findOneByZoneAlerteComputed(
    zoneAlerteComputedId: number,
  ): Promise<Restriction> {
    return this.restrictionRepository.findOne(<FindOneOptions>{
      relations: ['arreteRestriction', 'zonesAlerteComputed'],
      where: {
        zonesAlerteComputed: {
          id: zoneAlerteComputedId,
        },
      },
    });
  }

  async findOneByZoneAlerteComputedHistoric(
    zoneAlerteComputedId: number,
  ): Promise<Restriction> {
    return this.restrictionRepository.findOne(<FindOneOptions>{
      relations: ['arreteRestriction', 'zonesAlerteComputedHistoric'],
      where: {
        zonesAlerteComputedHistoric: {
          id: zoneAlerteComputedId,
        },
      },
    });
  }
}
