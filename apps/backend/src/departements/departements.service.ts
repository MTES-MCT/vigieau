import {
  HttpException,
  HttpStatus,
  Injectable,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindManyOptions, Repository } from 'typeorm';
import { Departement } from '@shared/entities/departement.entity';
import { VigieauLogger } from '../logger/vigieau.logger';
import {
  DepartementDto,
  type DepartementAvailabilityStatus,
  type DepartementZoneAvailabilityDto,
} from './dto/departement.dto';
import { Statistic } from '@shared/entities/statistic.entity';
import { Utils } from '../core/utils';
import { max } from 'lodash';
import { Region } from '@shared/entities/region.entity';
import { BassinVersant } from '@shared/entities/bassin_versant.entity';
import { ZonePublication } from '@shared/entities/zone_publication.entity';
import { ZonePublicationAggregate } from '@shared/entities/zone_publication_aggregate.entity';
import { type ZonePublicationAggregatePayload } from '@shared/zone_publication_materialization';
import { isUUID } from 'class-validator';
import { getStatisticPublicationExpectation } from '../data/statistic-publication-freshness';

type DepartementAvailabilityRow = {
  sourcePublicRevision: string | null;
  departmentCode: string | null;
  zoneType: string | null;
  status: DepartementAvailabilityStatus | null;
  asOf: Date | string | null;
  availabilityPublicRevision: string | null;
  officialUrl: string | null;
};

type DepartementAvailabilityContext = {
  sourcePublicRevision: string | null;
  certifications: Map<string, DepartementAvailabilityRow>;
};

const OFFICIAL_AEP_URLS: Readonly<Record<string, string>> = Object.freeze({
  '49': 'https://www.maine-et-loire.gouv.fr/Actions-de-l-Etat/Eau-et-Environnement/Eau-et-milieux-aquatiques/Les-restrictions-en-eau-liees-a-la-secheresse',
  '79': 'https://www.deux-sevres.gouv.fr/Publications/Annonces-et-avis/Arretes-de-restriction-d-eau-prelevee-a-partir-du-reseau-d-eau-potable',
});

const RESTRICTION_LEVELS = new Set([
  'vigilance',
  'alerte',
  'alerte_renforcee',
  'crise',
]);

export const getCurrentDepartementDateKeys = (now = new Date()): Set<string> =>
  new Set([
    now.toISOString().slice(0, 10),
    getStatisticPublicationExpectation(now).today,
  ]);

@Injectable()
export class DepartementsService {
  private readonly logger = new VigieauLogger('DepartementsService');
  situationDepartements: any[] = [];
  departements: any[];
  regions: Region[];
  bassinsVersants: BassinVersant[];
  private situationLoadGeneration = 0;
  private readonly situationLoadMaxAttempts = 3;
  private readonly situationLoadRetryDelayMs = 100;

  constructor(
    @InjectRepository(Departement)
    private readonly departementRepository: Repository<Departement>,
    @InjectRepository(Statistic)
    private readonly statisticRepository: Repository<Statistic>,
    @InjectRepository(Region)
    private readonly regionRepository: Repository<Region>,
    @InjectRepository(BassinVersant)
    private readonly bassinVersantRepository: Repository<BassinVersant>,
    @Optional()
    @InjectRepository(ZonePublication)
    private readonly zonePublicationRepository?: Repository<ZonePublication>,
    @Optional()
    @InjectRepository(ZonePublicationAggregate)
    private readonly zonePublicationAggregateRepository?: Repository<ZonePublicationAggregate>,
  ) {
    this.loadRefData();
  }

  /**
   * Récupère une liste simplifiée des départements.
   * Retourne uniquement les champs nécessaires pour des cas d'usage rapide.
   */
  async getAllLight(): Promise<Departement[]> {
    return this.departementRepository.find(<FindManyOptions>{
      select: {
        id: true,
        code: true,
        region: {
          id: true,
          code: true,
        },
      },
      relations: ['region'],
    });
  }

  /**
   * Retourne la situation des départements pour une date donnée et des critères facultatifs.
   * @param date - Date pour la situation (format YYYY-MM-DD)
   * @param bassinVersant - ID du bassin versant
   * @param region - ID de la région
   * @param departement - ID du département
   */
  situationByDepartement(
    date?: string,
    bassinVersant?: string,
    region?: string,
    departement?: string,
    publicationId?: string,
  ): DepartementDto[] | Promise<DepartementDto[]> {
    if (publicationId) {
      return this.situationByPublication(
        publicationId,
        bassinVersant,
        region,
        departement,
      );
    }
    const searchDate = date || new Date().toISOString().split('T')[0];

    const situationDepartement = this.situationDepartements.find(
      (s) => s.date === searchDate,
    );
    if (!situationDepartement) {
      throw new HttpException(`Date non disponible.`, HttpStatus.NOT_FOUND);
    }

    return this.filterSituation(
      situationDepartement.departementSituation,
      bassinVersant,
      region,
      departement,
    );
  }

  async situationByDepartementWithAvailability(
    date?: string,
    bassinVersant?: string,
    region?: string,
    departement?: string,
    publicationId?: string,
  ): Promise<DepartementDto[]> {
    const situation = await this.situationByDepartement(
      date,
      bassinVersant,
      region,
      departement,
      publicationId,
    );
    if (!publicationId && date && !getCurrentDepartementDateKeys().has(date)) {
      return situation;
    }

    const context = await this.loadDepartementAvailability(publicationId);
    return situation.map((department) => ({
      ...department,
      availability: {
        AEP: this.buildDepartementAepAvailability(
          department,
          context.sourcePublicRevision,
          context.certifications.get(`${department.code}:AEP`),
        ),
      },
    }));
  }

  private filterSituation(
    situation: DepartementDto[],
    bassinVersant?: string,
    region?: string,
    departement?: string,
  ): DepartementDto[] {
    if (bassinVersant) {
      const b = this.bassinsVersants.find((b) => b.id === +bassinVersant);
      if (!b) {
        throw new HttpException(
          `Bassin versant non trouvé.`,
          HttpStatus.NOT_FOUND,
        );
      }
      return situation.filter((d) =>
        b.departements.some((dep) => dep.code === d.code),
      );
    }

    if (region) {
      const r = this.regions.find((r) => r.id === +region);
      if (!r) {
        throw new HttpException(`Région non trouvée.`, HttpStatus.NOT_FOUND);
      }
      return situation.filter((d) =>
        r.departements.some((dep) => dep.code === d.code),
      );
    }

    if (departement) {
      const d = this.departements.find((d) => d.id === +departement);
      if (!d) {
        throw new HttpException(
          `Département non trouvé.`,
          HttpStatus.NOT_FOUND,
        );
      }
      return situation.filter((ds) => d.code === ds.code);
    }
    return situation;
  }

  /**
   * Charge les données de référence (départements, régions, bassins versants) en mémoire.
   */
  async loadRefData(): Promise<void> {
    this.departements = await this.departementRepository.find({
      relations: ['region'],
      order: {
        nom: 'ASC',
      },
    });
    this.regions = await this.regionRepository.find({
      relations: ['departements'],
      order: {
        nom: 'ASC',
      },
    });
    this.bassinsVersants = await this.bassinVersantRepository.find({
      relations: ['departements'],
      order: {
        nom: 'ASC',
      },
    });
  }

  /**
   * Charge la situation des départements en mémoire à partir des statistiques.
   * @param currentZones - Liste des zones actuelles (fournies dynamiquement)
   */
  async loadSituation(currentZones) {
    this.logger.log('LOAD SITUATION DEPARTEMENTS - BEGIN');
    const generation = ++this.situationLoadGeneration;
    let lastError: unknown;

    for (
      let attempt = 1;
      attempt <= this.situationLoadMaxAttempts;
      attempt += 1
    ) {
      if (generation !== this.situationLoadGeneration) {
        return;
      }
      try {
        const nextSituation = await this.buildSituationSnapshot(currentZones);
        if (generation !== this.situationLoadGeneration) {
          return;
        }
        this.situationDepartements = nextSituation;
        this.logger.log('LOAD SITUATION DEPARTEMENTS - END');
        return;
      } catch (error) {
        if (generation !== this.situationLoadGeneration) {
          return;
        }
        lastError = error;
        if (attempt < this.situationLoadMaxAttempts) {
          await new Promise((resolve) =>
            setTimeout(resolve, this.situationLoadRetryDelayMs),
          );
        }
      }
    }

    throw lastError;
  }

  async buildSituationSnapshot(
    currentZones: readonly Record<string, unknown>[],
    aggregate?: ZonePublicationAggregatePayload | null,
  ): Promise<any[]> {
    return this.buildSituation(currentZones, aggregate);
  }

  publishSituation(nextSituation: any[]): void {
    this.situationLoadGeneration += 1;
    this.situationDepartements = nextSituation;
  }

  private async buildSituation(
    currentZones: readonly Record<string, unknown>[],
    aggregate?: ZonePublicationAggregatePayload | null,
  ): Promise<any[]> {
    const [departements, statistics] = await Promise.all([
      this.departementRepository.find(<FindManyOptions>{
        select: {
          id: true,
          code: true,
          nom: true,
          region: {
            nom: true,
          },
        },
        relations: ['region'],
        order: {
          code: 'ASC',
        },
      }),
      this.statisticRepository.find({
        select: {
          date: true,
          departementSituation: true,
        },
        order: {
          date: 'ASC',
        },
      }),
    ]);

    const today = new Date().toISOString().split('T')[0];
    const situations = statistics.map((s) => {
      return {
        date: s.date,
        departementSituation: departements.map((d) => {
          let niveauGraviteMax =
            s.departementSituation && s.departementSituation[d.code]
              ? s.departementSituation[d.code].max
              : null;
          let niveauGraviteSupMax =
            s.departementSituation && s.departementSituation[d.code]
              ? s.departementSituation[d.code].sup
              : null;
          let niveauGraviteSouMax =
            s.departementSituation && s.departementSituation[d.code]
              ? s.departementSituation[d.code].sou
              : null;
          let niveauGraviteAepMax =
            s.departementSituation && s.departementSituation[d.code]
              ? s.departementSituation[d.code].aep
              : null;

          if (s.date === today) {
            const materialized = aggregate?.departments[d.code];
            const depZones = currentZones.filter(
              (z) => z.departement === d.code,
            );

            niveauGraviteMax = materialized
              ? materialized.max
              : this.computeMaxGravite(depZones);
            niveauGraviteSupMax = materialized
              ? materialized.sup
              : this.computeMaxGravite(depZones, 'SUP');
            niveauGraviteSouMax = materialized
              ? materialized.sou
              : this.computeMaxGravite(depZones, 'SOU');
            niveauGraviteAepMax = materialized
              ? materialized.aep
              : this.computeMaxGravite(depZones, 'AEP');
          }

          return {
            code: d.code,
            nom: d.nom,
            region: d.region?.nom,
            niveauGraviteMax: niveauGraviteMax,
            niveauGraviteSupMax: niveauGraviteSupMax,
            niveauGraviteSouMax: niveauGraviteSouMax,
            niveauGraviteAepMax: niveauGraviteAepMax,
          };
        }),
      };
    });

    if (
      aggregate &&
      !situations.some((situation) => situation.date === today)
    ) {
      situations.push({
        date: today,
        departementSituation: this.mapMaterializedSituation(aggregate),
      });
    }
    return situations;
  }

  private async situationByPublication(
    publicationId: string,
    bassinVersant?: string,
    region?: string,
    departement?: string,
  ): Promise<DepartementDto[]> {
    if (!isUUID(publicationId)) {
      throw new HttpException(
        `L'identifiant de publication n'est pas valide.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      !this.zonePublicationRepository ||
      !this.zonePublicationAggregateRepository
    ) {
      throw new HttpException(
        `Cette publication est temporairement indisponible.`,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (!this.departements) {
      await this.loadRefData();
    }
    const [publication, aggregate] = await Promise.all([
      this.zonePublicationRepository.findOne({
        select: { id: true, status: true },
        where: { id: publicationId },
      }),
      this.zonePublicationAggregateRepository.findOne({
        where: { publicationId },
      }),
    ]);
    if (
      !publication ||
      !aggregate ||
      !['active', 'retired'].includes(publication.status)
    ) {
      throw new HttpException(
        `Cette publication n'est plus disponible.`,
        HttpStatus.GONE,
      );
    }
    return this.filterSituation(
      this.mapMaterializedSituation(aggregate.payload),
      bassinVersant,
      region,
      departement,
    );
  }

  private mapMaterializedSituation(
    aggregate: ZonePublicationAggregatePayload,
  ): DepartementDto[] {
    return this.departements.map((department) => {
      const situation = aggregate.departments[department.code];
      return {
        code: department.code,
        nom: department.nom,
        region: department.region?.nom,
        niveauGraviteMax: situation?.max ?? null,
        niveauGraviteSupMax: situation?.sup ?? null,
        niveauGraviteSouMax: situation?.sou ?? null,
        niveauGraviteAepMax: situation?.aep ?? null,
      };
    });
  }

  private async loadDepartementAvailability(
    publicationId?: string,
  ): Promise<DepartementAvailabilityContext> {
    if (!this.zonePublicationRepository) {
      return { sourcePublicRevision: null, certifications: new Map() };
    }
    try {
      const rows = (await this.zonePublicationRepository.query(
        `
          SELECT
            CASE
              WHEN $1::uuid IS NULL THEN source."publicRevision"::text
              ELSE publication."sourceRevision"::text
            END AS "sourcePublicRevision",
            availability."departmentCode",
            availability."zoneType",
            availability."status",
            availability."asOf",
            availability."publicRevision"::text AS "availabilityPublicRevision",
            availability."officialUrl"
          FROM "zone_publication_source_state" source
          LEFT JOIN "zone_type_availability" availability ON true
          LEFT JOIN "zone_publication" publication
            ON publication."id" = $1::uuid
          WHERE source."id" = 1
        `,
        [publicationId ?? null],
      )) as DepartementAvailabilityRow[];
      return {
        sourcePublicRevision: rows[0]?.sourcePublicRevision ?? null,
        certifications: new Map(
          rows
            .filter((row) => row.departmentCode && row.zoneType)
            .map((row) => [`${row.departmentCode}:${row.zoneType}`, row]),
        ),
      };
    } catch (error) {
      this.logger.warn(
        `DEPARTMENT DATA AVAILABILITY UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { sourcePublicRevision: null, certifications: new Map() };
    }
  }

  private buildDepartementAepAvailability(
    department: DepartementDto,
    sourcePublicRevision: string | null,
    certification?: DepartementAvailabilityRow,
  ): DepartementZoneAvailabilityDto {
    const officialUrl =
      certification?.officialUrl ?? OFFICIAL_AEP_URLS[department.code] ?? null;
    const certificationAsOf = this.toIsoString(certification?.asOf);
    const unavailable = (): DepartementZoneAvailabilityDto => ({
      status: 'unavailable',
      asOf: certificationAsOf,
      sourceRevision: sourcePublicRevision,
      officialUrl,
    });

    if (!sourcePublicRevision) {
      return unavailable();
    }
    const certificationApplies = this.publicRevisionIsAtOrBefore(
      certification?.availabilityPublicRevision,
      sourcePublicRevision,
    );
    if (certification && !certificationApplies) {
      return unavailable();
    }
    if (certificationApplies && certification?.status === 'confirmed_none') {
      return {
        status: 'confirmed_none',
        asOf: certificationAsOf,
        sourceRevision: sourcePublicRevision,
        officialUrl,
      };
    }
    if (certificationApplies && certification?.status !== 'available') {
      return unavailable();
    }
    if (RESTRICTION_LEVELS.has(department.niveauGraviteAepMax)) {
      return {
        status: 'available',
        asOf: certificationAsOf,
        sourceRevision: sourcePublicRevision,
        officialUrl,
      };
    }
    return unavailable();
  }

  private publicRevisionIsAtOrBefore(
    certificationRevision?: string | null,
    sourceRevision?: string | null,
  ): boolean {
    if (
      !certificationRevision ||
      !sourceRevision ||
      !/^\d+$/.test(certificationRevision) ||
      !/^\d+$/.test(sourceRevision)
    ) {
      return false;
    }
    return BigInt(certificationRevision) <= BigInt(sourceRevision);
  }

  private toIsoString(value?: Date | string | null): string | null {
    if (!value) {
      return null;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  /**
   * Calcule le niveau de gravité maximal pour une liste de zones données.
   * @param zones - Liste des zones à analyser.
   * @param type - (Optionnel) Type de zone (SUP, SOU, AEP).
   */
  private computeMaxGravite(zones: any[], type?: string): string | null {
    const filteredZones = type ? zones.filter((z) => z.type === type) : zones;
    if (filteredZones.length === 0) return null;

    // Transforme les niveaux en valeurs numériques, puis récupère le maximum
    const maxLevel = max(
      filteredZones.map((z) => Utils.getNiveau(z.niveauGravite)),
    );
    return Utils.getNiveauInversed(maxLevel);
  }
}
