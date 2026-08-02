import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { VigieauLogger } from '../logger/vigieau.logger';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
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

interface StatisticPublicationState {
  revision: string;
  currentPublishedDate: string | null;
  historicPublishedThrough: string | null;
  historicDirtyFrom: string | null;
  historicDirtyThrough: string | null;
}

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
  dataArea: any[];
  dataCommune: any[];
  dataDepartement: any[];
}

@Injectable()
export class DataService {
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
  private snapshotStateToken: string | null = null;
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
  private certifiedDataRefreshLoading: Promise<void> | null = null;
  private dataLoading: Promise<void> | null = null;
  private failedPublicationStateToken: string | null = null;
  private failedPublicationAt = 0;

  private readonly publicationStateCheckIntervalMs = 5_000;
  private readonly publicationRefreshRetryIntervalMs = 5_000;
  private readonly referenceDataRefreshIntervalMs = 2 * 60 * 60 * 1_000;
  private readonly referenceDataRefreshRetryIntervalMs = 5_000;

  private readonly releaseDate = '2023-07-11';
  private readonly beginDate = '2013-01-01';

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
  ) {}

  /**
   * Retourne les données de référence pour les filtres (bassins versants, régions, départements).
   * Ces données sont structurées pour faciliter leur utilisation dans des interfaces utilisateur.
   */
  async getRefData() {
    const referenceData = await this.ensureReferenceDataCache();
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
  computeDataArea() {
    this.logger.log('COMPUTE DATA AREA');
    this.dataArea = this.data.map((data) => {
      return {
        date: data.date,
        ESO: this.computeRestriction(data.departements, 'SOU', this.fullArea),
        ESU: this.computeRestriction(data.departements, 'SUP', this.fullArea),
        AEP: this.computeRestriction(data.departements, 'AEP', this.fullArea),
        bassinsVersants: this.computeEntityRestrictions(
          data,
          this.bassinsVersants,
        ),
        regions: this.computeEntityRestrictions(data, this.regions),
        departements: this.computeEntityRestrictions(data, this.departements),
      };
    });
  }

  /**
   * Calcule les restrictions pour un ensemble d'entités (bassins versants, régions, départements).
   */
  private computeEntityRestrictions(data: any, entities: any[]) {
    return entities.map((entity) => {
      const filteredDeps = this.departements.filter((dep) =>
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
            "historicDirtyThrough"
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
              state."historicDirtyFrom" IS NULL
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
    const loading = (async () => {
      try {
        let publicationState =
          requestedPublicationState ?? (await this.getPublicationState(true));
        attemptedPublicationStateToken =
          this.getPublicationStateToken(publicationState);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const publicationStateToken =
            this.getPublicationStateToken(publicationState);
          attemptedPublicationStateToken = publicationStateToken;
          if (
            hadInitializedCache &&
            this.certifiedDataCache &&
            this.isSamePublicationState(
              this.certifiedDataCache.publicationState,
              publicationState,
            )
          ) {
            await this.refreshReferenceDataCacheIfStale();
            this.publicationState = publicationState;
            this.publicationStateCheckedAt = Date.now();
            this.failedPublicationStateToken = null;
            this.failedPublicationAt = 0;
            return;
          }
          if (
            hadInitializedCache &&
            this.failedPublicationStateToken === publicationStateToken &&
            Date.now() - this.failedPublicationAt <
              this.publicationRefreshRetryIntervalMs
          ) {
            throw new Error(
              `Public data publication state ${publicationStateToken} is in refresh cooldown`,
            );
          }
          const candidateCache = await this.loadDataOnce(publicationState);
          const stateAfter = await this.getPublicationState(true);
          if (this.isSamePublicationState(publicationState, stateAfter)) {
            this.certifiedDataCache = {
              ...candidateCache,
              revision: stateAfter.revision,
              publicationState: stateAfter,
            };
            this.snapshotStateToken = stateAfter.revision;
            this.publicationState = stateAfter;
            this.failedPublicationStateToken = null;
            this.failedPublicationAt = 0;
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
        if (hadInitializedCache) {
          if (attemptedPublicationStateToken) {
            this.failedPublicationStateToken = attemptedPublicationStateToken;
            this.failedPublicationAt = Date.now();
          }
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

  private async loadDataOnce(
    publicationState: StatisticPublicationState,
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
    this.logger.log('LOAD DATA');
    const referenceData = await this.loadRefData();
    this.logMemoryUsage();

    this.data = this.generateDateRange(this.beginDate, currentPublishedDate);

    await this.loadDepartementData(publicationState);
    this.data = [];

    await this.loadCommuneData(publicationState);
    return {
      ...referenceData,
      revision: publicationState.revision,
      publicationState,
      dataArea: this.dataArea,
      dataCommune: this.dataCommune,
      dataDepartement: this.dataDepartement,
    };
  }

  private async ensureCertifiedDataCache(): Promise<CertifiedDataCache> {
    const currentCache = this.certifiedDataCache;
    if (currentCache) {
      this.startCertifiedDataRefresh();
      return currentCache;
    }

    await this.loadData();
    if (!this.certifiedDataCache) {
      throw new Error('Unable to load the latest public data revision');
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
        this.isSamePublicationState(
          this.certifiedDataCache.publicationState,
          publicationState,
        )
      ) {
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
        const rows: Array<{
          revision: string | number;
          currentPublishedDate: string | Date | null;
          historicPublishedThrough: string | Date | null;
          historicDirtyFrom: string | Date | null;
          historicDirtyThrough: string | Date | null;
        }> = await this.dataSource.query(`
        SELECT
          revision::text AS revision,
          "currentPublishedDate"::text AS "currentPublishedDate",
          "historicPublishedThrough"::text AS "historicPublishedThrough",
          "historicDirtyFrom"::text AS "historicDirtyFrom",
          "historicDirtyThrough"::text AS "historicDirtyThrough"
        FROM statistic_publication_state
        WHERE id = 1
        LIMIT 1
      `);
        if (rows.length !== 1 || rows[0].revision === null) {
          throw new Error('Statistic publication state is unavailable');
        }
        const state: StatisticPublicationState = {
          revision: String(rows[0].revision),
          currentPublishedDate: this.normalizeDate(
            rows[0].currentPublishedDate,
          ),
          historicPublishedThrough: this.normalizeDate(
            rows[0].historicPublishedThrough,
          ),
          historicDirtyFrom: this.normalizeDate(rows[0].historicDirtyFrom),
          historicDirtyThrough: this.normalizeDate(
            rows[0].historicDirtyThrough,
          ),
        };
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
      left.currentPublishedDate === right.currentPublishedDate &&
      left.historicPublishedThrough === right.historicPublishedThrough &&
      left.historicDirtyFrom === right.historicDirtyFrom &&
      left.historicDirtyThrough === right.historicDirtyThrough
    );
  }

  private getPublicationStateToken(state: StatisticPublicationState): string {
    return JSON.stringify([
      state.revision,
      state.currentPublishedDate,
      state.historicPublishedThrough,
      state.historicDirtyFrom,
      state.historicDirtyThrough,
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
  async loadRefData(): Promise<ReferenceDataCache> {
    if (this.referenceDataLoading) {
      return this.referenceDataLoading;
    }

    const loading = (async () => {
      const departements = (
        await this.departementRepository
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
      const regions = await this.regionRepository.find({
        relations: ['departements'],
        order: {
          nom: 'ASC',
        },
      });
      const bassinsVersants = await this.bassinVersantRepository.find({
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

      // One synchronous pointer swap makes partial reference loads invisible.
      this.referenceDataCache = referenceData;
      if (this.certifiedDataCache) {
        this.certifiedDataCache = {
          ...this.certifiedDataCache,
          ...referenceData,
        };
      }
      this.referenceDataLoadedAt = Date.now();
      this.referenceDataRefreshFailedAt = 0;
      this.departements = departements;
      this.regions = regions;
      this.bassinsVersants = bassinsVersants;
      this.fullArea = fullArea;
      this.metropoleArea = metropoleArea;
      return referenceData;
    })();
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
  async loadDepartementData(publicationState = this.publicationState) {
    if (!publicationState || this.data.length === 0) {
      throw new Error('Publication state is required to load department data');
    }
    const statisticsDepartement =
      await this.statisticDepartementRepository.find({
        relations: ['departement'],
      });
    const firstDate = this.data[0].date;
    const lastDate = this.data[this.data.length - 1].date;
    const incompleteSnapshots: Array<{ snapshotDate: string | Date }> =
      await this.dataSource.query(
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

    if (publicationState.historicDirtyFrom) {
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

    for (const statisticDepartement of statisticsDepartement) {
      for (const restriction of statisticDepartement.restrictions) {
        if (unavailableDates.has(restriction.date)) {
          continue;
        }
        const d = this.data.find((x) => x.date === restriction.date);
        d?.departements.push({
          ...{ departement: statisticDepartement.departement.code },
          ...restriction,
        });
      }
    }

    this.computeDataArea();
    this.logMemoryUsage();

    this.computeDataDepartement();
    this.logMemoryUsage();

    for (const d of this.data) {
      d.departements = [];
    }
  }

  /**
   * Charge les données communales en utilisant un traitement paginé pour limiter l'utilisation de la mémoire.
   */
  async loadCommuneData(publicationState = this.publicationState) {
    if (!publicationState?.currentPublishedDate) {
      throw new Error('Publication state is required to load commune data');
    }
    this.logger.log('COMPUTE DATA COMMUNE - BEGIN');
    this.dataCommune = [];
    const unavailableMonths = await this.findUnavailableSnapshotMonths();
    const currentPublishedMonth =
      publicationState.currentPublishedDate?.slice(0, 7) ?? null;
    const communesCount = await this.statisticCommuneRepository.count();

    for (let i = 0; i < communesCount; i = i + 1000) {
      const statisticsCommune = await this.statisticCommuneRepository.find(<
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
      });

      this.computeDataCommune(
        statisticsCommune,
        unavailableMonths,
        currentPublishedMonth,
      );
    }

    const unavailableMonthsAfterLoad =
      await this.findUnavailableSnapshotMonths();
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
  }

  /**
   * Prépare les statistiques des communes à partir des données récupérées.
   *
   * @param statisticsCommune - Les données statistiques des communes.
   */
  computeDataDepartement() {
    this.logger.log('COMPUTE DATA DEPARTEMENT');
    this.dataDepartement = [];
    for (const d of this.data) {
      const tmp = {
        date: d.date,
        departements: [],
      };
      this.departements.forEach((departement) => {
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

  private async findUnavailableSnapshotMonths(): Promise<Set<string>> {
    const rows: Array<{ month: string }> = await this.dataSource.query(`
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
          AND state."historicDirtyFrom" IS NOT NULL
          AND COALESCE(
            state."historicDirtyThrough",
            state."currentPublishedDate"
          ) IS NOT NULL
      ) unavailable
    `);
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
