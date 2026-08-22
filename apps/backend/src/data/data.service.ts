import { createHash } from 'node:crypto';
import {
  HttpException,
  HttpStatus,
  Injectable,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { VigieauLogger } from '../logger/vigieau.logger';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  FindManyOptions,
  FindOneOptions,
  Repository,
} from 'typeorm';
import { StatisticDepartement } from '@shared/entities/statistic_departement.entity';
import moment from 'moment';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Region } from '@shared/entities/region.entity';
import { BassinVersant } from '@shared/entities/bassin_versant.entity';
import { StatisticCommune } from '@shared/entities/statistic_commune.entity';
import { Departement } from '@shared/entities/departement.entity';
import {
  DEFAULT_STATISTIC_PUBLICATION_DEADLINE,
  getPublicationLagDays,
  getStatisticPublicationExpectation as resolveStatisticPublicationExpectation,
  type StatisticPublicationExpectation,
} from './statistic-publication-freshness';
import {
  StatisticCacheArtifactService,
  type StatisticCacheArtifactCandidate,
  type StatisticCacheArtifactIdentity,
  type StatisticCacheCandidateTarget,
  type StatisticCacheArtifactPayload,
  type StatisticCacheLatestCommuneWeight,
  type StatisticCacheMaterializationStrategy,
  STATISTIC_CACHE_PROTOCOL_VERSION,
} from './statistic-cache-artifact.service';
import { statisticSourceRevisionSql } from './statistic-cache-config';

interface StatisticPublicationState {
  revision: string;
  activePublicationId: string | null;
  statisticCachePublicationId?: string | null;
  statisticCacheCandidatePublicationId?: string | null;
  currentPublishedDate: string | null;
  historicPublishedThrough: string | null;
  historicDirtyFrom: string | null;
  historicDirtyThrough: string | null;
  historicMapCursor?: string | null;
  historicStatsCursor?: string | null;
  sourceRevision?: string | null;
  historicComputeEpoch?: string | null;
}

type StatisticCacheMode = 'legacy-bootstrap' | 'versioned';

interface ReferenceDataCache {
  departements: any[];
  regions: Region[];
  bassinsVersants: BassinVersant[];
  fullArea: number;
  metropoleArea: number;
}

interface CertifiedDataCache extends ReferenceDataCache {
  revision: string;
  publicationState: StatisticPublicationState;
  mode: StatisticCacheMode;
  dataArea: any[];
  dataCommune: any[];
  dataDepartement: any[];
  firstDate: string;
  latestDate: string;
  dateCount: number;
  departmentCount: number;
  communeCount: number;
  fingerprint: string;
  artifactIdentity: StatisticCacheArtifactIdentity | null;
  artifactPublicationId: string | null;
  artifactProtocolVersion: number | null;
  artifactSourceRevision: string | null;
  latestCommuneWeights: StatisticCacheLatestCommuneWeight[];
  artifactHistoricDirtyFrom: string | null;
  artifactHistoricDirtyThrough: string | null;
  artifactHistoricMapCursor: string | null;
  artifactHistoricStatsCursor: string | null;
  artifactHistoricComputeEpoch: string | null;
  loadedAt: Date;
}

export type StatisticCacheStatus = {
  status: 'ready' | 'degraded' | 'unavailable';
  usable: boolean;
  fresh: boolean;
  currentFresh: boolean;
  historicComplete: boolean;
  mode: StatisticCacheMode;
  artifactPublicationId: string | null;
  artifactProtocolVersion?: number | null;
  artifactLiveInstances: number | null;
  artifactReadyInstances: number | null;
  artifactCandidatePublicationId?: string | null;
  artifactCandidateProtocolVersion?: number | null;
  artifactCandidateReadyInstances?: number | null;
  targetDate?: string | null;
  refreshStartedAt?: string | null;
  nextRetryAt?: string | null;
  currentPublishedDate: string | null;
  expectedPublishedDate: string;
  publicationDeadline: string;
  lagDays: number | null;
  historicDirtyFrom: string | null;
  historicDirtyThrough: string | null;
  firstDate: string | null;
  latestDate: string | null;
  dateCount: number;
  departmentCount: number;
  communeCount: number;
  fingerprint: string | null;
  loadedAt: string | null;
  incompleteSnapshotCount: number | null;
  oldestIncompleteSnapshot: {
    date: string;
    scope: string;
    status: string;
    processedCommuneCount: number;
    expectedCommuneCount: number;
    updatedAt: string;
  } | null;
  lastError: {
    at: string;
    phase: string;
  } | null;
};

export type StatisticCacheAcknowledgement = {
  statisticCachePublicationId: string | null;
  statisticRevision: string | null;
  statisticPublishedDate: string | null;
  statisticFingerprint: string | null;
  statisticSourceRevision: string | null;
  statisticProtocolVersion: number | null;
  statisticLastError: string | null;
  candidateStatisticCachePublicationId: string | null;
  candidateStatisticRevision: string | null;
  candidateStatisticPublishedDate: string | null;
  candidateStatisticSourceRevision: string | null;
  candidateStatisticFingerprint: string | null;
  candidateStatisticProtocolVersion: number | null;
  candidateStatisticLastError: string | null;
};

export type StatisticCacheReconcileResult = {
  outcome:
    | 'disabled'
    | 'up-to-date'
    | 'candidate-ready'
    | 'awaiting-acknowledgements'
    | 'activated'
    | 'superseded'
    | 'retry';
  reason: string;
};

type DepartmentDataLoad = {
  coverageByDate: Map<string, Set<string>>;
};

type LegacySnapshotCoverageStatus = Pick<
  StatisticCacheStatus,
  'incompleteSnapshotCount' | 'oldestIncompleteSnapshot'
>;

type CachedLegacySnapshotCoverageStatus = LegacySnapshotCoverageStatus & {
  currentPublishedDate: string;
};

@Injectable()
export class DataService implements OnModuleInit {
  private readonly logger = new VigieauLogger('DataService');

  private data: any[] = [];
  private dataArea: any[] = [];
  private dataCommune: any[] = [];
  private dataDepartement: any[] = [];
  private departements: any[] = [];
  private regions: Region[] = [];
  private bassinsVersants: BassinVersant[] = [];
  private fullArea: number = 0;
  private metropoleArea: number = 0;
  private publicationState: StatisticPublicationState | null = null;
  private publicationStateCheckedAt = 0;
  private publicationStateCheckError: Error | null = null;
  private publicationStateLoading: Promise<StatisticPublicationState> | null =
    null;
  private referenceDataCache: ReferenceDataCache | null = null;
  private referenceDataLoading: Promise<ReferenceDataCache> | null = null;
  private referenceDataLoadedAt = 0;
  private referenceDataRefreshFailedAt = 0;
  private certifiedDataCache: CertifiedDataCache | null = null;
  private candidateDataCache: CertifiedDataCache | null = null;
  private candidateDataCacheLoading: Promise<void> | null = null;
  private failedCandidatePublicationId: string | null = null;
  private failedCandidateAt = 0;
  private failedCandidatePhase: string | null = null;
  private certifiedDataRefreshLoading: Promise<void> | null = null;
  private dataLoading: Promise<void> | null = null;
  private failedPublicationStateToken: string | null = null;
  private failedPublicationAt = 0;
  private lastDataCacheError: { at: Date; phase: string } | null = null;
  private legacySnapshotCoverageStatus: CachedLegacySnapshotCoverageStatus | null =
    null;
  private legacySnapshotCoverageCheckedAt = 0;
  private legacySnapshotCoverageLoading: Promise<LegacySnapshotCoverageStatus> | null =
    null;
  private legacySnapshotCoverageDirty = false;

  private readonly publicationStateCheckIntervalMs = 5_000;
  private readonly legacySnapshotCoverageCheckIntervalMs = 5_000;
  private readonly publicationRefreshRetryIntervalMs = 60_000;
  private readonly referenceDataRefreshIntervalMs = 2 * 60 * 60 * 1_000;
  private readonly referenceDataRefreshRetryIntervalMs = 5_000;

  private readonly releaseDate = '2023-07-11';
  private readonly beginDate = '2013-01-01';
  private readonly expectedDepartmentCount = 101;

  constructor(
    @InjectRepository(StatisticDepartement)
    private readonly statisticDepartementRepository: Repository<StatisticDepartement>,
    @InjectRepository(StatisticCommune)
    private readonly statisticCommuneRepository: Repository<StatisticCommune>,
    @InjectRepository(Departement)
    private readonly departementRepository: Repository<Departement>,
    @InjectRepository(Region)
    private readonly regionRepository: Repository<Region>,
    @InjectRepository(BassinVersant)
    private readonly bassinVersantRepository: Repository<BassinVersant>,
    private dataSource: DataSource,
    @Optional()
    private readonly statisticCacheArtifactService?: StatisticCacheArtifactService,
  ) {}

  onModuleInit(): void {
    if (process.env.VIGIEAU_PROCESS_ROLE !== 'statcache') {
      this.startColdDataLoad();
    }
  }

  /**
   * Retourne les données de référence pour les filtres (bassins versants, régions, départements).
   * Ces données sont structurées pour faciliter leur utilisation dans des interfaces utilisateur.
   */
  async getRefData() {
    const refreshedReferenceData = await this.ensureReferenceDataCache();
    const referenceData = this.certifiedDataCache ?? refreshedReferenceData;
    return {
      bassinsVersants: this.formatEntities(
        referenceData.bassinsVersants,
        'departements',
      ),
      regions: this.formatEntities(referenceData.regions, 'departements'),
      departements: referenceData.departements.map((d) => {
        return {
          id: d.id,
          code: d.code,
          nom: d.nom,
          bounds: d.bounds,
        };
      }),
    };
  }

  /**
   * Formate les entités comme les bassins versants et les régions pour inclure uniquement
   * les champs nécessaires, notamment les relations avec d'autres entités.
   * @param entities - La liste des entités à formater (par exemple : bassins versants).
   * @param relatedField - Le champ relationnel à inclure dans le formatage (par exemple : 'departements').
   */
  private formatEntities(entities: any[], relatedField: string) {
    return entities
      .filter(
        (entity) => entity[relatedField] && entity[relatedField].length > 0,
      )
      .map((entity) => ({
        id: entity.id,
        code: entity.code,
        nom: entity.nom,
        [relatedField]: entity[relatedField].map((rel: any) => ({
          id: rel.id,
          code: rel.code,
        })),
      }));
  }

  /**
   * Filtre les données de surface (area) par date et critères géographiques
   * comme le bassin versant, la région ou le département.
   * @param dateDebut - Date de début de la plage de recherche (optionnelle).
   * @param dateFin - Date de fin de la plage de recherche (optionnelle).
   * @param bassinVersant - ID du bassin versant (optionnel).
   * @param region - ID de la région (optionnel).
   * @param departement - ID du département (optionnel).
   * @returns Les données filtrées selon les critères.
   */
  async areaFindByDate(
    dateDebut?: string,
    dateFin?: string,
    bassinVersant?: string,
    region?: string,
    departement?: string,
  ) {
    const cache = await this.ensureCertifiedDataCache();
    // Filtrage des données par date
    const filteredData = this.filterDataByDate(
      cache.dataArea,
      dateDebut,
      dateFin,
    );

    // Filtrer par bassin versant, région ou département
    if (bassinVersant)
      return this.filterByEntity(
        filteredData,
        bassinVersant,
        'bassinsVersants',
        cache,
      );
    if (region)
      return this.filterByEntity(filteredData, region, 'regions', cache);
    if (departement)
      return this.filterByEntity(
        filteredData,
        departement,
        'departements',
        cache,
      );

    // Données globales
    return filteredData.map((d) => ({
      date: d.date,
      ESO: d.ESO,
      ESU: d.ESU,
      AEP: d.AEP,
    }));
  }

  /**
   * Filtre les données par entité géographique (bassin versant, région, département).
   * @param data - Les données à filtrer.
   * @param entityId - L'ID de l'entité géographique à utiliser pour le filtre.
   * @param field - Le champ correspondant à l'entité (ex : 'bassinsVersants', 'regions').
   */
  private filterByEntity(
    data: any[],
    entityId: string,
    field: string,
    referenceData: ReferenceDataCache,
  ) {
    const entity = referenceData[field].find((e) => e.id === +entityId);
    if (!entity) {
      throw new HttpException(
        `${field.slice(0, -1)} non trouvé.`,
        HttpStatus.NOT_FOUND,
      );
    }

    return data.map((d) => ({
      date: d.date,
      ...d[field].find((item: any) => item.id === entity.id),
    }));
  }

  /**
   * Filtre les données par plage de dates.
   * Si aucune date n'est spécifiée, la plage par défaut est définie entre `beginDate` et aujourd'hui.
   * @param data - Les données à filtrer.
   * @param dateDebut - Date de début de la plage de recherche (optionnelle).
   * @param dateFin - Date de fin de la plage de recherche (optionnelle).
   */
  private filterDataByDate(data: any[], dateDebut?: string, dateFin?: string) {
    return structuredClone(
      data.filter((d) =>
        moment(d.date).isBetween(
          moment(dateDebut || this.beginDate, 'YYYY-MM-DD'),
          moment(dateFin || moment(), 'YYYY-MM-DD'),
          undefined,
          '[]',
        ),
      ),
    );
  }

  /**
   * Récupère les statistiques d'un département selon des critères comme les plages de dates
   * ou les entités géographiques (bassins versants, régions).
   * @param dateDebut - Date de début de la plage de recherche (optionnelle).
   * @param dateFin - Date de fin de la plage de recherche (optionnelle).
   * @param bassinVersant - ID du bassin versant (optionnel).
   * @param region - ID de la région (optionnel).
   * @param departement - ID du département (optionnel).
   * @returns Les statistiques du département filtrées.
   */
  async departementFindByDate(
    dateDebut?: string,
    dateFin?: string,
    bassinVersant?: string,
    region?: string,
    departement?: string,
  ) {
    const cache = await this.ensureCertifiedDataCache();
    let dataDepartementFiltered = this.filterDataByDate(
      cache.dataDepartement,
      dateDebut,
      dateFin,
    );

    const departementsToFilter = this.getDepartementsToFilter(
      bassinVersant,
      region,
      departement,
      cache,
    );
    if (departementsToFilter.length > 0) {
      dataDepartementFiltered = dataDepartementFiltered.map((d) => {
        d.departements = d.departements.filter((dep) =>
          departementsToFilter.some((depf) => depf.code === dep.code),
        );
        return d;
      });
    }
    return dataDepartementFiltered;
  }

  /**
   * Récupère une liste de départements correspondant aux critères géographiques (bassin, région, département).
   * @param bassinVersant - ID du bassin versant (optionnel).
   * @param region - ID de la région (optionnel).
   * @param departement - ID du département (optionnel).
   * @returns Une liste de départements correspondant aux critères.
   */
  private getDepartementsToFilter(
    bassinVersant?: string,
    region?: string,
    departement?: string,
    referenceData: ReferenceDataCache = this.referenceDataCache ?? {
      departements: this.departements,
      regions: this.regions,
      bassinsVersants: this.bassinsVersants,
      fullArea: this.fullArea,
      metropoleArea: this.metropoleArea,
    },
  ) {
    if (bassinVersant) {
      return this.getEntityById(
        referenceData.bassinsVersants,
        bassinVersant,
        'Bassin versant',
      ).departements;
    }
    if (region) {
      return this.getEntityById(referenceData.regions, region, 'Région')
        .departements;
    }
    if (departement) {
      return [
        this.getEntityById(
          referenceData.departements,
          departement,
          'Département',
        ),
      ];
    }
    return [];
  }

  /**
   * Recherche une entité (ex : bassin versant, région, département) par son ID.
   * @param collection - La liste des entités à rechercher.
   * @param id - L'ID de l'entité recherchée.
   * @param entityName - Nom de l'entité (pour les erreurs).
   * @returns L'entité correspondante ou une erreur si elle n'est pas trouvée.
   */
  private getEntityById(collection: any[], id: string, entityName: string) {
    const entity = collection.find((e) => e.id === +id);
    if (!entity) {
      throw new HttpException(
        `${entityName} non trouvé.`,
        HttpStatus.NOT_FOUND,
      );
    }
    return entity;
  }

  /**
   * Calcule les données de surface (area) et les restrictions associées pour différents niveaux géographiques.
   * Cette méthode est utilisée pour préparer les données avant leur exposition via des API.
   */
  computeDataArea(referenceData = this.getInstanceReferenceData()) {
    this.logger.log('COMPUTE DATA AREA');
    this.dataArea = this.data.map((data) => {
      return {
        date: data.date,
        ESO: this.computeRestriction(
          data.departements,
          'SOU',
          referenceData.fullArea,
        ),
        ESU: this.computeRestriction(
          data.departements,
          'SUP',
          referenceData.fullArea,
        ),
        AEP: this.computeRestriction(
          data.departements,
          'AEP',
          referenceData.fullArea,
        ),
        bassinsVersants: this.computeEntityRestrictions(
          data,
          referenceData.bassinsVersants,
          referenceData.departements,
        ),
        regions: this.computeEntityRestrictions(
          data,
          referenceData.regions,
          referenceData.departements,
        ),
        departements: this.computeEntityRestrictions(
          data,
          referenceData.departements,
          referenceData.departements,
        ),
      };
    });
  }

  /**
   * Calcule les restrictions pour un ensemble d'entités (bassins versants, régions, départements).
   */
  private computeEntityRestrictions(
    data: any,
    entities: any[],
    departements: any[],
  ) {
    return entities.map((entity) => {
      const filteredDeps = departements.filter((dep) =>
        entity.departements?.some((d) => d.id === dep.id),
      );
      const area = filteredDeps.reduce((acc, dep) => acc + dep.area, 0);
      const restrictions = data.departements.filter((dep) =>
        filteredDeps.some((d) => d.code === dep.departement),
      );
      return {
        id: entity.id,
        ESO: this.computeRestriction(restrictions, 'SOU', area),
        ESU: this.computeRestriction(restrictions, 'SUP', area),
        AEP: this.computeRestriction(restrictions, 'AEP', area),
      };
    });
  }

  private getInstanceReferenceData(): ReferenceDataCache {
    return {
      departements: this.departements,
      regions: this.regions,
      bassinsVersants: this.bassinsVersants,
      fullArea: this.fullArea,
      metropoleArea: this.metropoleArea,
    };
  }

  /**
   * Calcule un pourcentage de restriction pour un type de zone (ex : SUP, SOU, AEP).
   */
  private computeRestriction(
    restrictions: any[],
    zoneType: string,
    area: number,
  ) {
    const compute = (key: string) =>
      (
        (restrictions.reduce(
          (acc, r) => acc + Number(r[zoneType]?.[key] || 0),
          0,
        ) *
          100) /
        area
      ).toFixed(2);

    return {
      vigilance: compute('vigilance'),
      alerte: compute('alerte'),
      alerte_renforcee: compute('alerte_renforcee'),
      crise: compute('crise'),
    };
  }

  /**
   * Retourne les données communes (pré-calculées).
   */
  async duree() {
    const cache = await this.ensureCertifiedDataCache();
    return cache.dataCommune;
  }

  /**
   * Récupérer les statistiques pour une commune donnée et éventuellement filtrer par date.
   *
   * @param code - Code INSEE de la commune.
   * @param dateDebut - (Optionnel) Début de la plage de dates (format YYYY-MM).
   * @param dateFin - (Optionnel) Fin de la plage de dates (format YYYY-MM).
   * @returns Les statistiques de la commune, incluant les restrictions filtrées si applicable.
   */
  async commune(
    code: string,
    dateDebut?: string,
    dateFin?: string,
  ): Promise<StatisticCommune> {
    const stat = await this.statisticCommuneRepository.findOne(<FindOneOptions>{
      select: {
        id: true,
        commune: {
          id: true,
          code: true,
          nom: true,
        },
      },
      relations: ['commune'],
      where: {
        commune: {
          code: code,
        },
      },
    });

    // Vérification si la commune existe
    if (!stat) {
      throw new HttpException(
        `Commune avec le code "${code}" non trouvée.`,
        HttpStatus.NOT_FOUND,
      );
    }

    const dateBegin = dateDebut
      ? moment(dateDebut, 'YYYY-MM').startOf('month')
      : dateFin
        ? moment()
        : null;
    const dateEnd = dateFin
      ? moment(dateFin, 'YYYY-MM').endOf('month')
      : dateDebut
        ? moment()
        : null;
    const [result] = await this.dataSource.query(
      `
        WITH publication_state AS MATERIALIZED (
          SELECT
            "currentPublishedDate",
            "historicDirtyFrom",
            "historicDirtyThrough",
            (
              SELECT "activePublicationId"
              FROM zone_publication_state
              WHERE id = 1
            ) AS "activePublicationId"
          FROM statistic_publication_state
          WHERE id = 1
        ), filtered_restrictions AS MATERIALIZED (
          SELECT restriction.value, restriction.ordinality
          FROM statistic_commune statistic
          CROSS JOIN publication_state state
          CROSS JOIN LATERAL jsonb_array_elements(statistic.restrictions)
            WITH ORDINALITY AS restriction(value, ordinality)
          WHERE statistic.id = $1
            AND ($2::date IS NULL OR (restriction.value->>'date')::date >= $2::date)
            AND ($3::date IS NULL OR (restriction.value->>'date')::date <= $3::date)
            AND state."currentPublishedDate" IS NOT NULL
            AND (restriction.value->>'date')::date <= state."currentPublishedDate"
            AND (
              (
                $4::varchar = 'legacy-bootstrap'
                AND state."activePublicationId" IS NULL
              )
              OR state."historicDirtyFrom" IS NULL
              OR (restriction.value->>'date')::date < state."historicDirtyFrom"
              OR (restriction.value->>'date')::date > COALESCE(
                state."historicDirtyThrough",
                state."currentPublishedDate"
              )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM statistic_commune_snapshot snapshot
              WHERE snapshot."snapshotDate" = (restriction.value->>'date')::date
                AND snapshot.status <> 'completed'
                AND snapshot.scope <> 'bootstrap'
            )
        )
        SELECT
          EXISTS(SELECT 1 FROM publication_state) AS "stateAvailable",
          (
            SELECT jsonb_agg(value ORDER BY ordinality)
            FROM filtered_restrictions
          ) AS filtered_restrictions
      `,
      [
        stat.id,
        dateBegin?.format('YYYY-MM-DD') ?? null,
        dateEnd?.format('YYYY-MM-DD') ?? null,
        this.getConfiguredStatisticCacheMode(),
      ],
    );
    if (result?.stateAvailable !== true) {
      throw new Error('Statistic publication state is unavailable');
    }
    stat.restrictions = result.filtered_restrictions ?? [];
    return stat;
  }

  /**
   * Tâche cron exécutée toutes les 3 heures pour charger les données.
   * Cette tâche gère le chargement des données de référence, la mémoire utilisée
   * et prépare les données nécessaires pour les départements et les communes.
   */
  @Cron(CronExpression.EVERY_3_HOURS)
  async loadData(requestedPublicationState?: StatisticPublicationState) {
    if (this.dataLoading) {
      return this.dataLoading;
    }
    const hadInitializedCache = this.certifiedDataCache !== null;
    let attemptedPublicationStateToken = requestedPublicationState
      ? this.getPublicationStateToken(requestedPublicationState)
      : null;
    let attemptedCandidateLoad = false;
    const loading = (async () => {
      try {
        let publicationState =
          requestedPublicationState ?? (await this.getPublicationState(true));
        attemptedPublicationStateToken =
          this.getPublicationStateToken(publicationState);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          attemptedCandidateLoad = false;
          const publicationStateToken =
            this.getPublicationStateToken(publicationState);
          attemptedPublicationStateToken = publicationStateToken;
          if (
            hadInitializedCache &&
            this.certifiedDataCache &&
            this.canReuseCertifiedCache(
              this.certifiedDataCache,
              publicationState,
            ) &&
            !(await this.shouldRefreshUnchangedLegacyCache(publicationState))
          ) {
            this.startCandidateDataPreload(publicationState);
            await this.refreshReferenceDataCacheIfStale();
            this.certifiedDataCache.publicationState = publicationState;
            this.publicationState = publicationState;
            this.publicationStateCheckedAt = Date.now();
            this.failedPublicationStateToken = null;
            this.failedPublicationAt = 0;
            this.lastDataCacheError = null;
            return;
          }
          if (
            this.failedPublicationStateToken === publicationStateToken &&
            Date.now() - this.failedPublicationAt <
              this.publicationRefreshRetryIntervalMs
          ) {
            throw new Error(
              `Public data publication state ${publicationStateToken} is in refresh cooldown`,
            );
          }
          attemptedCandidateLoad = true;
          const candidateCache = this.isStatisticArtifactCacheEnabled()
            ? await this.loadArtifactBackedData(publicationState)
            : await this.loadDataOnce(publicationState);
          const stateAfter = await this.getPublicationState(true);
          if (this.isSamePublicationState(publicationState, stateAfter)) {
            const certifiedDataCache = {
              ...candidateCache,
              revision: candidateCache.artifactPublicationId
                ? candidateCache.revision
                : stateAfter.revision,
              publicationState: stateAfter,
            };
            this.publishCertifiedDataCache(certifiedDataCache);
            this.publicationState = stateAfter;
            this.failedPublicationStateToken = null;
            this.failedPublicationAt = 0;
            this.lastDataCacheError = null;
            return;
          }
          this.logger.warn(
            `PUBLICATION STATE CHANGED DURING DATA LOAD - RETRY ${attempt + 1}`,
          );
          publicationState = stateAfter;
        }
        throw new Error(
          'Publication state kept changing while refreshing the public data cache',
        );
      } catch (error) {
        this.lastDataCacheError = {
          at: new Date(),
          phase: hadInitializedCache ? 'refresh' : 'load',
        };
        if (attemptedCandidateLoad && attemptedPublicationStateToken) {
          this.failedPublicationStateToken = attemptedPublicationStateToken;
          this.failedPublicationAt = Date.now();
        }
        if (hadInitializedCache) {
          if (!requestedPublicationState) {
            this.logger.warn(
              `PUBLIC DATA CACHE REFRESH FAILED - SERVING LAST VALID CACHE: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
        throw error;
      }
    })();
    this.dataLoading = loading;
    try {
      await loading;
    } finally {
      if (this.dataLoading === loading) {
        this.dataLoading = null;
      }
    }
  }

  private isStatisticArtifactCacheEnabled(): boolean {
    const mode =
      process.env.STATISTIC_CACHE_ARTIFACT_MODE?.trim().toLowerCase() ||
      'disabled';
    if (mode !== 'disabled' && mode !== 'read-write') {
      throw new Error(`Unsupported STATISTIC_CACHE_ARTIFACT_MODE: ${mode}`);
    }
    return Boolean(this.statisticCacheArtifactService) && mode === 'read-write';
  }

  private isDistributedStatisticCacheEnabled(): boolean {
    const value =
      process.env.STATISTIC_CACHE_DISTRIBUTED_REFRESH_ENABLED?.trim().toLowerCase() ||
      'false';
    if (value !== 'true' && value !== 'false') {
      throw new Error(
        `Unsupported STATISTIC_CACHE_DISTRIBUTED_REFRESH_ENABLED: ${value}`,
      );
    }
    return value === 'true';
  }

  private async loadArtifactBackedData(
    publicationState: StatisticPublicationState,
  ): Promise<CertifiedDataCache> {
    const artifactService = this.statisticCacheArtifactService;
    const currentPublishedDate = publicationState.currentPublishedDate;
    if (!artifactService || !currentPublishedDate) {
      throw new Error('Statistic artifact cache is unavailable');
    }

    if (this.isDistributedStatisticCacheEnabled()) {
      this.startCandidateDataPreload(publicationState);
      const promotedCandidate =
        this.candidateDataCache?.artifactPublicationId ===
        publicationState.statisticCachePublicationId
          ? this.candidateDataCache
          : null;
      if (promotedCandidate) {
        this.candidateDataCache = null;
        return {
          ...promotedCandidate,
          publicationState,
          loadedAt: new Date(),
        };
      }
      const active = await artifactService.loadActive();
      if (!active) {
        throw new Error('No active statistic cache artifact is available');
      }
      await this.ensureReferenceDataCache();
      return this.hydrateArtifactPayload(active, publicationState);
    }
    const target = this.getCandidateTarget(publicationState);
    const active = await artifactService.loadActive();
    if (
      active &&
      this.isArtifactIdentityForState(active.identity, publicationState)
    ) {
      await this.ensureReferenceDataCache();
      return this.hydrateArtifactPayload(active, publicationState);
    }

    const payload = await artifactService.materialize(
      target,
      async (manager) => {
        const latestState = await this.readPublicationState(manager);
        if (!this.isSameMaterializationState(publicationState, latestState)) {
          throw new Error(
            'Statistic publication state changed before materialization',
          );
        }
        const base = await artifactService.loadActive(manager);
        return this.createArtifactCandidate(latestState, base, manager);
      },
    );
    await this.ensureReferenceDataCache();
    return this.hydrateArtifactPayload(payload, publicationState);
  }

  private async createArtifactCandidate(
    publicationState: StatisticPublicationState,
    active: StatisticCacheArtifactPayload | null,
    manager: EntityManager,
  ): Promise<StatisticCacheArtifactCandidate> {
    const currentPublishedDate = publicationState.currentPublishedDate!;
    const mode = this.getStatisticCacheMode(publicationState);
    const historicStatisticsBoundaryClosed = Boolean(
      active &&
      publicationState.historicDirtyFrom === null &&
      (active.identity.historicDirtyFrom !== null ||
        active.identity.historicStatsCursor !==
          publicationState.historicStatsCursor),
    );
    const legacyToVersionedTransition = Boolean(
      active &&
      active.identity.mode === 'legacy-bootstrap' &&
      mode === 'versioned' &&
      publicationState.historicDirtyFrom !== null &&
      currentPublishedDate >= active.identity.latestDate,
    );
    const requiresFullBuild = Boolean(
      !active ||
      (active.identity.mode !== mode && !legacyToVersionedTransition) ||
      currentPublishedDate < active.identity.latestDate ||
      historicStatisticsBoundaryClosed,
    );
    if (
      !active &&
      mode === 'versioned' &&
      publicationState.historicDirtyFrom !== null
    ) {
      return this.createSparseCurrentArtifactCandidate(
        publicationState,
        manager,
      );
    }
    if (requiresFullBuild) {
      if (
        publicationState.historicDirtyFrom !== null &&
        mode !== 'legacy-bootstrap'
      ) {
        throw new Error(
          'A versioned statistic cache cannot bootstrap from a dirty historic range',
        );
      }
      const strategy: StatisticCacheMaterializationStrategy =
        publicationState.historicDirtyFrom === null
          ? 'full-clean'
          : 'legacy-safe-boundary';
      return this.createFullArtifactCandidate(
        publicationState,
        strategy,
        manager,
      );
    }

    if (legacyToVersionedTransition) {
      return this.createDeltaArtifactCandidate(
        publicationState,
        active!,
        manager,
        { mode: 'versioned', forceSparseCurrent: true },
      );
    }

    return this.createDeltaArtifactCandidate(
      publicationState,
      active!,
      manager,
    );
  }

  private async createFullArtifactCandidate(
    publicationState: StatisticPublicationState,
    materializationStrategy: StatisticCacheMaterializationStrategy,
    manager: EntityManager,
  ): Promise<StatisticCacheArtifactCandidate> {
    const cache = await this.loadDataOnce(publicationState, manager);
    const latestCommuneWeights = (
      await this.loadDailyCommuneWeights(
        cache.latestDate,
        cache.latestDate,
        cache.communeCount,
        publicationState,
        manager,
      )
    ).get(cache.latestDate)!;
    return {
      statisticRevision: publicationState.revision,
      currentPublishedDate: publicationState.currentPublishedDate!,
      mode: cache.mode,
      materializationStrategy,
      ...this.getArtifactAudit(publicationState),
      contentFingerprint: cache.fingerprint,
      firstDate: cache.firstDate,
      latestDate: cache.latestDate,
      dateCount: cache.dateCount,
      departmentCount: cache.departmentCount,
      communeCount: cache.communeCount,
      dataArea: cache.dataArea,
      dataDepartement: cache.dataDepartement,
      dataCommune: cache.dataCommune,
      latestCommuneWeights,
    };
  }

  private async createSparseCurrentArtifactCandidate(
    publicationState: StatisticPublicationState,
    manager: EntityManager,
  ): Promise<StatisticCacheArtifactCandidate> {
    const currentPublishedDate = publicationState.currentPublishedDate!;
    const expectedCommuneCount =
      await this.getCertifiedCurrentSnapshotCommuneCount(
        publicationState,
        manager,
      );
    const referenceData = await this.loadRefData(manager);
    const { dataArea, dataDepartement } =
      await this.loadDailyDepartmentCollections(
        currentPublishedDate,
        currentPublishedDate,
        referenceData,
        manager,
      );
    const weightsByDate = await this.loadDailyCommuneWeights(
      currentPublishedDate,
      currentPublishedDate,
      expectedCommuneCount,
      publicationState,
      manager,
    );
    const latestCommuneWeights = weightsByDate.get(currentPublishedDate)!;
    const currentMonth = currentPublishedDate.slice(0, 7);
    const dataCommune = latestCommuneWeights.map(([code, weight]) => ({
      code,
      restrictions: [{ d: currentMonth, p: weight }],
    }));
    const candidateWithoutFingerprint: Omit<CertifiedDataCache, 'fingerprint'> =
      {
        ...referenceData,
        revision: publicationState.revision,
        publicationState,
        mode: 'versioned',
        dataArea,
        dataDepartement,
        dataCommune,
        firstDate: currentPublishedDate,
        latestDate: currentPublishedDate,
        dateCount: 1,
        departmentCount: referenceData.departements.length,
        communeCount: expectedCommuneCount,
        artifactIdentity: null,
        artifactPublicationId: null,
        artifactProtocolVersion: null,
        artifactSourceRevision: publicationState.sourceRevision,
        latestCommuneWeights,
        artifactHistoricDirtyFrom: publicationState.historicDirtyFrom,
        artifactHistoricDirtyThrough: publicationState.historicDirtyThrough,
        artifactHistoricMapCursor: publicationState.historicMapCursor,
        artifactHistoricStatsCursor: publicationState.historicStatsCursor,
        artifactHistoricComputeEpoch: publicationState.historicComputeEpoch,
        loadedAt: new Date(),
      };
    this.assertArtifactCollections(candidateWithoutFingerprint, true);
    return {
      statisticRevision: publicationState.revision,
      currentPublishedDate,
      mode: 'versioned',
      materializationStrategy: 'sparse-current',
      ...this.getArtifactAudit(publicationState),
      contentFingerprint: this.computeStatisticCacheFingerprint(
        candidateWithoutFingerprint,
      ),
      firstDate: currentPublishedDate,
      latestDate: currentPublishedDate,
      dateCount: 1,
      departmentCount: candidateWithoutFingerprint.departmentCount,
      communeCount: expectedCommuneCount,
      dataArea,
      dataDepartement,
      dataCommune,
      latestCommuneWeights,
    };
  }

  private async createDeltaArtifactCandidate(
    publicationState: StatisticPublicationState,
    active: StatisticCacheArtifactPayload,
    manager: EntityManager,
    options?: {
      mode?: StatisticCacheMode;
      forceSparseCurrent?: boolean;
    },
  ): Promise<StatisticCacheArtifactCandidate> {
    const currentPublishedDate = publicationState.currentPublishedDate!;
    if (currentPublishedDate < active.identity.latestDate) {
      throw new Error('Statistic artifact delta cannot move backwards');
    }
    const appendOnly = currentPublishedDate > active.identity.latestDate;
    const nextDate = moment
      .utc(active.identity.latestDate, 'YYYY-MM-DD', true)
      .add(1, 'day')
      .format('YYYY-MM-DD');
    let sparseCurrent =
      options?.forceSparseCurrent === true ||
      active.identity.materializationStrategy === 'sparse-current';
    let snapshotCoverageValidated = false;
    if (appendOnly && currentPublishedDate > nextDate && !sparseCurrent) {
      snapshotCoverageValidated = await this.hasCertifiedDeltaSnapshotCoverage(
        nextDate,
        currentPublishedDate,
        active.identity.communeCount,
        publicationState,
        manager,
      );
      sparseCurrent = !snapshotCoverageValidated;
    }
    const startDate = sparseCurrent
      ? currentPublishedDate
      : appendOnly
        ? nextDate
        : active.identity.latestDate;
    const strategy: StatisticCacheMaterializationStrategy = sparseCurrent
      ? 'sparse-current'
      : appendOnly
        ? 'daily-delta'
        : 'current-replace';
    if (!snapshotCoverageValidated) {
      await this.assertDeltaSnapshotCoverage(
        startDate,
        currentPublishedDate,
        active.identity.communeCount,
        publicationState,
        manager,
      );
    }
    const referenceData = await this.loadRefData(manager);
    const targetDepartments = await this.loadDailyDepartmentCollections(
      startDate,
      currentPublishedDate,
      referenceData,
      manager,
    );
    const targetCommuneWeights = await this.loadDailyCommuneWeights(
      startDate,
      currentPublishedDate,
      active.identity.communeCount,
      publicationState,
      manager,
    );
    const dataArea = this.replaceDatedEntries(
      active.dataArea,
      targetDepartments.dataArea,
      startDate,
    );
    const dataDepartement = this.replaceDatedEntries(
      active.dataDepartement,
      targetDepartments.dataDepartement,
      startDate,
    );
    const dataCommune = this.mergeDailyCommuneWeights(
      active.dataCommune,
      active.latestCommuneWeights,
      targetCommuneWeights,
      startDate,
      active.identity.latestDate,
    );
    const latestCommuneWeights =
      targetCommuneWeights.get(currentPublishedDate)!;
    const candidateWithoutFingerprint: Omit<CertifiedDataCache, 'fingerprint'> =
      {
        ...referenceData,
        revision: publicationState.revision,
        publicationState,
        mode: options?.mode ?? active.identity.mode,
        dataArea,
        dataDepartement,
        dataCommune,
        firstDate: active.identity.firstDate,
        latestDate: currentPublishedDate,
        dateCount: dataArea.length,
        departmentCount: active.identity.departmentCount,
        communeCount: active.identity.communeCount,
        artifactIdentity: null,
        artifactPublicationId: null,
        artifactProtocolVersion: null,
        artifactSourceRevision: publicationState.sourceRevision,
        latestCommuneWeights,
        artifactHistoricDirtyFrom: publicationState.historicDirtyFrom,
        artifactHistoricDirtyThrough: publicationState.historicDirtyThrough,
        artifactHistoricMapCursor: publicationState.historicMapCursor,
        artifactHistoricStatsCursor: publicationState.historicStatsCursor,
        artifactHistoricComputeEpoch: publicationState.historicComputeEpoch,
        loadedAt: new Date(),
      };
    this.assertArtifactCollections(candidateWithoutFingerprint, sparseCurrent);
    return {
      statisticRevision: publicationState.revision,
      currentPublishedDate,
      mode: options?.mode ?? active.identity.mode,
      materializationStrategy: strategy,
      ...this.getArtifactAudit(publicationState),
      contentFingerprint: this.computeStatisticCacheFingerprint(
        candidateWithoutFingerprint,
      ),
      firstDate: candidateWithoutFingerprint.firstDate,
      latestDate: candidateWithoutFingerprint.latestDate,
      dateCount: candidateWithoutFingerprint.dateCount,
      departmentCount: candidateWithoutFingerprint.departmentCount,
      communeCount: candidateWithoutFingerprint.communeCount,
      dataArea,
      dataDepartement,
      dataCommune,
      latestCommuneWeights,
    };
  }

  private getArtifactAudit(publicationState: StatisticPublicationState) {
    return {
      historicDirtyFrom: publicationState.historicDirtyFrom,
      historicDirtyThrough: publicationState.historicDirtyThrough,
      historicMapCursor: publicationState.historicMapCursor,
      historicStatsCursor: publicationState.historicStatsCursor,
      sourceRevision: publicationState.sourceRevision,
      historicComputeEpoch: publicationState.historicComputeEpoch,
    };
  }

  private async assertDeltaSnapshotCoverage(
    startDate: string,
    endDate: string,
    expectedCommuneCount: number,
    publicationState: StatisticPublicationState,
    manager: EntityManager,
  ): Promise<void> {
    if (
      !(await this.hasCertifiedDeltaSnapshotCoverage(
        startDate,
        endDate,
        expectedCommuneCount,
        publicationState,
        manager,
      ))
    ) {
      throw new Error(
        `Statistic delta snapshots are not certified for ${startDate}..${endDate}`,
      );
    }
  }

  private async getCertifiedCurrentSnapshotCommuneCount(
    publicationState: StatisticPublicationState,
    manager: EntityManager,
  ): Promise<number> {
    const [snapshot] = await manager.query(
      `
        SELECT
          snapshot."status", snapshot."expectedCommuneCount",
          snapshot."processedCommuneCount",
          snapshot."sourceRevision"::text AS "sourceRevision",
          (SELECT COUNT(*)::integer FROM "commune") AS "communeCount"
        FROM "statistic_commune_snapshot" snapshot
        WHERE snapshot."snapshotDate" = $1::date
          AND snapshot."scope" = 'national'
      `,
      [publicationState.currentPublishedDate],
    );
    const expectedCommuneCount = Number(snapshot?.expectedCommuneCount ?? 0);
    if (
      !snapshot ||
      snapshot.status !== 'completed' ||
      !Number.isSafeInteger(expectedCommuneCount) ||
      expectedCommuneCount <= 0 ||
      Number(snapshot.processedCommuneCount) !== expectedCommuneCount ||
      Number(snapshot.communeCount) !== expectedCommuneCount ||
      String(snapshot.sourceRevision ?? '') !==
        String(publicationState.sourceRevision ?? '')
    ) {
      throw new Error(
        `Statistic current snapshot is not certified for ${publicationState.currentPublishedDate}`,
      );
    }
    return expectedCommuneCount;
  }

  private async hasCertifiedDeltaSnapshotCoverage(
    startDate: string,
    endDate: string,
    expectedCommuneCount: number,
    publicationState: StatisticPublicationState,
    manager: EntityManager,
  ): Promise<boolean> {
    const rows: Array<{
      snapshotDate: string | Date;
      status: string;
      expectedCommuneCount: string | number;
      processedCommuneCount: string | number;
      sourceRevision: string | number | null;
    }> = await manager.query(
      `
        SELECT
          "snapshotDate", "status", "expectedCommuneCount",
          "processedCommuneCount", "sourceRevision"
        FROM "statistic_commune_snapshot"
        WHERE "scope" = 'national'
          AND "snapshotDate" BETWEEN $1::date AND $2::date
        ORDER BY "snapshotDate" ASC
      `,
      [startDate, endDate],
    );
    const expectedDates = this.generateDateRange(startDate, endDate).map(
      ({ date }) => date,
    );
    return !(
      rows.length !== expectedDates.length ||
      rows.some((row, index) => {
        const date = this.normalizeDate(row.snapshotDate);
        return (
          date !== expectedDates[index] ||
          row.status !== 'completed' ||
          Number(row.expectedCommuneCount) !== expectedCommuneCount ||
          Number(row.processedCommuneCount) !== expectedCommuneCount ||
          (date === endDate &&
            String(row.sourceRevision ?? '') !==
              String(publicationState.sourceRevision ?? ''))
        );
      })
    );
  }

  private async loadDailyDepartmentCollections(
    startDate: string,
    endDate: string,
    referenceData: ReferenceDataCache,
    manager: EntityManager,
  ): Promise<{ dataArea: any[]; dataDepartement: any[] }> {
    const rows: Array<{
      departement: string;
      date: string | Date;
      restriction: any;
    }> = await manager.query(
      `
        SELECT
          departement."code" AS "departement",
          (restriction.value ->> 'date')::date AS "date",
          restriction.value AS "restriction"
        FROM "statistic_departement" statistic
        JOIN "departement" departement
          ON departement."id" = statistic."departementId"
        CROSS JOIN LATERAL jsonb_array_elements(
          COALESCE(statistic."restrictions", '[]'::jsonb)
        ) restriction(value)
        WHERE (restriction.value ->> 'date')::date
          BETWEEN $1::date AND $2::date
        ORDER BY (restriction.value ->> 'date')::date, departement."code"
      `,
      [startDate, endDate],
    );
    this.data = this.generateDateRange(startDate, endDate);
    const byDate = new Map(this.data.map((entry) => [entry.date, entry]));
    const coverage = new Map<string, Set<string>>();
    for (const row of rows) {
      const date = this.normalizeDate(row.date)!;
      const covered = coverage.get(date) ?? new Set<string>();
      if (covered.has(row.departement)) {
        throw new Error(
          `Duplicate department statistic ${row.departement}/${date}`,
        );
      }
      covered.add(row.departement);
      coverage.set(date, covered);
      byDate.get(date)?.departements.push({
        departement: row.departement,
        ...row.restriction,
        date,
      });
    }
    for (const entry of this.data) {
      if (coverage.get(entry.date)?.size !== this.expectedDepartmentCount) {
        throw new Error(
          `Department statistic delta ${entry.date} contains ${coverage.get(entry.date)?.size ?? 0}/${this.expectedDepartmentCount} departments`,
        );
      }
    }
    this.computeDataArea(referenceData);
    this.computeDataDepartement(referenceData);
    const result = {
      dataArea: this.dataArea,
      dataDepartement: this.dataDepartement,
    };
    this.data = [];
    return result;
  }

  private async loadDailyCommuneWeights(
    startDate: string,
    endDate: string,
    expectedCommuneCount: number,
    publicationState: StatisticPublicationState,
    manager: EntityManager,
  ): Promise<Map<string, StatisticCacheLatestCommuneWeight[]>> {
    if (!publicationState.sourceRevision) {
      throw new Error('Statistic source revision is unavailable');
    }
    const rows: Array<{
      code: string;
      date: string | Date;
      weight: string | number;
    }> = await manager.query(
      `
        SELECT
          commune."code" AS "code",
          (daily.value ->> 'date')::date AS "date",
          CASE GREATEST(
            CASE daily.value ->> 'AEP'
              WHEN 'vigilance' THEN 2 WHEN 'alerte' THEN 3
              WHEN 'alerte_renforcee' THEN 4 WHEN 'crise' THEN 5 ELSE 1 END,
            CASE daily.value ->> 'SOU'
              WHEN 'vigilance' THEN 2 WHEN 'alerte' THEN 3
              WHEN 'alerte_renforcee' THEN 4 WHEN 'crise' THEN 5 ELSE 1 END,
            CASE daily.value ->> 'SUP'
              WHEN 'vigilance' THEN 2 WHEN 'alerte' THEN 3
              WHEN 'alerte_renforcee' THEN 4 WHEN 'crise' THEN 5 ELSE 1 END
          )
            WHEN 2 THEN 0.5 WHEN 3 THEN 2 WHEN 4 THEN 3
            WHEN 5 THEN 4 ELSE 0
          END AS "weight"
        FROM "statistic_commune" statistic
        JOIN "commune" commune ON commune."id" = statistic."communeId"
        CROSS JOIN LATERAL jsonb_array_elements(
          COALESCE(statistic."restrictions", '[]'::jsonb)
        ) daily(value)
        WHERE (daily.value ->> 'date')::date
          BETWEEN $1::date AND $2::date
        ORDER BY (daily.value ->> 'date')::date, commune."code"
      `,
      [startDate, endDate],
    );
    const weightsByDate = new Map<
      string,
      StatisticCacheLatestCommuneWeight[]
    >();
    for (const row of rows) {
      const date = this.normalizeDate(row.date)!;
      const weight = Number(row.weight);
      if (!Number.isFinite(weight)) {
        throw new Error(`Invalid commune weight ${row.code}/${date}`);
      }
      const weights = weightsByDate.get(date) ?? [];
      weights.push([String(row.code), weight]);
      weightsByDate.set(date, weights);
    }
    for (const { date } of this.generateDateRange(startDate, endDate)) {
      const weights = weightsByDate.get(date);
      if (
        weights?.length !== expectedCommuneCount ||
        new Set(weights?.map(([code]) => code)).size !== expectedCommuneCount
      ) {
        throw new Error(
          `Commune statistic delta ${date} contains ${weights?.length ?? 0}/${expectedCommuneCount} communes`,
        );
      }
    }
    return weightsByDate;
  }

  private replaceDatedEntries(
    base: any[],
    replacement: any[],
    startDate: string,
  ): any[] {
    return [
      ...base.filter(({ date }) => String(date) < startDate),
      ...replacement,
    ];
  }

  private mergeDailyCommuneWeights(
    base: any[],
    baseLatestWeights: StatisticCacheLatestCommuneWeight[],
    weightsByDate: Map<string, StatisticCacheLatestCommuneWeight[]>,
    startDate: string,
    baseLatestDate: string,
  ): any[] {
    const dailyByCode = new Map<string, Map<string, number>>();
    for (const [date, weights] of weightsByDate) {
      for (const [code, weight] of weights) {
        const byDate = dailyByCode.get(code) ?? new Map<string, number>();
        byDate.set(date, weight);
        dailyByCode.set(code, byDate);
      }
    }
    const previousWeightByCode = new Map(baseLatestWeights);
    return base.map((commune) => {
      const code = String(commune.code);
      const monthly = new Map<string, number>(
        (commune.restrictions ?? []).map(({ d, p }) => [String(d), Number(p)]),
      );
      if (startDate === baseLatestDate) {
        const month = baseLatestDate.slice(0, 7);
        if (!monthly.has(month)) {
          throw new Error(`Missing current month for commune ${code}`);
        }
        monthly.set(
          month,
          monthly.get(month)! - (previousWeightByCode.get(code) ?? 0),
        );
      }
      const daily = dailyByCode.get(code);
      if (!daily || daily.size !== weightsByDate.size) {
        throw new Error(`Incomplete daily weights for commune ${code}`);
      }
      for (const [date, weight] of daily) {
        const month = date.slice(0, 7);
        monthly.set(month, (monthly.get(month) ?? 0) + weight);
      }
      return {
        code,
        restrictions: [...monthly]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([d, p]) => ({ d, p })),
      };
    });
  }

  private hydrateArtifactPayload(
    payload: StatisticCacheArtifactPayload,
    publicationState: StatisticPublicationState,
  ): CertifiedDataCache {
    const referenceData = this.referenceDataCache;
    if (!referenceData) {
      throw new Error(
        'Reference data must be loaded before artifact hydration',
      );
    }
    const artifactPublicationState: StatisticPublicationState = {
      ...publicationState,
      revision: payload.identity.statisticRevision,
      currentPublishedDate: payload.identity.currentPublishedDate,
      historicDirtyFrom: payload.identity.historicDirtyFrom,
      historicDirtyThrough: payload.identity.historicDirtyThrough,
      historicMapCursor: payload.identity.historicMapCursor,
      historicStatsCursor: payload.identity.historicStatsCursor,
      sourceRevision: payload.identity.sourceRevision,
      historicComputeEpoch: payload.identity.historicComputeEpoch,
    };
    const cacheWithoutFingerprint: Omit<CertifiedDataCache, 'fingerprint'> = {
      ...referenceData,
      revision: payload.identity.statisticRevision,
      publicationState: artifactPublicationState,
      mode: payload.identity.mode,
      dataArea: payload.dataArea,
      dataDepartement: payload.dataDepartement,
      dataCommune: payload.dataCommune,
      firstDate: payload.identity.firstDate,
      latestDate: payload.identity.latestDate,
      dateCount: payload.identity.dateCount,
      departmentCount: payload.identity.departmentCount,
      communeCount: payload.identity.communeCount,
      artifactIdentity: { ...payload.identity },
      artifactPublicationId: payload.identity.id,
      artifactProtocolVersion: payload.identity.protocolVersion,
      artifactSourceRevision: payload.identity.sourceRevision,
      latestCommuneWeights: payload.latestCommuneWeights,
      artifactHistoricDirtyFrom: payload.identity.historicDirtyFrom,
      artifactHistoricDirtyThrough: payload.identity.historicDirtyThrough,
      artifactHistoricMapCursor: payload.identity.historicMapCursor,
      artifactHistoricStatsCursor: payload.identity.historicStatsCursor,
      artifactHistoricComputeEpoch: payload.identity.historicComputeEpoch,
      loadedAt: new Date(),
    };
    this.assertArtifactCollections(
      cacheWithoutFingerprint,
      payload.identity.materializationStrategy === 'sparse-current',
    );
    const fingerprint = this.computeStatisticCacheFingerprint(
      cacheWithoutFingerprint,
    );
    if (fingerprint !== payload.identity.contentFingerprint) {
      throw new Error('Statistic artifact public fingerprint is invalid');
    }
    return {
      ...cacheWithoutFingerprint,
      fingerprint,
      publicationState,
    };
  }

  private assertArtifactCollections(
    cache: Omit<CertifiedDataCache, 'fingerprint'>,
    allowSparseDates = false,
  ): void {
    const areaDates = cache.dataArea.map(({ date }) => String(date));
    const departmentDates = cache.dataDepartement.map(({ date }) =>
      String(date),
    );
    if (
      areaDates.length !== cache.dateCount ||
      departmentDates.length !== cache.dateCount ||
      areaDates.some((date, index) => date !== departmentDates[index]) ||
      areaDates[0] !== cache.firstDate ||
      areaDates[areaDates.length - 1] !== cache.latestDate ||
      areaDates.some(
        (date, index) =>
          index > 0 &&
          (allowSparseDates
            ? date <= areaDates[index - 1]
            : date !==
              moment
                .utc(areaDates[index - 1], 'YYYY-MM-DD', true)
                .add(1, 'day')
                .format('YYYY-MM-DD')),
      )
    ) {
      throw new Error('Statistic artifact date coverage is invalid');
    }
    const expectedDepartments = new Set(
      cache.departements.map(({ code }) => String(code)),
    );
    if (
      expectedDepartments.size !== cache.departmentCount ||
      cache.dataDepartement.some(({ departements }) => {
        const codes = new Set(
          (departements ?? []).map(({ code }) => String(code)),
        );
        return (
          codes.size !== expectedDepartments.size ||
          [...expectedDepartments].some((code) => !codes.has(code))
        );
      })
    ) {
      throw new Error('Statistic artifact department coverage is invalid');
    }
    const communeCodes = new Set(
      cache.dataCommune.map(({ code }) => String(code)),
    );
    const weightCodes = new Set(
      cache.latestCommuneWeights.map(([code]) => String(code)),
    );
    if (
      cache.dataCommune.length !== cache.communeCount ||
      communeCodes.size !== cache.communeCount ||
      weightCodes.size !== cache.communeCount ||
      [...communeCodes].some((code) => !weightCodes.has(code))
    ) {
      throw new Error('Statistic artifact commune coverage is invalid');
    }
  }

  private async loadDataOnce(
    publicationState: StatisticPublicationState,
    providedManager?: EntityManager,
  ): Promise<CertifiedDataCache> {
    const currentPublishedDate = publicationState.currentPublishedDate;
    if (
      !currentPublishedDate ||
      !moment(currentPublishedDate, 'YYYY-MM-DD', true).isValid() ||
      moment(currentPublishedDate, 'YYYY-MM-DD').isBefore(
        moment(this.beginDate, 'YYYY-MM-DD'),
        'day',
      )
    ) {
      throw new Error('No valid current publication date is available');
    }
    if (providedManager) {
      return this.loadDataCandidateWithinManager(
        publicationState,
        providedManager,
      );
    }
    const queryRunner = this.dataSource.createQueryRunner();
    let connected = false;
    let transactionStarted = false;
    try {
      await queryRunner.connect();
      connected = true;
      await queryRunner.startTransaction('REPEATABLE READ');
      transactionStarted = true;
      await queryRunner.query('SET TRANSACTION READ ONLY');

      const candidate = await this.loadDataCandidateWithinManager(
        publicationState,
        queryRunner.manager,
      );
      await queryRunner.commitTransaction();
      transactionStarted = false;
      return candidate;
    } catch (error) {
      if (transactionStarted) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    } finally {
      this.data = [];
      if (connected) {
        await queryRunner.release();
      }
    }
  }

  private async loadDataCandidateWithinManager(
    publicationState: StatisticPublicationState,
    manager: EntityManager,
  ): Promise<CertifiedDataCache> {
    const currentPublishedDate = publicationState.currentPublishedDate!;
    this.logger.log('LOAD DATA');
    const referenceData = await this.loadRefData(manager);
    this.logMemoryUsage();

    this.data = this.generateDateRange(this.beginDate, currentPublishedDate);
    const expectedCommuneCount = await this.assertSnapshotCoverage(
      publicationState,
      manager,
    );
    const departmentData = await this.loadDepartementData(
      publicationState,
      manager,
      referenceData,
    );
    this.data = [];

    const loadedCommuneCount = await this.loadCommuneData(
      publicationState,
      manager,
    );
    if (loadedCommuneCount !== expectedCommuneCount) {
      throw new Error(
        `The commune statistic repository contains ${loadedCommuneCount}/${expectedCommuneCount} certified communes`,
      );
    }
    return this.createCertifiedDataCandidate(
      referenceData,
      publicationState,
      departmentData,
      expectedCommuneCount,
    );
  }

  private async ensureCertifiedDataCache(): Promise<CertifiedDataCache> {
    const currentCache = this.certifiedDataCache;
    if (currentCache) {
      this.startCertifiedDataRefresh();
      return currentCache;
    }

    try {
      await this.loadData();
    } catch (error) {
      throw new HttpException(
        {
          status: 'unavailable',
          message:
            'Les statistiques publiques sont temporairement indisponibles.',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
        { cause: error },
      );
    }
    if (!this.certifiedDataCache) {
      throw new HttpException(
        {
          status: 'unavailable',
          message:
            'Les statistiques publiques sont temporairement indisponibles.',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.certifiedDataCache;
  }

  private startCertifiedDataRefresh(): void {
    if (this.dataLoading || this.certifiedDataRefreshLoading) {
      return;
    }
    const refresh = (async () => {
      const publicationState = await this.getPublicationState();
      if (
        this.certifiedDataCache &&
        this.canReuseCertifiedCache(
          this.certifiedDataCache,
          publicationState,
        ) &&
        !(await this.shouldRefreshUnchangedLegacyCache(publicationState))
      ) {
        this.startCandidateDataPreload(publicationState);
        this.certifiedDataCache.publicationState = publicationState;
        this.publicationState = publicationState;
        this.failedPublicationStateToken = null;
        this.failedPublicationAt = 0;
        this.lastDataCacheError = null;
        return;
      }
      const publicationStateToken =
        this.getPublicationStateToken(publicationState);
      if (
        this.failedPublicationStateToken === publicationStateToken &&
        Date.now() - this.failedPublicationAt <
          this.publicationRefreshRetryIntervalMs
      ) {
        return;
      }
      await this.loadData(publicationState);
    })();
    this.certifiedDataRefreshLoading = refresh;
    void refresh
      .catch((error) => {
        this.logger.warn(
          `PUBLIC DATA CACHE REFRESH FAILED - SERVING LAST VALID CACHE: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        if (this.certifiedDataRefreshLoading === refresh) {
          this.certifiedDataRefreshLoading = null;
        }
      });
  }

  @Cron(CronExpression.EVERY_10_SECONDS)
  async refreshDistributedStatisticCache(): Promise<void> {
    if (process.env.VIGIEAU_PROCESS_ROLE === 'statcache') return;
    try {
      if (
        !this.isStatisticArtifactCacheEnabled() ||
        !this.isDistributedStatisticCacheEnabled()
      ) {
        return;
      }
      this.startCertifiedDataRefresh();
    } catch (error) {
      this.logger.warn(
        `DISTRIBUTED STATISTIC CACHE CHECK FAILED: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private startCandidateDataPreload(
    publicationState: StatisticPublicationState,
  ): void {
    if (!this.isDistributedStatisticCacheEnabled()) return;
    const candidateId =
      publicationState.statisticCacheCandidatePublicationId ?? null;
    if (!candidateId) {
      if (
        this.candidateDataCache?.artifactPublicationId !==
        publicationState.statisticCachePublicationId
      ) {
        this.candidateDataCache = null;
      }
      this.failedCandidatePublicationId = null;
      this.failedCandidateAt = 0;
      this.failedCandidatePhase = null;
      return;
    }
    if (
      this.candidateDataCache?.artifactPublicationId === candidateId ||
      this.candidateDataCacheLoading ||
      (this.failedCandidatePublicationId === candidateId &&
        Date.now() - this.failedCandidateAt <
          this.publicationRefreshRetryIntervalMs)
    ) {
      return;
    }
    const artifactService = this.statisticCacheArtifactService;
    if (!artifactService) return;
    const preload = (async () => {
      try {
        const payload = await artifactService.loadCandidate();
        if (
          !payload ||
          payload.identity.id !== candidateId ||
          !this.isArtifactIdentityForState(payload.identity, publicationState)
        ) {
          throw new Error('Statistic cache candidate identity is inconsistent');
        }
        await this.ensureReferenceDataCache();
        const candidateCache = this.hydrateArtifactPayload(
          payload,
          publicationState,
        );
        const latestState = await this.getPublicationState(true);
        if (
          latestState.statisticCacheCandidatePublicationId !== candidateId ||
          !this.isArtifactIdentityForState(payload.identity, latestState)
        ) {
          return;
        }
        this.candidateDataCache = candidateCache;
        this.failedCandidatePublicationId = null;
        this.failedCandidateAt = 0;
        this.failedCandidatePhase = null;
      } catch (error) {
        this.failedCandidatePublicationId = candidateId;
        this.failedCandidateAt = Date.now();
        this.failedCandidatePhase = 'candidate-preload';
        this.logger.warn(
          `STATISTIC CACHE CANDIDATE PRELOAD FAILED - SERVING ACTIVE CACHE: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    })();
    this.candidateDataCacheLoading = preload;
    void preload.finally(() => {
      if (this.candidateDataCacheLoading === preload) {
        this.candidateDataCacheLoading = null;
      }
    });
  }

  async reconcileStatisticCacheCandidate(): Promise<StatisticCacheReconcileResult> {
    try {
      if (
        !this.isStatisticArtifactCacheEnabled() ||
        !this.isDistributedStatisticCacheEnabled()
      ) {
        return { outcome: 'disabled', reason: 'feature-flag-disabled' };
      }
      const artifactService = this.statisticCacheArtifactService!;
      const publicationState = await this.getPublicationState(true);
      if (!publicationState.currentPublishedDate) {
        return { outcome: 'retry', reason: 'publication-date-unavailable' };
      }
      const target = this.getCandidateTarget(publicationState);
      const active = await artifactService.loadActiveIdentity();
      if (
        active &&
        publicationState.statisticCachePublicationId === active.id &&
        this.isArtifactIdentityForState(active, publicationState)
      ) {
        return { outcome: 'up-to-date', reason: 'active-target-matches' };
      }
      const staged = await artifactService.stageCandidate(
        target,
        async (manager) => {
          const latestState = await this.readPublicationState(manager);
          if (!this.isSameMaterializationState(publicationState, latestState)) {
            throw new Error(
              'Statistic publication state changed before materialization',
            );
          }
          const base = await artifactService.loadActive(manager);
          return this.createArtifactCandidate(latestState, base, manager);
        },
      );
      if (
        publicationState.statisticCachePublicationId === staged.id &&
        this.isArtifactIdentityForState(staged, publicationState)
      ) {
        return { outcome: 'up-to-date', reason: 'active-target-matches' };
      }
      const activation = await artifactService.activateCandidate(
        target,
        this.getRequiredStatisticAcknowledgements(),
        this.getStatisticInstanceLeaseSeconds(),
      );
      if (activation.outcome === 'activated') {
        return {
          outcome: 'activated',
          reason: `${activation.readyInstances}-acknowledgements`,
        };
      }
      return {
        outcome: activation.outcome,
        reason: activation.reason,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes('publication state changed') ||
        message.includes('materialization boundary changed') ||
        message.includes('candidate does not match its target')
      ) {
        return { outcome: 'superseded', reason: message };
      }
      if (
        message.includes('Timed out waiting') ||
        message.includes('snapshot') ||
        message.includes('current_zone_recompute_request') ||
        message.includes('monthly recovery') ||
        message.includes('refresh cooldown')
      ) {
        return { outcome: 'retry', reason: message };
      }
      throw error;
    }
  }

  private getCandidateTarget(
    publicationState: StatisticPublicationState,
  ): StatisticCacheCandidateTarget {
    return {
      statisticRevision: publicationState.revision,
      currentPublishedDate: publicationState.currentPublishedDate!,
      protocolVersion: STATISTIC_CACHE_PROTOCOL_VERSION,
      historicDirtyFrom: publicationState.historicDirtyFrom,
      historicDirtyThrough: publicationState.historicDirtyThrough,
      historicMapCursor: publicationState.historicMapCursor ?? null,
      historicStatsCursor: publicationState.historicStatsCursor ?? null,
      sourceRevision: publicationState.sourceRevision ?? null,
      historicComputeEpoch: publicationState.historicComputeEpoch ?? null,
    };
  }

  private isArtifactIdentityForState(
    identity: StatisticCacheArtifactIdentity,
    publicationState: StatisticPublicationState,
  ): boolean {
    const target = this.getCandidateTarget(publicationState);
    return (
      identity.statisticRevision === target.statisticRevision &&
      identity.currentPublishedDate === target.currentPublishedDate &&
      identity.protocolVersion === target.protocolVersion &&
      identity.historicDirtyFrom === target.historicDirtyFrom &&
      identity.historicDirtyThrough === target.historicDirtyThrough &&
      identity.historicMapCursor === target.historicMapCursor &&
      identity.historicStatsCursor === target.historicStatsCursor &&
      identity.sourceRevision === target.sourceRevision &&
      identity.historicComputeEpoch === target.historicComputeEpoch
    );
  }

  private getRequiredStatisticAcknowledgements(): number {
    const value = Number(process.env.STATISTIC_CACHE_REQUIRED_ACKS ?? 2);
    if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
      throw new Error(
        'STATISTIC_CACHE_REQUIRED_ACKS must be an integer between 1 and 100',
      );
    }
    return value;
  }

  private getStatisticInstanceLeaseSeconds(): number {
    const value = Number(
      process.env.STATISTIC_CACHE_INSTANCE_LEASE_SECONDS ?? 30,
    );
    if (!Number.isSafeInteger(value) || value < 1 || value > 3600) {
      throw new Error(
        'STATISTIC_CACHE_INSTANCE_LEASE_SECONDS must be an integer between 1 and 3600',
      );
    }
    return value;
  }

  async getStatisticCacheStatus(
    checkPublicationState = false,
  ): Promise<StatisticCacheStatus> {
    let availableState = this.publicationState;
    let stateCheckFailed = false;
    let currentCheckFailed = false;
    let stateCheckErrorPhase: string | null = null;
    if (checkPublicationState) {
      try {
        availableState = await this.getPublicationState(true);
      } catch {
        stateCheckFailed = true;
        currentCheckFailed = true;
        stateCheckErrorPhase = 'publication-state-check';
      }
    }

    let publicationExpectation: StatisticPublicationExpectation;
    try {
      publicationExpectation = this.getStatisticPublicationExpectation();
    } catch {
      stateCheckFailed = true;
      currentCheckFailed = true;
      stateCheckErrorPhase ??= 'publication-deadline-check';
      publicationExpectation = resolveStatisticPublicationExpectation(
        new Date(),
        DEFAULT_STATISTIC_PUBLICATION_DEADLINE,
      );
    }

    const cache = this.certifiedDataCache;
    const usable = Boolean(cache);
    let artifactEnabled = false;
    try {
      artifactEnabled = this.isStatisticArtifactCacheEnabled();
    } catch {
      stateCheckFailed = true;
      currentCheckFailed = true;
      stateCheckErrorPhase ??= 'artifact-mode-check';
    }
    let mode: StatisticCacheMode = cache?.mode ?? 'versioned';
    try {
      mode = this.getStatisticCacheMode(availableState);
    } catch {
      stateCheckFailed = true;
      currentCheckFailed = true;
      stateCheckErrorPhase ??= 'cache-mode-check';
    }
    let snapshotCoverage: LegacySnapshotCoverageStatus = {
      incompleteSnapshotCount: null,
      oldestIncompleteSnapshot: null,
    };
    if (
      (mode === 'legacy-bootstrap' || artifactEnabled) &&
      availableState?.currentPublishedDate &&
      !stateCheckFailed
    ) {
      try {
        snapshotCoverage = await this.getLegacySnapshotCoverageStatus(
          availableState.currentPublishedDate,
        );
      } catch {
        stateCheckFailed = true;
        stateCheckErrorPhase = 'snapshot-coverage-check';
      }
    }
    let artifactInstanceSummary: {
      liveInstances: number | null;
      readyInstances: number | null;
    } = { liveInstances: null, readyInstances: null };
    if (artifactEnabled && cache?.artifactPublicationId && !stateCheckFailed) {
      try {
        artifactInstanceSummary =
          await this.getStatisticArtifactInstanceSummary(cache);
      } catch {
        stateCheckFailed = true;
        stateCheckErrorPhase = 'artifact-instance-summary';
      }
    }
    let candidateSummary: {
      publicationId: string | null;
      protocolVersion: number | null;
      readyInstances: number | null;
      createdAt: string | null;
    } = {
      publicationId: null,
      protocolVersion: null,
      readyInstances: null,
      createdAt: null,
    };
    if (
      artifactEnabled &&
      availableState?.statisticCacheCandidatePublicationId &&
      !stateCheckFailed
    ) {
      try {
        candidateSummary = await this.getStatisticCandidateSummary(
          availableState.statisticCacheCandidatePublicationId,
        );
      } catch {
        stateCheckFailed = true;
        stateCheckErrorPhase = 'artifact-candidate-summary';
      }
    }
    const legacyCurrentMatches = Boolean(
      cache &&
      availableState &&
      cache.latestDate === availableState.currentPublishedDate &&
      cache.publicationState.currentPublishedDate ===
        availableState.currentPublishedDate &&
      cache.publicationState.activePublicationId ===
        availableState.activePublicationId &&
      (cache.publicationState.sourceRevision ?? null) ===
        (availableState.sourceRevision ?? null),
    );
    const artifactCurrentMatches = Boolean(
      cache?.artifactPublicationId &&
      availableState?.statisticCachePublicationId ===
        cache.artifactPublicationId &&
      cache.artifactSourceRevision !== null &&
      cache.artifactSourceRevision === availableState?.sourceRevision &&
      cache.latestDate === availableState?.currentPublishedDate,
    );
    const artifactMaterializationMatches = Boolean(
      cache?.artifactPublicationId &&
      availableState &&
      availableState.statisticCachePublicationId ===
        cache.artifactPublicationId &&
      cache.revision === availableState.revision &&
      cache.latestDate === availableState.currentPublishedDate &&
      cache.artifactSourceRevision === availableState.sourceRevision &&
      cache.artifactHistoricMapCursor === availableState.historicMapCursor &&
      cache.artifactHistoricStatsCursor ===
        availableState.historicStatsCursor &&
      cache.artifactHistoricComputeEpoch ===
        availableState.historicComputeEpoch &&
      cache.artifactHistoricDirtyFrom === availableState.historicDirtyFrom &&
      cache.artifactHistoricDirtyThrough ===
        availableState.historicDirtyThrough,
    );
    const artifactLoadTargetMatches = Boolean(
      cache?.artifactPublicationId &&
      availableState &&
      availableState.statisticCachePublicationId ===
        cache.artifactPublicationId &&
      cache.revision === availableState.revision &&
      cache.latestDate === availableState.currentPublishedDate,
    );
    const artifactHistoricIdentityMatches = Boolean(
      cache &&
      availableState &&
      this.isHistoricArtifactStateCurrent(cache, availableState),
    );
    const artifactRequiresRefresh = Boolean(
      cache?.artifactPublicationId &&
      availableState &&
      (!artifactLoadTargetMatches ||
        (availableState.historicDirtyFrom === null &&
          !artifactHistoricIdentityMatches)),
    );
    const lagDays = getPublicationLagDays(
      availableState?.currentPublishedDate ?? null,
      publicationExpectation.expectedPublishedDate,
    );
    const currentPublicationIsFresh = Boolean(
      availableState?.currentPublishedDate &&
      availableState.currentPublishedDate >=
        publicationExpectation.expectedPublishedDate &&
      availableState.currentPublishedDate <= publicationExpectation.today,
    );
    let currentSnapshotIsCertified = false;
    if (availableState?.currentPublishedDate && !currentCheckFailed) {
      try {
        currentSnapshotIsCertified = await this.isCurrentSnapshotCertified(
          availableState.currentPublishedDate,
          availableState.sourceRevision,
        );
      } catch {
        currentSnapshotIsCertified = false;
        stateCheckFailed = true;
        currentCheckFailed = true;
        stateCheckErrorPhase = 'current-snapshot-check';
      }
    }
    const currentFresh = artifactEnabled
      ? Boolean(
          cache &&
          artifactCurrentMatches &&
          currentPublicationIsFresh &&
          currentSnapshotIsCertified &&
          !currentCheckFailed,
        )
      : Boolean(
          cache &&
          legacyCurrentMatches &&
          currentPublicationIsFresh &&
          currentSnapshotIsCertified &&
          !currentCheckFailed,
        );
    const historicMapCoversPublishedStatistics = Boolean(
      availableState &&
      (availableState.historicPublishedThrough === null ||
        (availableState.historicMapCursor !== null &&
          availableState.historicMapCursor >=
            availableState.historicPublishedThrough)),
    );
    const historicComplete = Boolean(
      cache &&
      historicMapCoversPublishedStatistics &&
      (!artifactEnabled ||
        (artifactMaterializationMatches &&
          !cache.artifactHistoricDirtyFrom &&
          !cache.artifactHistoricDirtyThrough &&
          cache.artifactHistoricMapCursor ===
            availableState?.historicMapCursor &&
          cache.artifactHistoricStatsCursor ===
            availableState?.historicStatsCursor &&
          cache.artifactHistoricComputeEpoch ===
            availableState?.historicComputeEpoch)) &&
      !availableState?.historicDirtyFrom &&
      snapshotCoverage.incompleteSnapshotCount === 0 &&
      !this.legacySnapshotCoverageDirty &&
      this.isLegacyCacheContinuous(cache, availableState),
    );
    const fresh = currentFresh;
    const status = !usable ? 'unavailable' : fresh ? 'ready' : 'degraded';

    const result: StatisticCacheStatus = {
      status: stateCheckFailed && status === 'ready' ? 'degraded' : status,
      usable,
      fresh: fresh && !stateCheckFailed,
      currentFresh: currentFresh && !currentCheckFailed,
      historicComplete,
      mode,
      artifactPublicationId: cache?.artifactPublicationId ?? null,
      artifactProtocolVersion: cache?.artifactProtocolVersion ?? null,
      artifactLiveInstances: artifactInstanceSummary.liveInstances,
      artifactReadyInstances: artifactInstanceSummary.readyInstances,
      artifactCandidatePublicationId: candidateSummary.publicationId,
      artifactCandidateProtocolVersion: candidateSummary.protocolVersion,
      artifactCandidateReadyInstances: candidateSummary.readyInstances,
      targetDate: availableState?.currentPublishedDate ?? null,
      refreshStartedAt: candidateSummary.createdAt,
      nextRetryAt:
        this.failedCandidateAt > 0
          ? new Date(
              this.failedCandidateAt + this.publicationRefreshRetryIntervalMs,
            ).toISOString()
          : null,
      currentPublishedDate: availableState?.currentPublishedDate ?? null,
      expectedPublishedDate: publicationExpectation.expectedPublishedDate,
      publicationDeadline: publicationExpectation.deadline,
      lagDays,
      historicDirtyFrom: availableState?.historicDirtyFrom ?? null,
      historicDirtyThrough: availableState?.historicDirtyThrough ?? null,
      firstDate: cache?.firstDate ?? null,
      latestDate: cache?.latestDate ?? null,
      dateCount: cache?.dateCount ?? 0,
      departmentCount: cache?.departmentCount ?? 0,
      communeCount: cache?.communeCount ?? 0,
      fingerprint: cache?.fingerprint ?? null,
      loadedAt: cache?.loadedAt.toISOString() ?? null,
      ...snapshotCoverage,
      lastError: this.lastDataCacheError
        ? {
            at: this.lastDataCacheError.at.toISOString(),
            phase: this.lastDataCacheError.phase,
          }
        : stateCheckFailed
          ? {
              at: new Date().toISOString(),
              phase: stateCheckErrorPhase ?? 'publication-state-check',
            }
          : null,
    };
    if (!cache) {
      this.startColdDataLoad(stateCheckFailed ? undefined : availableState);
    } else if (
      artifactEnabled &&
      availableState &&
      !stateCheckFailed &&
      artifactRequiresRefresh
    ) {
      this.startCertifiedDataRefresh();
    } else if (
      mode === 'legacy-bootstrap' &&
      snapshotCoverage.incompleteSnapshotCount === 0 &&
      !availableState?.historicDirtyFrom &&
      (!this.isLegacyCacheContinuous(cache, availableState) ||
        this.legacySnapshotCoverageDirty)
    ) {
      this.startCertifiedDataRefresh();
    }
    return result;
  }

  getStatisticCacheAcknowledgement(): StatisticCacheAcknowledgement {
    const cache = this.certifiedDataCache;
    const candidateId =
      this.publicationState?.statisticCacheCandidatePublicationId ?? null;
    const candidate =
      candidateId &&
      this.candidateDataCache?.artifactPublicationId === candidateId
        ? this.candidateDataCache
        : null;
    const candidateFailed =
      candidateId !== null &&
      this.failedCandidatePublicationId === candidateId &&
      this.failedCandidatePhase !== null;
    const candidateAcknowledgement = {
      candidateStatisticCachePublicationId:
        candidate?.artifactPublicationId ??
        (candidateFailed ? candidateId : null),
      candidateStatisticRevision: candidate?.revision ?? null,
      candidateStatisticPublishedDate: candidate?.latestDate ?? null,
      candidateStatisticSourceRevision:
        candidate?.artifactSourceRevision ?? null,
      candidateStatisticFingerprint: candidate?.fingerprint ?? null,
      candidateStatisticProtocolVersion:
        candidate?.artifactProtocolVersion ?? null,
      candidateStatisticLastError: candidateFailed
        ? this.failedCandidatePhase
        : null,
    };
    const artifactIdentity = cache?.artifactIdentity ?? null;
    const artifactIdentityIsConsistent = Boolean(
      cache?.artifactPublicationId &&
      artifactIdentity &&
      cache.artifactPublicationId === artifactIdentity.id &&
      cache.revision === artifactIdentity.statisticRevision &&
      cache.latestDate === artifactIdentity.latestDate &&
      artifactIdentity.currentPublishedDate === artifactIdentity.latestDate &&
      cache.fingerprint === artifactIdentity.contentFingerprint &&
      cache.artifactSourceRevision === artifactIdentity.sourceRevision &&
      cache.artifactProtocolVersion === artifactIdentity.protocolVersion,
    );
    if (!artifactIdentity || !artifactIdentityIsConsistent) {
      const hasPartialArtifactIdentity = Boolean(
        cache?.artifactPublicationId || artifactIdentity,
      );
      return {
        statisticCachePublicationId: null,
        statisticRevision: null,
        statisticPublishedDate: null,
        statisticFingerprint: null,
        statisticSourceRevision: null,
        statisticProtocolVersion: null,
        statisticLastError:
          (hasPartialArtifactIdentity
            ? 'statistic-artifact-identity-inconsistent'
            : this.lastDataCacheError?.phase) ??
          'statistic-artifact-unavailable',
        ...candidateAcknowledgement,
      };
    }
    return {
      statisticCachePublicationId: artifactIdentity.id,
      statisticRevision: artifactIdentity.statisticRevision,
      statisticPublishedDate: artifactIdentity.currentPublishedDate,
      statisticFingerprint: artifactIdentity.contentFingerprint,
      statisticSourceRevision: artifactIdentity.sourceRevision,
      statisticProtocolVersion: artifactIdentity.protocolVersion,
      statisticLastError: this.lastDataCacheError?.phase ?? null,
      ...candidateAcknowledgement,
    };
  }

  private async getStatisticArtifactInstanceSummary(
    cache: CertifiedDataCache,
  ): Promise<{ liveInstances: number; readyInstances: number }> {
    const configuredLease = Number(
      process.env.STATISTIC_CACHE_INSTANCE_LEASE_SECONDS ?? 30,
    );
    if (
      !Number.isSafeInteger(configuredLease) ||
      configuredLease <= 0 ||
      configuredLease > 3600
    ) {
      throw new Error(
        'STATISTIC_CACHE_INSTANCE_LEASE_SECONDS must be an integer between 1 and 3600',
      );
    }
    const [summary] = await this.dataSource.query(
      `
        SELECT
          COUNT(*)::integer AS "liveInstances",
          COUNT(*) FILTER (
            WHERE instance."statisticCachePublicationId" = $1::uuid
              AND instance."statisticRevision" = $2::bigint
              AND instance."statisticPublishedDate" = $3::date
              AND instance."statisticFingerprint" = $4::varchar
              AND instance."statisticSourceRevision"
                IS NOT DISTINCT FROM $5::bigint
              AND instance."statisticProtocolVersion" = $6::integer
              AND instance."statisticLastError" IS NULL
          )::integer AS "readyInstances"
        FROM "zone_publication_instance" instance
        WHERE instance."heartbeatAt" >=
          now() - ($7::integer * interval '1 second')
      `,
      [
        cache.artifactPublicationId,
        cache.revision,
        cache.latestDate,
        cache.fingerprint,
        cache.artifactSourceRevision,
        cache.artifactProtocolVersion,
        configuredLease,
      ],
    );
    const liveInstances = Number(summary?.liveInstances ?? 0);
    const readyInstances = Number(summary?.readyInstances ?? 0);
    if (
      !Number.isSafeInteger(liveInstances) ||
      liveInstances < 0 ||
      !Number.isSafeInteger(readyInstances) ||
      readyInstances < 0 ||
      readyInstances > liveInstances
    ) {
      throw new Error('Statistic artifact instance summary is invalid');
    }
    return { liveInstances, readyInstances };
  }

  private async getStatisticCandidateSummary(candidateId: string): Promise<{
    publicationId: string;
    protocolVersion: number;
    readyInstances: number;
    createdAt: string;
  }> {
    const leaseSeconds = this.getStatisticInstanceLeaseSeconds();
    const [summary] = await this.dataSource.query(
      `
        SELECT
          publication."id"::text AS "publicationId",
          publication."protocolVersion",
          publication."createdAt",
          COUNT(instance."instanceId") FILTER (
            WHERE instance."candidateStatisticCachePublicationId" =
                publication."id"
              AND instance."candidateStatisticRevision" =
                publication."statisticRevision"
              AND instance."candidateStatisticPublishedDate" =
                publication."currentPublishedDate"
              AND instance."candidateStatisticSourceRevision"
                IS NOT DISTINCT FROM publication."sourceRevision"
              AND instance."candidateStatisticFingerprint" =
                publication."contentFingerprint"
              AND instance."candidateStatisticProtocolVersion" =
                publication."protocolVersion"
              AND instance."candidateStatisticLastError" IS NULL
          )::integer AS "readyInstances"
        FROM "statistic_cache_publication" publication
        LEFT JOIN "zone_publication_instance" instance
          ON instance."heartbeatAt" >=
            now() - ($2::integer * interval '1 second')
        WHERE publication."id" = $1::uuid
          AND publication."status" = 'ready'
        GROUP BY publication."id"
      `,
      [candidateId, leaseSeconds],
    );
    const readyInstances = Number(summary?.readyInstances);
    const protocolVersion = Number(summary?.protocolVersion);
    const createdAt = new Date(summary?.createdAt);
    if (
      String(summary?.publicationId ?? '') !== candidateId ||
      !Number.isSafeInteger(readyInstances) ||
      readyInstances < 0 ||
      protocolVersion !== STATISTIC_CACHE_PROTOCOL_VERSION ||
      Number.isNaN(createdAt.getTime())
    ) {
      throw new Error('Statistic cache candidate summary is invalid');
    }
    return {
      publicationId: candidateId,
      protocolVersion,
      readyInstances,
      createdAt: createdAt.toISOString(),
    };
  }

  private async isCurrentSnapshotCertified(
    currentPublishedDate: string,
    sourceRevision: string | null,
  ): Promise<boolean> {
    const [snapshot] = await this.dataSource.query(
      `
        SELECT
          snapshot."status",
          snapshot."expectedCommuneCount",
          snapshot."processedCommuneCount",
          snapshot."sourceRevision"::text AS "sourceRevision",
          (SELECT COUNT(*)::integer FROM "commune") AS "communeCount"
        FROM "statistic_commune_snapshot" snapshot
        WHERE snapshot."snapshotDate" = $1::date
          AND snapshot."scope" = 'national'
      `,
      [currentPublishedDate],
    );
    const expectedCommuneCount = Number(snapshot?.expectedCommuneCount ?? 0);
    return Boolean(
      snapshot &&
      snapshot.status === 'completed' &&
      expectedCommuneCount > 0 &&
      Number(snapshot.processedCommuneCount) === expectedCommuneCount &&
      Number(snapshot.communeCount) === expectedCommuneCount &&
      String(snapshot.sourceRevision ?? '') === String(sourceRevision ?? ''),
    );
  }

  private getStatisticPublicationExpectation(): StatisticPublicationExpectation {
    return resolveStatisticPublicationExpectation(
      new Date(),
      process.env.STATISTIC_PUBLICATION_DEADLINE?.trim() ||
        DEFAULT_STATISTIC_PUBLICATION_DEADLINE,
    );
  }

  private async getLegacySnapshotCoverageStatus(
    currentPublishedDate: string,
  ): Promise<LegacySnapshotCoverageStatus> {
    if (
      this.legacySnapshotCoverageStatus?.currentPublishedDate ===
        currentPublishedDate &&
      Date.now() - this.legacySnapshotCoverageCheckedAt <
        this.legacySnapshotCoverageCheckIntervalMs
    ) {
      return this.legacySnapshotCoverageStatus;
    }
    if (this.legacySnapshotCoverageLoading) {
      return this.legacySnapshotCoverageLoading;
    }
    const loading = this.readLegacySnapshotCoverageStatus(
      currentPublishedDate,
    ).then((coverage) => {
      this.legacySnapshotCoverageStatus = {
        ...coverage,
        currentPublishedDate,
      };
      this.legacySnapshotCoverageCheckedAt = Date.now();
      if ((coverage.incompleteSnapshotCount ?? 0) > 0) {
        this.legacySnapshotCoverageDirty = true;
      }
      return coverage;
    });
    this.legacySnapshotCoverageLoading = loading;
    try {
      return await loading;
    } finally {
      if (this.legacySnapshotCoverageLoading === loading) {
        this.legacySnapshotCoverageLoading = null;
      }
    }
  }

  private async readLegacySnapshotCoverageStatus(
    currentPublishedDate: string,
  ): Promise<LegacySnapshotCoverageStatus> {
    const [coverage] = await this.dataSource.query(
      `
        WITH incomplete_snapshot AS MATERIALIZED (
          SELECT
            "snapshotDate", "scope", "status",
            "processedCommuneCount", "expectedCommuneCount", "updatedAt"
          FROM "statistic_commune_snapshot"
          WHERE "scope" = 'bootstrap'
            OR (
              "snapshotDate" BETWEEN $1::date AND $2::date
              AND "scope" <> 'bootstrap'
              AND (
                "status" <> 'completed'
                OR "processedCommuneCount" <> "expectedCommuneCount"
              )
            )
        ), oldest_incomplete_snapshot AS MATERIALIZED (
          SELECT *
          FROM incomplete_snapshot
          ORDER BY "snapshotDate" ASC, "scope" ASC
          LIMIT 1
        )
        SELECT
          (SELECT COUNT(*)::integer FROM incomplete_snapshot)
            AS "incompleteSnapshotCount",
          oldest."snapshotDate" AS "oldestSnapshotDate",
          oldest."scope" AS "oldestSnapshotScope",
          oldest."status" AS "oldestSnapshotStatus",
          oldest."processedCommuneCount" AS "oldestProcessedCommuneCount",
          oldest."expectedCommuneCount" AS "oldestExpectedCommuneCount",
          oldest."updatedAt" AS "oldestSnapshotUpdatedAt"
        FROM (SELECT 1) singleton
        LEFT JOIN oldest_incomplete_snapshot oldest ON true
      `,
      [this.beginDate, currentPublishedDate],
    );
    const incompleteSnapshotCount = Number(
      coverage?.incompleteSnapshotCount ?? Number.NaN,
    );
    if (
      !Number.isSafeInteger(incompleteSnapshotCount) ||
      incompleteSnapshotCount < 0
    ) {
      throw new Error('Invalid statistic snapshot coverage diagnostic');
    }
    if (incompleteSnapshotCount === 0) {
      return {
        incompleteSnapshotCount,
        oldestIncompleteSnapshot: null,
      };
    }
    const processedCommuneCount = Number(
      coverage?.oldestProcessedCommuneCount ?? Number.NaN,
    );
    const expectedCommuneCount = Number(
      coverage?.oldestExpectedCommuneCount ?? Number.NaN,
    );
    if (
      !coverage?.oldestSnapshotDate ||
      !coverage?.oldestSnapshotScope ||
      !coverage?.oldestSnapshotStatus ||
      !coverage?.oldestSnapshotUpdatedAt ||
      !Number.isSafeInteger(processedCommuneCount) ||
      !Number.isSafeInteger(expectedCommuneCount)
    ) {
      throw new Error('Invalid oldest statistic snapshot diagnostic');
    }
    return {
      incompleteSnapshotCount,
      oldestIncompleteSnapshot: {
        date: this.normalizeDate(coverage.oldestSnapshotDate),
        scope: String(coverage.oldestSnapshotScope),
        status: String(coverage.oldestSnapshotStatus),
        processedCommuneCount,
        expectedCommuneCount,
        updatedAt: new Date(coverage.oldestSnapshotUpdatedAt).toISOString(),
      },
    };
  }

  private async shouldRefreshUnchangedLegacyCache(
    publicationState: StatisticPublicationState,
  ): Promise<boolean> {
    const cache = this.certifiedDataCache;
    if (
      !cache ||
      this.getStatisticCacheMode(publicationState) !== 'legacy-bootstrap' ||
      !publicationState.currentPublishedDate ||
      publicationState.historicDirtyFrom !== null
    ) {
      return false;
    }
    const coverage = await this.getLegacySnapshotCoverageStatus(
      publicationState.currentPublishedDate,
    );
    if (coverage.incompleteSnapshotCount !== 0) {
      return false;
    }
    return (
      this.legacySnapshotCoverageDirty ||
      !this.isLegacyCacheContinuous(cache, publicationState)
    );
  }

  private isLegacyCacheContinuous(
    cache: CertifiedDataCache | null,
    publicationState: StatisticPublicationState | null,
  ): boolean {
    return Boolean(
      cache &&
      publicationState?.currentPublishedDate &&
      cache.firstDate === this.beginDate &&
      cache.latestDate === publicationState.currentPublishedDate &&
      cache.dateCount ===
        this.countCivilDates(
          this.beginDate,
          publicationState.currentPublishedDate,
        ),
    );
  }

  private startColdDataLoad(
    publicationState?: StatisticPublicationState | null,
  ): void {
    if (this.certifiedDataCache || this.dataLoading) {
      return;
    }
    void this.loadData(publicationState ?? undefined).catch((error) => {
      this.logger.warn(
        `PUBLIC DATA CACHE WARM-UP FAILED: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  private getStatisticCacheMode(
    publicationState: StatisticPublicationState | null,
  ): StatisticCacheMode {
    if (publicationState?.activePublicationId) {
      return 'versioned';
    }
    return this.getConfiguredStatisticCacheMode();
  }

  private getConfiguredStatisticCacheMode(): StatisticCacheMode {
    const configuredMode =
      process.env.STATISTIC_CACHE_MODE?.trim() || 'versioned';
    if (
      configuredMode !== 'versioned' &&
      configuredMode !== 'legacy-bootstrap'
    ) {
      throw new Error(`Unsupported STATISTIC_CACHE_MODE: ${configuredMode}`);
    }
    return configuredMode;
  }

  private async assertSnapshotCoverage(
    publicationState: StatisticPublicationState,
    manager: EntityManager,
  ): Promise<number> {
    const currentPublishedDate = publicationState.currentPublishedDate!;
    const snapshots: Array<{
      snapshotDate: string | Date;
      scope: string;
      status: string;
      expectedCommuneCount: string | number;
      processedCommuneCount: string | number;
    }> = await manager.query(
      `
        SELECT
          "snapshotDate", "scope", "status",
          "expectedCommuneCount", "processedCommuneCount"
        FROM "statistic_commune_snapshot"
        WHERE "scope" = 'bootstrap'
           OR "snapshotDate" BETWEEN $1::date AND $2::date
        ORDER BY "snapshotDate" ASC, "scope" ASC
      `,
      [
        this.getStatisticCacheMode(publicationState) === 'legacy-bootstrap'
          ? this.beginDate
          : this.releaseDate,
        currentPublishedDate,
      ],
    );
    const isIncomplete = (snapshot: (typeof snapshots)[number]) =>
      snapshot.status !== 'completed' ||
      Number(snapshot.processedCommuneCount) !==
        Number(snapshot.expectedCommuneCount);
    const bootstrapBarrier = snapshots.find(
      (snapshot) => snapshot.scope === 'bootstrap',
    );
    if (bootstrapBarrier) {
      throw new Error(
        `Statistic bootstrap barrier ${this.normalizeDate(bootstrapBarrier.snapshotDate)} is active`,
      );
    }
    const incomplete = snapshots.find(isIncomplete);
    if (
      this.getStatisticCacheMode(publicationState) === 'legacy-bootstrap' &&
      incomplete
    ) {
      throw new Error(
        `Statistic snapshot ${this.normalizeDate(incomplete.snapshotDate)} (${incomplete.scope}) is incomplete`,
      );
    }
    const currentNationalSnapshot = snapshots.find(
      (snapshot) =>
        this.normalizeDate(snapshot.snapshotDate) === currentPublishedDate &&
        snapshot.scope === 'national',
    );
    if (!currentNationalSnapshot || isIncomplete(currentNationalSnapshot)) {
      throw new Error(
        `No completed national statistic snapshot is available for ${currentPublishedDate}`,
      );
    }
    const expectedCommuneCount = Number(
      currentNationalSnapshot.expectedCommuneCount,
    );
    if (
      !Number.isSafeInteger(expectedCommuneCount) ||
      expectedCommuneCount <= 0
    ) {
      throw new Error(
        `The national statistic snapshot for ${currentPublishedDate} has an invalid expected commune count`,
      );
    }
    return expectedCommuneCount;
  }

  private createCertifiedDataCandidate(
    referenceData: ReferenceDataCache,
    publicationState: StatisticPublicationState,
    departmentData: DepartmentDataLoad,
    expectedCommuneCount: number,
  ): CertifiedDataCache {
    const mode = this.getStatisticCacheMode(publicationState);
    const areaDates = this.dataArea.map(({ date }) => String(date));
    const departmentDates = this.dataDepartement.map(({ date }) =>
      String(date),
    );
    if (
      areaDates.length === 0 ||
      departmentDates.length === 0 ||
      this.dataCommune.length === 0
    ) {
      throw new Error('The public statistic cache candidate is empty');
    }
    const communeCodes = new Set(
      this.dataCommune.map(({ code }) => String(code)),
    );
    if (
      this.dataCommune.length !== expectedCommuneCount ||
      communeCodes.size !== expectedCommuneCount
    ) {
      throw new Error(
        `The public statistic cache candidate contains ${this.dataCommune.length}/${expectedCommuneCount} communes (${communeCodes.size} unique)`,
      );
    }
    if (
      areaDates.length !== departmentDates.length ||
      areaDates.some((date, index) => date !== departmentDates[index])
    ) {
      throw new Error(
        'Area and department statistic cache candidates have different dates',
      );
    }
    if (new Set(areaDates).size !== areaDates.length) {
      throw new Error(
        'The public statistic cache candidate contains duplicate dates',
      );
    }
    if (
      areaDates.some((date, index) => index > 0 && date <= areaDates[index - 1])
    ) {
      throw new Error(
        'The public statistic cache candidate dates are not strictly ordered',
      );
    }

    const currentPublishedDate = publicationState.currentPublishedDate!;
    const firstDate = areaDates[0];
    const latestDate = areaDates[areaDates.length - 1];
    if (latestDate !== currentPublishedDate) {
      throw new Error(
        `The public statistic cache candidate ends on ${latestDate} instead of ${currentPublishedDate}`,
      );
    }
    const previousLatestDate = this.certifiedDataCache?.latestDate;
    if (previousLatestDate && latestDate < previousLatestDate) {
      throw new Error(
        `The public statistic cache candidate regresses from ${previousLatestDate} to ${latestDate}`,
      );
    }

    const expectedDepartmentCodes = new Set(
      referenceData.departements.map(({ code }) => String(code)),
    );
    if (expectedDepartmentCodes.size !== this.expectedDepartmentCount) {
      throw new Error(
        `The department reference contains ${expectedDepartmentCodes.size}/${this.expectedDepartmentCount} departments`,
      );
    }
    for (const entry of this.dataDepartement) {
      const codes = new Set(entry.departements.map(({ code }) => String(code)));
      if (
        codes.size !== expectedDepartmentCodes.size ||
        [...expectedDepartmentCodes].some((code) => !codes.has(code))
      ) {
        throw new Error(
          `Department statistics for ${entry.date} contain ${codes.size}/${expectedDepartmentCodes.size} departments`,
        );
      }
    }

    const candidateDates = new Set(areaDates);
    const coverageEnd = moment.utc(currentPublishedDate, 'YYYY-MM-DD', true);
    if (mode === 'legacy-bootstrap') {
      for (
        const date = moment.utc(this.beginDate, 'YYYY-MM-DD', true);
        date.isSameOrBefore(coverageEnd, 'day');
        date.add(1, 'day')
      ) {
        const dateString = date.format('YYYY-MM-DD');
        if (!candidateDates.has(dateString)) {
          throw new Error(
            `Legacy statistic coverage is missing candidate date ${dateString}`,
          );
        }
      }
    }
    const rawCoverageStart = moment.utc(this.releaseDate, 'YYYY-MM-DD', true);
    for (
      const date = rawCoverageStart.clone();
      date.isSameOrBefore(coverageEnd, 'day');
      date.add(1, 'day')
    ) {
      const dateString = date.format('YYYY-MM-DD');
      if (!candidateDates.has(dateString)) {
        continue;
      }
      const coveredDepartments = departmentData.coverageByDate.get(dateString);
      if (
        !coveredDepartments ||
        coveredDepartments.size !== expectedDepartmentCodes.size ||
        [...expectedDepartmentCodes].some(
          (code) => !coveredDepartments.has(code),
        )
      ) {
        throw new Error(
          `Raw department statistics for ${dateString} contain ${coveredDepartments?.size ?? 0}/${expectedDepartmentCodes.size} departments`,
        );
      }
    }

    const candidateWithoutFingerprint = {
      ...referenceData,
      revision: publicationState.revision,
      publicationState,
      mode,
      dataArea: this.dataArea,
      dataCommune: this.dataCommune,
      dataDepartement: this.dataDepartement,
      firstDate,
      latestDate,
      dateCount: areaDates.length,
      departmentCount: expectedDepartmentCodes.size,
      communeCount: this.dataCommune.length,
      artifactIdentity: null,
      artifactPublicationId: null,
      artifactProtocolVersion: null,
      artifactSourceRevision: publicationState.sourceRevision,
      latestCommuneWeights: [],
      artifactHistoricDirtyFrom: null,
      artifactHistoricDirtyThrough: null,
      artifactHistoricMapCursor: null,
      artifactHistoricStatsCursor: null,
      artifactHistoricComputeEpoch: null,
      loadedAt: new Date(),
    };
    return {
      ...candidateWithoutFingerprint,
      fingerprint: this.computeStatisticCacheFingerprint(
        candidateWithoutFingerprint,
      ),
    };
  }

  private countCivilDates(startDate: string, endDate?: string | null): number {
    if (!endDate) {
      return 0;
    }
    const start = moment.utc(startDate, 'YYYY-MM-DD', true);
    const end = moment.utc(endDate, 'YYYY-MM-DD', true);
    if (!start.isValid() || !end.isValid() || end.isBefore(start, 'day')) {
      return 0;
    }
    return end.diff(start, 'days') + 1;
  }

  private computeStatisticCacheFingerprint(
    cache: Omit<CertifiedDataCache, 'fingerprint'>,
  ): string {
    const hash = createHash('sha256');
    hash.update(
      JSON.stringify({
        revision: cache.revision,
        mode: cache.mode,
        currentPublishedDate: cache.publicationState.currentPublishedDate,
        dateCount: cache.dateCount,
        departmentCount: cache.departmentCount,
        communeCount: cache.communeCount,
      }),
    );
    for (const collection of [
      cache.dataArea,
      cache.dataDepartement,
      cache.dataCommune,
    ]) {
      for (const entry of collection) {
        hash.update(JSON.stringify(entry));
        hash.update('\n');
      }
    }
    return hash.digest('hex');
  }

  private publishCertifiedDataCache(cache: CertifiedDataCache): void {
    this.certifiedDataCache = cache;
    const closesSnapshotRepair =
      cache.mode === 'legacy-bootstrap' ||
      Boolean(
        cache.artifactIdentity &&
        this.isArtifactIdentityForState(
          cache.artifactIdentity,
          cache.publicationState,
        ) &&
        this.isLegacyCacheContinuous(cache, cache.publicationState),
      );
    if (
      cache.publicationState.historicDirtyFrom === null &&
      cache.publicationState.historicDirtyThrough === null &&
      closesSnapshotRepair
    ) {
      this.legacySnapshotCoverageDirty = false;
    }
    this.publishReferenceData(cache);
  }

  private publishReferenceData(referenceData: ReferenceDataCache): void {
    this.referenceDataCache = referenceData;
    this.referenceDataLoadedAt = Date.now();
    this.referenceDataRefreshFailedAt = 0;
    this.departements = referenceData.departements;
    this.regions = referenceData.regions;
    this.bassinsVersants = referenceData.bassinsVersants;
    this.fullArea = referenceData.fullArea;
    this.metropoleArea = referenceData.metropoleArea;
  }

  private async getPublicationState(
    force = false,
  ): Promise<StatisticPublicationState> {
    if (
      !force &&
      Date.now() - this.publicationStateCheckedAt <
        this.publicationStateCheckIntervalMs
    ) {
      if (this.publicationStateCheckError) {
        throw this.publicationStateCheckError;
      }
      if (this.publicationState) {
        return this.publicationState;
      }
    }
    if (this.publicationStateLoading) {
      return this.publicationStateLoading;
    }

    const loading = (async () => {
      try {
        const state = await this.readPublicationState(this.dataSource);
        this.publicationState = state;
        this.publicationStateCheckError = null;
        this.publicationStateCheckedAt = Date.now();
        return state;
      } catch (error) {
        const stateError =
          error instanceof Error ? error : new Error(String(error));
        this.publicationStateCheckError = stateError;
        this.publicationStateCheckedAt = Date.now();
        throw stateError;
      }
    })();
    this.publicationStateLoading = loading;
    try {
      return await loading;
    } finally {
      if (this.publicationStateLoading === loading) {
        this.publicationStateLoading = null;
      }
    }
  }

  private async readPublicationState(
    queryable: Pick<DataSource | EntityManager, 'query'>,
  ): Promise<StatisticPublicationState> {
    const sourceRevisionSql = statisticSourceRevisionSql('source_state');
    const rows: Array<{
      revision: string | number;
      activePublicationId: string | null;
      statisticCachePublicationId: string | null;
      statisticCacheCandidatePublicationId: string | null;
      currentPublishedDate: string | Date | null;
      historicPublishedThrough: string | Date | null;
      historicDirtyFrom: string | Date | null;
      historicDirtyThrough: string | Date | null;
      historicMapCursor: string | Date | null;
      historicStatsCursor: string | Date | null;
      sourceRevision: string | number | null;
      historicComputeEpoch: string | number | null;
    }> = await queryable.query(`
      SELECT
        statistic_state.revision::text AS revision,
        zone_state."activePublicationId"::text AS "activePublicationId",
        cache_state."activePublicationId"::text
          AS "statisticCachePublicationId",
        cache_state."candidatePublicationId"::text
          AS "statisticCacheCandidatePublicationId",
        statistic_state."currentPublishedDate"::text AS "currentPublishedDate",
        statistic_state."historicPublishedThrough"::text
          AS "historicPublishedThrough",
        statistic_state."historicDirtyFrom"::text AS "historicDirtyFrom",
        statistic_state."historicDirtyThrough"::text AS "historicDirtyThrough",
        config."computeMapDate"::text AS "historicMapCursor",
        config."computeStatsDate"::text AS "historicStatsCursor",
        ${sourceRevisionSql}::text AS "sourceRevision",
        config."historicComputeEpoch"::text AS "historicComputeEpoch"
      FROM "statistic_publication_state" statistic_state
      LEFT JOIN "zone_publication_state" zone_state ON zone_state."id" = 1
      LEFT JOIN "statistic_cache_state" cache_state ON cache_state."id" = 1
      LEFT JOIN "config" config ON config."id" = 1
      LEFT JOIN "zone_publication_source_state" source_state
        ON source_state."id" = 1
      WHERE statistic_state."id" = 1
      LIMIT 1
    `);
    if (rows.length !== 1 || rows[0].revision === null) {
      throw new Error('Statistic publication state is unavailable');
    }
    return {
      revision: String(rows[0].revision),
      activePublicationId: rows[0].activePublicationId
        ? String(rows[0].activePublicationId)
        : null,
      statisticCachePublicationId: rows[0].statisticCachePublicationId
        ? String(rows[0].statisticCachePublicationId)
        : null,
      statisticCacheCandidatePublicationId: rows[0]
        .statisticCacheCandidatePublicationId
        ? String(rows[0].statisticCacheCandidatePublicationId)
        : null,
      currentPublishedDate: this.normalizeDate(rows[0].currentPublishedDate),
      historicPublishedThrough: this.normalizeDate(
        rows[0].historicPublishedThrough,
      ),
      historicDirtyFrom: this.normalizeDate(rows[0].historicDirtyFrom),
      historicDirtyThrough: this.normalizeDate(rows[0].historicDirtyThrough),
      historicMapCursor: this.normalizeDate(rows[0].historicMapCursor),
      historicStatsCursor: this.normalizeDate(rows[0].historicStatsCursor),
      sourceRevision:
        rows[0].sourceRevision === null || rows[0].sourceRevision === undefined
          ? null
          : String(rows[0].sourceRevision),
      historicComputeEpoch:
        rows[0].historicComputeEpoch === null ||
        rows[0].historicComputeEpoch === undefined
          ? null
          : String(rows[0].historicComputeEpoch),
    };
  }

  private normalizeDate(
    value: string | Date | null | undefined,
  ): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    return value instanceof Date
      ? value.toISOString().slice(0, 10)
      : String(value).slice(0, 10);
  }

  private isSamePublicationState(
    left: StatisticPublicationState,
    right: StatisticPublicationState,
  ): boolean {
    return (
      left.revision === right.revision &&
      left.activePublicationId === right.activePublicationId &&
      (left.statisticCachePublicationId ?? null) ===
        (right.statisticCachePublicationId ?? null) &&
      (left.statisticCacheCandidatePublicationId ?? null) ===
        (right.statisticCacheCandidatePublicationId ?? null) &&
      left.currentPublishedDate === right.currentPublishedDate
    );
  }

  private canReuseCertifiedCache(
    cache: CertifiedDataCache,
    publicationState: StatisticPublicationState,
  ): boolean {
    if (
      !this.isSamePublicationState(cache.publicationState, publicationState)
    ) {
      return false;
    }
    if (
      !this.isStatisticArtifactCacheEnabled() ||
      this.isDistributedStatisticCacheEnabled() ||
      publicationState.historicDirtyFrom !== null
    ) {
      return true;
    }
    return this.isHistoricArtifactStateCurrent(cache, publicationState);
  }

  private isHistoricArtifactStateCurrent(
    cache: CertifiedDataCache,
    publicationState: StatisticPublicationState,
  ): boolean {
    return (
      cache.artifactHistoricDirtyFrom === publicationState.historicDirtyFrom &&
      cache.artifactHistoricDirtyThrough ===
        publicationState.historicDirtyThrough &&
      cache.artifactHistoricMapCursor === publicationState.historicMapCursor &&
      cache.artifactHistoricStatsCursor ===
        publicationState.historicStatsCursor &&
      cache.artifactHistoricComputeEpoch ===
        publicationState.historicComputeEpoch
    );
  }

  private isSameMaterializationState(
    left: StatisticPublicationState,
    right: StatisticPublicationState,
  ): boolean {
    return (
      this.isSamePublicationState(left, right) &&
      left.historicPublishedThrough === right.historicPublishedThrough &&
      left.historicDirtyFrom === right.historicDirtyFrom &&
      left.historicDirtyThrough === right.historicDirtyThrough &&
      left.historicMapCursor === right.historicMapCursor &&
      left.historicStatsCursor === right.historicStatsCursor &&
      left.sourceRevision === right.sourceRevision &&
      left.historicComputeEpoch === right.historicComputeEpoch
    );
  }

  private getPublicationStateToken(state: StatisticPublicationState): string {
    return JSON.stringify([
      state.revision,
      state.activePublicationId,
      state.statisticCachePublicationId,
      state.statisticCacheCandidatePublicationId,
      state.currentPublishedDate,
      state.historicDirtyFrom,
      state.historicDirtyThrough,
      state.historicMapCursor,
      state.historicStatsCursor,
      state.sourceRevision,
      state.historicComputeEpoch,
    ]);
  }

  /**
   * Génère une plage de dates quotidienne entre deux dates.
   *
   * @param startDate - Date de début (format YYYY-MM-DD).
   * @param endDate - Date de fin (format YYYY-MM-DD).
   * @returns Un tableau d'objets contenant des dates et des départements/communes initialisés.
   */
  private generateDateRange(startDate: string, endDate: string): any[] {
    const start = moment(startDate, 'YYYY-MM-DD');
    const end = moment(endDate, 'YYYY-MM-DD');
    const dates = [];

    while (start.isSameOrBefore(end, 'day')) {
      dates.push({
        date: start.format('YYYY-MM-DD'),
        departements: [],
      });
      start.add(1, 'day');
    }

    return dates;
  }

  /**
   * Charge les données de référence nécessaires aux réponses publiques.
   * Ces données servent de base à d'autres traitements ou filtrages dans le service.
   */
  async loadRefData(manager?: EntityManager): Promise<ReferenceDataCache> {
    if (!manager && this.referenceDataLoading) {
      return this.referenceDataLoading;
    }

    const loading = (async () => {
      const departementRepository = manager
        ? manager.getRepository(Departement)
        : this.departementRepository;
      const regionRepository = manager
        ? manager.getRepository(Region)
        : this.regionRepository;
      const bassinVersantRepository = manager
        ? manager.getRepository(BassinVersant)
        : this.bassinVersantRepository;
      const departements = (
        await departementRepository
          .createQueryBuilder('departement')
          .select('departement.id', 'id')
          .addSelect('departement.code', 'code')
          .addSelect('departement.nom', 'nom')
          .addSelect('ST_Area(departement.geom::geography)/1000000', 'area')
          .addSelect('ST_Extent(departement.geom)', 'bounds')
          .groupBy('id')
          .orderBy('nom', 'ASC')
          .getRawMany()
      ).map((departement) => ({
        ...departement,
        bounds: {
          minLat: departement.bounds.split('(')[1].split(' ')[0],
          maxLat: departement.bounds.split(',')[1].split(' ')[0],
          minLong: departement.bounds.split(' ')[1].split(',')[0],
          maxLong: departement.bounds.split(' ')[2].split(')')[0],
        },
      }));
      const regions = await regionRepository.find({
        relations: ['departements'],
        order: {
          nom: 'ASC',
        },
      });
      const bassinsVersants = await bassinVersantRepository.find({
        relations: ['departements'],
        order: {
          nom: 'ASC',
        },
      });
      const fullArea = departements.reduce(
        (acc, departement) => acc + departement.area,
        0,
      );
      const metropoleArea = departements
        .filter((departement) => departement.code.length < 3)
        .reduce((acc, departement) => acc + departement.area, 0);
      const referenceData: ReferenceDataCache = {
        departements,
        regions,
        bassinsVersants,
        fullArea,
        metropoleArea,
      };

      if (!manager) {
        // One synchronous pointer swap makes partial reference loads invisible.
        this.publishReferenceData(referenceData);
      }
      return referenceData;
    })();
    if (manager) {
      return loading;
    }
    this.referenceDataLoading = loading;
    try {
      return await loading;
    } catch (error) {
      this.referenceDataRefreshFailedAt = Date.now();
      throw error;
    } finally {
      if (this.referenceDataLoading === loading) {
        this.referenceDataLoading = null;
      }
    }
  }

  private async ensureReferenceDataCache(): Promise<ReferenceDataCache> {
    if (this.referenceDataCache) {
      this.startReferenceDataRefresh();
      return this.referenceDataCache;
    }
    return this.loadRefData();
  }

  private isReferenceDataCacheStale(): boolean {
    return (
      !this.referenceDataCache ||
      Date.now() - this.referenceDataLoadedAt >=
        this.referenceDataRefreshIntervalMs
    );
  }

  private async refreshReferenceDataCacheIfStale(): Promise<void> {
    if (!this.isReferenceDataCacheStale()) {
      return;
    }
    try {
      await this.loadRefData();
    } catch (error) {
      if (!this.referenceDataCache) {
        throw error;
      }
      this.logger.warn(
        `REFERENCE DATA CACHE REFRESH FAILED - SERVING LAST VALID CACHE: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private startReferenceDataRefresh(): void {
    if (
      !this.isReferenceDataCacheStale() ||
      this.referenceDataLoading ||
      Date.now() - this.referenceDataRefreshFailedAt <
        this.referenceDataRefreshRetryIntervalMs
    ) {
      return;
    }
    void this.loadRefData().catch((error) =>
      this.logger.warn(
        `REFERENCE DATA CACHE REFRESH FAILED - SERVING LAST VALID CACHE: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
  }

  /**
   * Charge les données départementales à partir de la base de données et les associe aux dates correspondantes.
   */
  async loadDepartementData(
    publicationState = this.publicationState,
    manager?: EntityManager,
    referenceData = this.getInstanceReferenceData(),
  ): Promise<DepartmentDataLoad> {
    if (!publicationState || this.data.length === 0) {
      throw new Error('Publication state is required to load department data');
    }
    const statisticDepartementRepository = manager
      ? manager.getRepository(StatisticDepartement)
      : this.statisticDepartementRepository;
    const statisticsDepartement = await statisticDepartementRepository.find({
      relations: ['departement'],
      order: { departement: { code: 'ASC' } },
    });
    const firstDate = this.data[0].date;
    const lastDate = this.data[this.data.length - 1].date;
    const query = manager
      ? manager.query.bind(manager)
      : this.dataSource.query.bind(this.dataSource);
    const incompleteSnapshots: Array<{ snapshotDate: string | Date }> =
      await query(
        `
          SELECT "snapshotDate"
          FROM statistic_commune_snapshot
          WHERE status <> 'completed'
            AND scope <> 'bootstrap'
            AND "snapshotDate" BETWEEN $1::date AND $2::date
        `,
        [firstDate, lastDate],
      );
    const unavailableDates = new Set(
      incompleteSnapshots.map(({ snapshotDate }) =>
        this.normalizeDate(snapshotDate),
      ),
    );

    if (
      this.getStatisticCacheMode(publicationState) === 'versioned' &&
      publicationState.historicDirtyFrom
    ) {
      const dirtyThrough =
        publicationState.historicDirtyThrough ??
        publicationState.currentPublishedDate;
      for (const entry of this.data) {
        if (
          entry.date >= publicationState.historicDirtyFrom &&
          dirtyThrough !== null &&
          entry.date <= dirtyThrough
        ) {
          unavailableDates.add(entry.date);
        }
      }
    }
    this.data = this.data.filter((entry) => !unavailableDates.has(entry.date));

    const dataByDate = new Map(this.data.map((entry) => [entry.date, entry]));
    const coverageByDate = new Map<string, Set<string>>();
    for (const statisticDepartement of statisticsDepartement) {
      const departmentCode = String(statisticDepartement.departement.code);
      for (const restriction of statisticDepartement.restrictions ?? []) {
        const restrictionDate = this.normalizeDate(restriction.date);
        if (
          !restrictionDate ||
          restrictionDate < this.beginDate ||
          unavailableDates.has(restrictionDate)
        ) {
          continue;
        }
        const dateEntry = dataByDate.get(restrictionDate);
        if (!dateEntry) {
          continue;
        }
        let coveredDepartments = coverageByDate.get(restrictionDate);
        if (!coveredDepartments) {
          coveredDepartments = new Set();
          coverageByDate.set(restrictionDate, coveredDepartments);
        }
        if (coveredDepartments.has(departmentCode)) {
          throw new Error(
            `Duplicate raw department statistic for ${departmentCode} on ${restrictionDate}`,
          );
        }
        coveredDepartments.add(departmentCode);
        dateEntry.departements.push({
          ...{ departement: departmentCode },
          ...restriction,
          date: restrictionDate,
        });
      }
    }

    this.computeDataArea(referenceData);
    this.logMemoryUsage();

    this.computeDataDepartement(referenceData);
    this.logMemoryUsage();

    for (const d of this.data) {
      d.departements = [];
    }
    return { coverageByDate };
  }

  /**
   * Charge les données communales en utilisant un traitement paginé pour limiter l'utilisation de la mémoire.
   */
  async loadCommuneData(
    publicationState = this.publicationState,
    manager?: EntityManager,
  ): Promise<number> {
    if (!publicationState?.currentPublishedDate) {
      throw new Error('Publication state is required to load commune data');
    }
    this.logger.log('COMPUTE DATA COMMUNE - BEGIN');
    this.dataCommune = [];
    const statisticCommuneRepository = manager
      ? manager.getRepository(StatisticCommune)
      : this.statisticCommuneRepository;
    const unavailableMonths = await this.findUnavailableSnapshotMonths(
      publicationState,
      manager,
    );
    const currentPublishedMonth = publicationState.currentPublishedDate.slice(
      0,
      7,
    );
    const communesCount = await statisticCommuneRepository.count();

    for (let i = 0; i < communesCount; i = i + 1000) {
      const statisticsCommune = await statisticCommuneRepository.find(<
        FindManyOptions
      >{
        select: {
          id: true,
          restrictionsByMonth: true,
          commune: {
            id: true,
            code: true,
          },
        },
        relations: ['commune'],
        take: 1000,
        skip: i,
        order: { commune: { code: 'ASC' } },
      });

      this.assertMonthlyStatisticCoverage(
        statisticsCommune,
        currentPublishedMonth,
        !unavailableMonths.has(currentPublishedMonth),
      );
      this.computeDataCommune(
        statisticsCommune,
        unavailableMonths,
        currentPublishedMonth,
      );
    }

    const unavailableMonthsAfterLoad = await this.findUnavailableSnapshotMonths(
      publicationState,
      manager,
    );
    for (const month of unavailableMonthsAfterLoad) {
      unavailableMonths.add(month);
    }
    for (const commune of this.dataCommune) {
      commune.restrictions = commune.restrictions?.filter(
        (restriction) => !unavailableMonths.has(restriction.d),
      );
    }

    this.logger.log('COMPUTE DATA COMMUNE - END');
    this.logMemoryUsage();
    return communesCount;
  }

  /**
   * Prépare les statistiques des communes à partir des données récupérées.
   *
   * @param statisticsCommune - Les données statistiques des communes.
   */
  computeDataDepartement(referenceData = this.getInstanceReferenceData()) {
    this.logger.log('COMPUTE DATA DEPARTEMENT');
    this.dataDepartement = [];
    for (const d of this.data) {
      const tmp = {
        date: d.date,
        departements: [],
      };
      referenceData.departements.forEach((departement) => {
        tmp.departements.push({
          code: departement.code,
          niveauGravite: this.findMaxNiveauGravite(
            d.departements,
            departement.code,
          ),
          niveauGraviteSup: this.findMaxNiveauGravite(
            d.departements,
            departement.code,
            'SUP',
          ),
          niveauGraviteSou: this.findMaxNiveauGravite(
            d.departements,
            departement.code,
            'SOU',
          ),
          niveauGraviteAep: this.findMaxNiveauGravite(
            d.departements,
            departement.code,
            'AEP',
          ),
        });
      });
      this.dataDepartement.push(tmp);
    }
  }

  /**
   * Prépare les statistiques des communes à partir des données récupérées.
   *
   * @param statisticsCommune - Les données statistiques des communes.
   */
  computeDataCommune(
    statisticsCommune,
    unavailableMonths: Set<string> = new Set(),
    currentPublishedMonth: string | null = null,
  ) {
    this.logger.log('COMMUNES FILTERED', statisticsCommune.length);
    for (const sc of statisticsCommune) {
      this.dataCommune.push({
        code: sc.commune.code,
        restrictions: sc.restrictionsByMonth
          ?.filter(
            (restriction) =>
              !unavailableMonths.has(restriction.date) &&
              (!currentPublishedMonth ||
                restriction.date <= currentPublishedMonth),
          )
          .map((r) => {
            return {
              d: r.date,
              p: r.ponderation,
            };
          }),
      });
    }
  }

  private assertMonthlyStatisticCoverage(
    statisticsCommune: any[],
    currentPublishedMonth: string,
    requireCurrentMonth: boolean,
  ): void {
    for (const statistic of statisticsCommune) {
      const dates = (statistic.restrictionsByMonth ?? []).map(
        ({ date }) => date,
      );
      let previousDate: string | null = null;
      for (const date of dates) {
        if (
          typeof date !== 'string' ||
          !/^\d{4}-(0[1-9]|1[0-2])$/.test(date) ||
          date > currentPublishedMonth ||
          (previousDate !== null && date <= previousDate)
        ) {
          throw new Error(
            `Invalid monthly statistic sequence for commune ${statistic.commune?.code ?? 'unknown'}`,
          );
        }
        previousDate = date;
      }
      if (requireCurrentMonth && !dates.includes(currentPublishedMonth)) {
        throw new Error(
          `Monthly statistics for commune ${statistic.commune?.code ?? 'unknown'} do not include ${currentPublishedMonth}`,
        );
      }
    }
  }

  private async findUnavailableSnapshotMonths(
    publicationState = this.publicationState,
    manager?: EntityManager,
  ): Promise<Set<string>> {
    if (!publicationState) {
      throw new Error('Publication state is required to filter commune data');
    }
    const query = manager
      ? manager.query.bind(manager)
      : this.dataSource.query.bind(this.dataSource);
    const rows: Array<{ month: string }> = await query(
      `
      SELECT DISTINCT unavailable.month
      FROM (
        SELECT to_char("snapshotDate", 'YYYY-MM') AS month
        FROM statistic_commune_snapshot
        WHERE status <> 'completed'
          AND scope <> 'bootstrap'

        UNION ALL

        SELECT to_char(dirty_month.value, 'YYYY-MM') AS month
        FROM statistic_publication_state state
        CROSS JOIN LATERAL generate_series(
          date_trunc('month', state."historicDirtyFrom"),
          date_trunc(
            'month',
            COALESCE(
              state."historicDirtyThrough",
              state."currentPublishedDate"
            )
          ),
          interval '1 month'
        ) AS dirty_month(value)
        WHERE state.id = 1
          AND $1::boolean
          AND state."historicDirtyFrom" IS NOT NULL
          AND COALESCE(
            state."historicDirtyThrough",
            state."currentPublishedDate"
          ) IS NOT NULL
      ) unavailable
    `,
      [this.getStatisticCacheMode(publicationState) === 'versioned'],
    );
    return new Set(rows.map(({ month }) => month));
  }

  /**
   * Trouve le niveau maximal de gravité pour un département donné, et éventuellement pour un type de zone spécifique.
   *
   * @param restrictions - Tableau de restrictions pour différents départements.
   * @param departementCode - Code du département pour lequel trouver le niveau de gravité.
   * @param zoneType - (Optionnel) Type de zone spécifique (ex: 'SUP', 'SOU', 'AEP').
   * @returns Le niveau de gravité maximal trouvé ou `null` si aucune restriction n'est trouvée.
   */
  findMaxNiveauGravite(
    restrictions: any[],
    departementCode: string,
    zoneType?: string,
  ) {
    const restrictionsDepartement = restrictions.find(
      (r) => r.departement === departementCode,
    );
    if (!restrictionsDepartement) {
      return null;
    }
    let zonesType = ['SUP', 'SOU', 'AEP'];
    if (zoneType) {
      zonesType = zonesType.filter((z) => z === zoneType);
    }
    const niveauxGravite = ['crise', 'alerte_renforcee', 'alerte', 'vigilance'];
    for (const niveauGravite of niveauxGravite) {
      for (const zoneType of zonesType) {
        if (restrictionsDepartement[zoneType][niveauGravite] > 0) {
          return niveauGravite;
        }
      }
    }
    return null;
  }

  /**
   * Formate la mémoire utilisée en Mo (mégaoctets).
   *
   * @param data - Taille de la mémoire en octets.
   * @returns Une chaîne de caractères représentant la taille en Mo (ex: '12.34 MB').
   */
  formatMemoryUsage(data) {
    return `${Math.round((data / 1024 / 1024) * 100) / 100} MB`;
  }

  /**
   * Journalise l'utilisation de la mémoire pour aider au débogage et au suivi des performances.
   */
  logMemoryUsage() {
    const memoryData = process.memoryUsage();

    const memoryUsage = {
      rss: `${this.formatMemoryUsage(memoryData.rss)} -> Resident Set Size - total memory allocated for the process execution`,
      heapTotal: `${this.formatMemoryUsage(memoryData.heapTotal)} -> total size of the allocated heap`,
      heapUsed: `${this.formatMemoryUsage(memoryData.heapUsed)} -> actual memory used during the execution`,
      external: `${this.formatMemoryUsage(memoryData.external)} -> V8 external memory`,
    };

    this.logger.log(memoryUsage);
  }
}
