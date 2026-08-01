import {
  HttpException,
  HttpStatus,
  Injectable,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOneOptions, Repository } from 'typeorm';
import computeBbox from '@turf/bbox';
import { VigieauLogger } from '../logger/vigieau.logger';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { keyBy } from 'lodash';
import { ZoneAlerteComputed } from '@shared/entities/zone_alerte_computed.entity';
import { DepartementsService } from '../departements/departements.service';
import { Cron, CronExpression } from '@nestjs/schedule';
import { StatisticsService } from '../statistics/statistics.service';
import { DataService } from '../data/data.service';
import { ArreteMunicipal } from '@shared/entities/arrete_municipal.entity';
import { CommunesService } from '../communes/communes.service';
import { Commune } from '@shared/entities/commune.entity';
import { Config } from '@shared/entities/config.entity';
import * as Sentry from '@sentry/nestjs';
import { randomUUID } from 'crypto';
import {
  ZonePublication,
  type ZonePublicationStatus,
} from '@shared/entities/zone_publication.entity';
import { ZonePublicationZone } from '@shared/entities/zone_publication_zone.entity';
import { ZonePublicationCommune } from '@shared/entities/zone_publication_commune.entity';
import { ZonePublicationState } from '@shared/entities/zone_publication_state.entity';
import { ZonePublicationInstance } from '@shared/entities/zone_publication_instance.entity';
import { isUUID } from 'class-validator';
import {
  buildZonePublicationAggregate,
  computeZonePublicationFingerprint,
  stableJson,
  type ZonePublicationAggregatePayload,
} from '@shared/zone_publication_materialization';

type ZoneCacheError = {
  at: Date;
  message: string;
  phase: string;
};

type ZoneSpatialFeature = Readonly<{
  geometry: string;
  zoneId: string | number;
}>;

type ZoneCacheSnapshot = Readonly<{
  zones: readonly any[];
  features: readonly ZoneSpatialFeature[];
  zonesIndex: Readonly<Record<string, any>>;
  zonesCommunesIndex: Readonly<Record<string, readonly any[]>>;
  zoneTree: any;
  communeArretesMunicipaux: readonly Commune[];
  version: Date | null;
  loadedAt: Date;
  communeAssociationCount: number;
  departmentSituation: readonly any[];
  aggregate: ZonePublicationAggregatePayload;
  publication: ZonePublicationManifest | null;
}>;

export type ZonePublicationManifest = Readonly<{
  id: string;
  revision: string;
  geojsonUrl: string | null;
  geojsonChecksum: string | null;
  pmtilesUrl: string | null;
  pmtilesChecksum: string | null;
  zoneCount: number;
  contentFingerprint: string | null;
  sourceComputedAt: Date;
  activatedAt: Date | null;
  status: ZonePublicationStatus;
}>;

type PublicationState = Readonly<{
  activePublicationId: string | null;
  candidatePublicationId: string | null;
}>;

type PublicationInstanceSummary = {
  live: number;
  activeReady: number;
  candidateReady: number;
};

export type ZoneCacheStatus = {
  status: 'ready' | 'degraded' | 'unavailable';
  usable: boolean;
  fresh: boolean;
  loading: boolean;
  loadedVersion: string | null;
  availableVersion: string | null;
  loadedAt: string | null;
  lastVersionCheckAt: string | null;
  lastSuccessfulVersionCheckAt: string | null;
  lastError: {
    at: string;
    phase: string;
  } | null;
  counts: {
    zones: number;
    features: number;
    communes: number;
    communeAssociations: number;
    arretesMunicipaux: number;
  };
  publication: {
    mode: 'legacy' | 'versioned';
    activeId: string | null;
    activeRevision: string | null;
    availableActiveId?: string | null;
    candidateId?: string | null;
    loadedFingerprint?: string | null;
    candidatePreloaded: boolean;
    cachedPublications: number;
    instances: PublicationInstanceSummary;
  };
};

@Injectable()
export class ZonesService implements OnModuleInit {
  private readonly logger = new VigieauLogger('ZonesService');
  private activeSnapshot: ZoneCacheSnapshot | null = null;
  private loading = false;
  private zonesLoadPromise: Promise<void> | null = null;
  private lastAvailableZoneComputationDate: Date | null = null;
  private lastZoneComputationCheckAt = 0;
  private lastSuccessfulZoneComputationCheckAt: Date | null = null;
  private lastCacheError: ZoneCacheError | null = null;
  private zonesRefreshPromise: Promise<void> | null = null;
  private zonesRefreshForce = false;
  private zonesRefreshForceQueued = false;
  private publicationStateReadGeneration = 0;
  private publicationStateAppliedGeneration = 0;
  private readonly zoneComputationCheckIntervalMs = 10_000;
  private readonly zoneComputationCheckGraceMs = 30_000;
  private readonly instanceId = randomUUID();
  private lastPublicationHeartbeatAt = 0;
  private publicationHeartbeatPromise: Promise<void> | null = null;
  private publicationHeartbeatQueued = false;
  private readonly publicationHeartbeatIntervalMs = 10_000;
  private readonly candidatePreloadPromises = new Map<
    string,
    Promise<ZoneCacheSnapshot>
  >();
  private readonly publicationSnapshots = new Map<string, ZoneCacheSnapshot>();
  private readonly publicationLoadPromises = new Map<
    string,
    Promise<ZoneCacheSnapshot>
  >();
  private secondarySnapshotLoadQueue: Promise<void> = Promise.resolve();
  private availablePublicationState: PublicationState = {
    activePublicationId: null,
    candidatePublicationId: null,
  };
  private arretesMunicipauxLoadPromise: Promise<Commune[]> | null = null;
  private arretesMunicipauxRefreshPromise: Promise<void> | null = null;
  private readonly maxCachedPublications = 2;

  constructor(
    @InjectRepository(ZoneAlerteComputed)
    private readonly zoneAlerteComputedRepository: Repository<ZoneAlerteComputed>,
    private readonly departementsService: DepartementsService,
    private readonly statisticsService: StatisticsService,
    private readonly dataService: DataService,
    private readonly communesService: CommunesService,
    @InjectRepository(ArreteMunicipal)
    private readonly arreteMunicipalRepository: Repository<ArreteMunicipal>,
    @InjectRepository(Config)
    private readonly configRepository: Repository<Config>,
    @InjectRepository(ZonePublication)
    private readonly zonePublicationRepository: Repository<ZonePublication>,
    @InjectRepository(ZonePublicationZone)
    private readonly zonePublicationZoneRepository: Repository<ZonePublicationZone>,
    @InjectRepository(ZonePublicationCommune)
    private readonly zonePublicationCommuneRepository: Repository<ZonePublicationCommune>,
    @InjectRepository(ZonePublicationState)
    private readonly zonePublicationStateRepository: Repository<ZonePublicationState>,
    @InjectRepository(ZonePublicationInstance)
    private readonly zonePublicationInstanceRepository: Repository<ZonePublicationInstance>,
  ) {}

  onModuleInit(): void {
    void this.loadAllZones(true);
  }

  /**
   * Recherche les zones d'alerte en fonction des coordonnées (lon/lat) ou du code commune.
   * @param queryLon - Longitude
   * @param queryLat - Latitude
   * @param commune - Code commune INSEE
   * @param profil - Profil utilisateur
   * @param zoneType - Type de zone
   */
  async find(
    queryLon?: string,
    queryLat?: string,
    commune?: string,
    profil?: string,
    zoneType?: string,
    publicationId?: string,
  ): Promise<any[]> {
    const snapshot = await this.resolveSnapshot(publicationId);

    if (queryLon && queryLat) {
      const lon = parseFloat(queryLon);
      const lat = parseFloat(queryLat);

      if (
        isNaN(lon) ||
        isNaN(lat) ||
        lon <= -180 ||
        lon >= 180 ||
        lat <= -85 ||
        lat >= 85
      ) {
        throw new HttpException(
          `lon/lat are not valid.`,
          HttpStatus.BAD_REQUEST,
        );
      }

      const zones = this.searchZonesByLonLat({ lon, lat }, false, snapshot);
      return this.formatZones(zones, profil, zoneType, commune, snapshot);
    }

    if (commune) {
      const zones = this.searchZonesByCommune(commune, false, snapshot);
      return this.formatZones(zones, profil, zoneType, commune, snapshot);
    }

    throw new HttpException(
      `Les paramètres lon/lat ou commune sont requis.`,
      HttpStatus.BAD_REQUEST,
    );
  }

  /**
   * Recherche une zone d'alerte par son ID.
   * @param id - Identifiant unique de la zone
   * @returns La zone formatée ou une exception si introuvable
   */
  async findOne(id: number, publicationId?: string): Promise<any> {
    const snapshot = await this.resolveSnapshot(publicationId);

    const z = snapshot.zones.find((zone) => zone.id === id);
    if (z) {
      return this.formatZone(z);
    }

    throw new HttpException(
      `Aucune zone d’alerte en vigueur ne correspond à cet identifiant.`,
      HttpStatus.NOT_FOUND,
    );
  }

  /**
   * Recherche les zones d'un département donné.
   * @param depCode - Code du département
   * @returns Liste des zones formatées ou une exception si aucune zone n'est trouvée
   */
  async findByDepartement(
    depCode: string,
    publicationId?: string,
  ): Promise<any> {
    const snapshot = await this.resolveSnapshot(publicationId);

    const zones = snapshot.zones.filter((zone) => zone.departement === depCode);
    if (zones.length > 0) {
      return zones.map((z) => this.formatZone(z));
    }

    throw new HttpException(
      `Aucune zone d’alerte en vigueur sur ce département.`,
      HttpStatus.NOT_FOUND,
    );
  }

  /**
   * Recherche les zones en fonction des coordonnées géographiques (lon/lat).
   * @param coords - Coordonnées géographiques
   * @param allowMultiple - Autoriser plusieurs zones du même type
   * @returns Les zones correspondant aux coordonnées
   */
  searchZonesByLonLat(
    coords: { lon: number; lat: number },
    allowMultiple = false,
    snapshot = this.requireSnapshot(),
  ): any[] {
    const { lon, lat } = coords;
    const zones = snapshot.zoneTree
      .search(lon, lat, lon, lat)
      .map((idx) => snapshot.features[idx])
      .filter((feature) =>
        booleanPointInPolygon([lon, lat], JSON.parse(feature.geometry)),
      )
      .map((feature) => snapshot.zonesIndex[feature.zoneId])
      .filter(Boolean);

    const zoneCounts = { SUP: 0, SOU: 0, AEP: 0 };
    zones.forEach((zone) => {
      if (!zone.ressourceInfluencee) {
        zoneCounts[zone.type]++;
      }
    });

    if (
      !allowMultiple &&
      (zoneCounts.SUP > 1 || zoneCounts.SOU > 1 || zoneCounts.AEP > 1)
    ) {
      throw new HttpException(
        `Un problème avec les données ne permet pas de répondre à votre demande.`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return zones;
  }

  /**
   * Recherche les zones associées à une commune donnée.
   * @param commune - Code commune INSEE
   * @param allowMultiple - Autoriser plusieurs zones du même type
   * @returns Les zones correspondant à la commune
   */
  searchZonesByCommune(
    commune,
    allowMultiple = false,
    snapshot = this.requireSnapshot(),
  ) {
    const zones = snapshot.zonesCommunesIndex[commune];
    const zoneCounts = { SUP: 0, SOU: 0, AEP: 0 };
    zones?.forEach((zone) => {
      if (!zone.ressourceInfluencee) {
        zoneCounts[zone.type]++;
      }
    });

    if (
      !allowMultiple &&
      (zoneCounts.SUP > 1 || zoneCounts.SOU > 1 || zoneCounts.AEP > 1)
    ) {
      throw new HttpException(
        `La commune comporte plusieurs zones d’alerte de même type.`,
        HttpStatus.CONFLICT,
      );
    }

    return zones;
  }

  /**
   * Charge toutes les zones et les communes associées.
   * @param onInit - Indique si le chargement est effectué à l'initialisation
   */
  async loadAllZones(onInit = false): Promise<void> {
    if (this.zonesLoadPromise) {
      return this.zonesLoadPromise;
    }

    this.zonesLoadPromise = this.loadAllZonesInternal(onInit).finally(() => {
      this.zonesLoadPromise = null;
    });

    return this.zonesLoadPromise;
  }

  private async loadAllZonesInternal(onInit = false): Promise<void> {
    this.loading = true;
    const startedAt = Date.now();
    try {
      this.logger.log('LOADING ALL ZONES & COMMUNES - BEGIN');

      const initialPublicationState = await this.getPublicationState();
      const { publicationState, snapshot } =
        await this.loadSnapshotForStablePublication(initialPublicationState);

      // Publication atomique : aucune structure du cache actif n'est modifiée
      // avant que le nouveau snapshot soit entièrement construit et validé.
      this.publishActiveSnapshot(snapshot);
      this.lastCacheError = null;
      this.logger.log(
        `LOADING ALL ZONES & COMMUNES - END ${JSON.stringify({
          version: snapshot.version?.toISOString() || null,
          publicationId: snapshot.publication?.id || null,
          publicationRevision: snapshot.publication?.revision || null,
          zones: snapshot.zones.length,
          features: snapshot.features.length,
          communes: Object.keys(snapshot.zonesCommunesIndex).length,
          communeAssociations: snapshot.communeAssociationCount,
          arretesMunicipaux: snapshot.communeArretesMunicipaux.length,
          durationMs: Date.now() - startedAt,
        })}`,
      );
      if (publicationState.candidatePublicationId) {
        this.startCandidatePreload(publicationState.candidatePublicationId);
      }
      this.prunePublicationSnapshots();
    } catch (e) {
      this.reportCacheError(e, 'load');
    } finally {
      this.loading = false;
      await this.writePublicationHeartbeat(true);
      if (onInit) {
        void this.statisticsService
          .loadStatistics()
          .catch((error) => this.reportOperationalError(error, 'statistics'));
        void this.dataService
          .loadData()
          .catch((error) => this.reportOperationalError(error, 'data'));
      }
    }
  }

  private async loadSnapshotForStablePublication(
    initialPublicationState: PublicationState,
  ): Promise<{
    publicationState: PublicationState;
    snapshot: ZoneCacheSnapshot;
  }> {
    let publicationState = initialPublicationState;

    while (true) {
      let snapshot: ZoneCacheSnapshot;
      if (publicationState.activePublicationId) {
        snapshot = await this.getOrLoadPublicationSnapshot(
          publicationState.activePublicationId,
          ['active'],
        );
      } else {
        const zoneComputationDate = await this.getZoneComputationDate();
        snapshot = await this.buildCacheSnapshot(zoneComputationDate);
      }

      const confirmedPublicationState = await this.getPublicationState();
      const loadedPublicationId = snapshot.publication?.id || null;
      if (
        confirmedPublicationState.activePublicationId === loadedPublicationId
      ) {
        return {
          publicationState: confirmedPublicationState,
          snapshot,
        };
      }

      publicationState = confirmedPublicationState;
    }
  }

  private refreshZonesIfStale(force = false): Promise<void> {
    if (this.zonesRefreshPromise) {
      if (force && !this.zonesRefreshForce) {
        this.zonesRefreshForceQueued = true;
      }
      return this.zonesRefreshPromise;
    }

    const refresh = this.runZonesRefresh(force).finally(() => {
      if (this.zonesRefreshPromise === refresh) {
        this.zonesRefreshPromise = null;
        this.zonesRefreshForce = false;
      }
    });
    this.zonesRefreshPromise = refresh;
    return refresh;
  }

  private async runZonesRefresh(force: boolean): Promise<void> {
    let nextForce = force;
    do {
      this.zonesRefreshForce = nextForce;
      this.zonesRefreshForceQueued = false;
      await this.refreshZonesIfStaleOnce(nextForce);
      nextForce = this.zonesRefreshForceQueued;
    } while (nextForce);
  }

  private async refreshZonesIfStaleOnce(force: boolean): Promise<void> {
    if (!this.activeSnapshot) {
      if (force) {
        await this.loadAllZones();
      } else {
        void this.loadAllZones();
      }
      return;
    }

    if (this.loading) {
      if (!force || !this.zonesLoadPromise) return;

      // Une requête stricte ne doit pas servir l'ancien snapshot pendant
      // qu'un chargement initié par une autre requête est encore en cours.
      await this.zonesLoadPromise;
    }

    const now = Date.now();
    if (
      !force &&
      now - this.lastZoneComputationCheckAt <
        this.zoneComputationCheckIntervalMs
    ) {
      return;
    }
    this.lastZoneComputationCheckAt = now;

    let heartbeatRequired = false;
    try {
      let publicationState = await this.getPublicationState();
      const loadedPublicationId = this.activeSnapshot.publication?.id || null;
      const publicationChanged =
        publicationState.activePublicationId !== loadedPublicationId;
      const candidatePreloaded =
        this.isCandidatePreloadCurrent(publicationState);

      if (publicationState.candidatePublicationId && !candidatePreloaded) {
        this.startCandidatePreload(publicationState.candidatePublicationId);
      }

      if (publicationChanged) {
        const stablePublication =
          await this.loadSnapshotForStablePublication(publicationState);
        publicationState = stablePublication.publicationState;
        const snapshot = stablePublication.snapshot;
        const snapshotChanged = snapshot !== this.activeSnapshot;
        this.publishActiveSnapshot(snapshot);
        this.lastCacheError = null;
        this.prunePublicationSnapshots();
        if (publicationState.candidatePublicationId) {
          this.startCandidatePreload(publicationState.candidatePublicationId);
        }
        if (snapshotChanged) {
          heartbeatRequired = true;
        }
      } else if (publicationState.activePublicationId) {
        if (!publicationState.candidatePublicationId || candidatePreloaded) {
          this.lastCacheError = null;
        }
      } else if (await this.hasNewZoneComputation()) {
        await this.loadAllZones();
      } else if (
        !publicationState.candidatePublicationId ||
        candidatePreloaded
      ) {
        this.lastCacheError = null;
      }
      await this.writePublicationHeartbeat(heartbeatRequired);
    } catch (error) {
      // Le dernier snapshot valide reste utilisable si le contrôle de version
      // ou le rechargement échoue.
      this.reportCacheError(error, 'version-check');
      await this.writePublicationHeartbeat(true);
    }
  }

  private async hasNewZoneComputation(): Promise<boolean> {
    const zoneComputationDate = await this.getZoneComputationDate();

    if (!zoneComputationDate) {
      return false;
    }

    return (
      !this.activeSnapshot?.version ||
      zoneComputationDate.getTime() > this.activeSnapshot.version.getTime()
    );
  }

  private async getZoneComputationDate(): Promise<Date | null> {
    this.lastZoneComputationCheckAt = Date.now();
    const config = await this.configRepository.findOne({
      select: {
        computeZoneAlerteComputedDate: true,
      },
      where: {
        id: 1,
      },
    });

    const computationDate = config?.computeZoneAlerteComputedDate || null;
    this.lastAvailableZoneComputationDate = computationDate;
    this.lastSuccessfulZoneComputationCheckAt = new Date();
    return computationDate;
  }

  private async buildCacheSnapshot(
    zoneComputationDate: Date | null,
  ): Promise<ZoneCacheSnapshot> {
    const zonesWithGeom = await this.loadZones();
    await this.loadZonesRestrictions(zonesWithGeom);
    await this.loadZonesCommunes(zonesWithGeom);

    const zones = this.mapZonesWithRestrictions(zonesWithGeom);
    const indexes = await this.buildZoneIndexes(zonesWithGeom, zones);
    const aggregate = buildZonePublicationAggregate(
      zones,
      indexes.communeAssociationCount,
    );
    const departmentSituation = Object.freeze(
      await this.departementsService.buildSituationSnapshot(zones, aggregate),
    );
    const communeArretesMunicipaux = Object.freeze([
      ...((await this.loadArretesMunicipaux()) || []),
    ]);

    return Object.freeze({
      zones: Object.freeze(zones),
      features: indexes.features,
      zonesIndex: indexes.zonesIndex,
      zonesCommunesIndex: indexes.zonesCommunesIndex,
      zoneTree: indexes.zoneTree,
      communeArretesMunicipaux,
      version: zoneComputationDate,
      loadedAt: new Date(),
      communeAssociationCount: indexes.communeAssociationCount,
      departmentSituation,
      aggregate,
      publication: null,
    });
  }

  private async getPublicationState(): Promise<PublicationState> {
    const generation = ++this.publicationStateReadGeneration;
    this.lastZoneComputationCheckAt = Date.now();
    const state = await this.zonePublicationStateRepository.findOne({
      select: {
        activePublicationId: true,
        candidatePublicationId: true,
      },
      where: { id: 1 },
    });
    const publicationState = Object.freeze({
      activePublicationId: state?.activePublicationId || null,
      candidatePublicationId: state?.candidatePublicationId || null,
    });
    if (
      generation < this.publicationStateReadGeneration ||
      generation < this.publicationStateAppliedGeneration
    ) {
      return this.availablePublicationState;
    }

    this.publicationStateAppliedGeneration = generation;
    this.availablePublicationState = publicationState;
    this.lastSuccessfulZoneComputationCheckAt = new Date();
    return publicationState;
  }

  private async getOrLoadPublicationSnapshot(
    publicationId: string,
    allowedStatuses: ZonePublicationStatus[],
  ): Promise<ZoneCacheSnapshot> {
    const cached = this.publicationSnapshots.get(publicationId);
    if (cached) {
      if (
        cached.publication &&
        !allowedStatuses.includes(cached.publication.status)
      ) {
        const publication = await this.zonePublicationRepository.findOne({
          select: { id: true, status: true, activatedAt: true },
          where: { id: publicationId },
        });
        if (!publication || !allowedStatuses.includes(publication.status)) {
          throw this.publicationGone();
        }
        const refreshedSnapshot = Object.freeze({
          ...cached,
          publication: Object.freeze({
            ...cached.publication,
            status: publication.status,
            activatedAt:
              publication.activatedAt || cached.publication.activatedAt,
          }),
        });
        this.publicationSnapshots.set(publicationId, refreshedSnapshot);
        return refreshedSnapshot;
      }
      return cached;
    }

    const pending = this.publicationLoadPromises.get(publicationId);
    if (pending) return pending;

    const load = this.buildPublicationSnapshot(
      publicationId,
      allowedStatuses,
    ).then((snapshot) => {
      this.publicationSnapshots.set(publicationId, snapshot);
      return snapshot;
    });
    this.publicationLoadPromises.set(publicationId, load);
    try {
      return await load;
    } finally {
      this.publicationLoadPromises.delete(publicationId);
    }
  }

  private async preloadCandidateSnapshot(
    publicationId: string,
  ): Promise<ZoneCacheSnapshot> {
    const cached = this.publicationSnapshots.get(publicationId);
    if (
      cached?.publication?.status === 'candidate' ||
      cached?.publication?.status === 'retired'
    ) {
      return cached;
    }

    const pending = this.candidatePreloadPromises.get(publicationId);
    if (pending) return pending;

    const preload = this.preloadCandidateSnapshotInternal(publicationId);
    this.candidatePreloadPromises.set(publicationId, preload);
    try {
      return await preload;
    } finally {
      this.candidatePreloadPromises.delete(publicationId);
    }
  }

  private async preloadCandidateSnapshotInternal(
    publicationId: string,
  ): Promise<ZoneCacheSnapshot> {
    // L'instance reste visible pour le quorum sans acquitter le candidat avant
    // que son snapshot complet soit construit et mis en cache.
    await this.writePublicationHeartbeat(true);
    const heartbeatTimer = setInterval(() => {
      void this.writePublicationHeartbeat(true);
    }, this.publicationHeartbeatIntervalMs);
    heartbeatTimer.unref();

    try {
      return await this.withSecondarySnapshotLoad(async () => {
        this.prunePublicationSnapshotsForCandidate(publicationId);
        return this.getOrLoadPublicationSnapshot(publicationId, [
          'candidate',
          'retired',
        ]);
      });
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  private startCandidatePreload(publicationId: string): void {
    if (
      ['candidate', 'retired'].includes(
        this.publicationSnapshots.get(publicationId)?.publication?.status || '',
      ) ||
      this.candidatePreloadPromises.has(publicationId)
    ) {
      return;
    }

    const previousError = this.lastCacheError;
    void this.preloadCandidateSnapshot(publicationId)
      .then(
        () => {
          if (
            this.availablePublicationState.candidatePublicationId ===
              publicationId &&
            this.lastCacheError === previousError
          ) {
            this.lastCacheError = null;
          }
          this.prunePublicationSnapshots();
        },
        (error) => {
          if (
            this.availablePublicationState.candidatePublicationId ===
            publicationId
          ) {
            this.reportCacheError(error, 'candidate-preload');
          } else {
            this.reportOperationalError(error, 'candidate-preload');
          }
        },
      )
      .finally(() => this.writePublicationHeartbeat(true));
  }

  private async buildPublicationSnapshot(
    publicationId: string,
    allowedStatuses: ZonePublicationStatus[],
  ): Promise<ZoneCacheSnapshot> {
    const rows = await this.zonePublicationRepository.query(
      `
        SELECT
          publication."id" AS "publicationId",
          publication."revision" AS "revision",
          publication."status" AS "status",
          publication."sourceComputedAt" AS "sourceComputedAt",
          publication."zoneCount" AS "zoneCount",
          publication."communeLinkCount" AS "communeLinkCount",
          publication."departmentCount" AS "departmentCount",
          publication."contentFingerprint" AS "contentFingerprint",
          publication."geojsonUrl" AS "geojsonUrl",
          publication."geojsonChecksum" AS "geojsonChecksum",
          publication."pmtilesUrl" AS "pmtilesUrl",
          publication."pmtilesChecksum" AS "pmtilesChecksum",
          publication."activatedAt" AS "activatedAt",
          aggregate."payload" AS "aggregatePayload",
          zone."id" AS "publicationZoneId",
          zone."sourceZoneId" AS "sourceZoneId",
          zone."departmentCode" AS "departmentCode",
          zone."publicPayload" AS "publicPayload",
          ST_AsGeoJSON(ST_Transform(zone."geom", 4326)) AS "geom",
          COALESCE(
            array_agg(commune."communeCode" ORDER BY commune."communeCode")
              FILTER (WHERE commune."communeCode" IS NOT NULL),
            ARRAY[]::varchar[]
          ) AS "communeCodes"
        FROM "zone_publication" publication
        LEFT JOIN "zone_publication_zone" zone
          ON zone."publicationId" = publication."id"
        LEFT JOIN "zone_publication_commune" commune
          ON commune."publicationId" = publication."id"
          AND commune."publicationZoneId" = zone."id"
        LEFT JOIN "zone_publication_aggregate" aggregate
          ON aggregate."publicationId" = publication."id"
        WHERE publication."id" = $1
          AND publication."status" = ANY($2::varchar[])
        GROUP BY
          publication."id",
          publication."revision",
          publication."status",
          publication."sourceComputedAt",
          publication."zoneCount",
          publication."communeLinkCount",
          publication."departmentCount",
          publication."contentFingerprint",
          publication."geojsonUrl",
          publication."geojsonChecksum",
          publication."pmtilesUrl",
          publication."pmtilesChecksum",
          publication."activatedAt",
          aggregate."payload",
          zone."id",
          zone."sourceZoneId",
          zone."departmentCode",
          zone."publicPayload",
          zone."geom"
        ORDER BY zone."id"
      `,
      [publicationId, allowedStatuses],
    );

    if (!rows.length) {
      throw new HttpException(
        `Cette publication n'est plus disponible.`,
        HttpStatus.GONE,
      );
    }

    const metadata = rows[0];
    const zoneRows = rows.filter((row) => row.publicationZoneId !== null);
    const expectedZoneCount = Number(metadata.zoneCount);
    const expectedCommuneLinkCount = Number(metadata.communeLinkCount);
    const communeAssociationCount = zoneRows.reduce(
      (count, row) => count + row.communeCodes.length,
      0,
    );
    if (
      zoneRows.length !== expectedZoneCount ||
      communeAssociationCount !== expectedCommuneLinkCount
    ) {
      throw new Error(
        `Publication ${publicationId} incohérente (zones ${zoneRows.length}/${expectedZoneCount}, communes ${communeAssociationCount}/${expectedCommuneLinkCount}).`,
      );
    }

    const zones = Object.freeze(
      zoneRows.map((row) => {
        if (
          !row.publicPayload ||
          typeof row.publicPayload !== 'object' ||
          row.publicPayload.id === undefined
        ) {
          throw new Error(
            `Publication ${publicationId}: payload public invalide pour la zone ${row.sourceZoneId}.`,
          );
        }
        return this.deepFreeze({ ...row.publicPayload });
      }),
    );
    const zonesWithGeom = zoneRows.map((row, index) => ({
      ...zones[index],
      geom: row.geom,
      communes: row.communeCodes.map((code) => ({ code })),
    }));
    const indexes = await this.buildZoneIndexes(zonesWithGeom, zones);
    const expectedAggregate = buildZonePublicationAggregate(
      zones,
      indexes.communeAssociationCount,
    );
    const aggregate = metadata.aggregatePayload || expectedAggregate;
    if (
      metadata.contentFingerprint &&
      stableJson(aggregate) !== stableJson(expectedAggregate)
    ) {
      throw new Error(
        `Publication ${publicationId}: agrégat départemental incohérent.`,
      );
    }
    if (
      metadata.contentFingerprint &&
      Number(metadata.departmentCount) !==
        Object.keys(aggregate.departments).length
    ) {
      throw new Error(
        `Publication ${publicationId}: nombre de départements incohérent.`,
      );
    }
    if (metadata.contentFingerprint) {
      const actualFingerprint = computeZonePublicationFingerprint({
        zones: zoneRows.map((row) => ({
          sourceZoneId: row.sourceZoneId,
          departmentCode: row.departmentCode,
          type: row.publicPayload.type,
          geometry: row.geom,
          publicPayload: row.publicPayload,
          communeCodes: row.communeCodes,
        })),
        aggregate,
      });
      if (actualFingerprint !== metadata.contentFingerprint) {
        throw new Error(
          `Publication ${publicationId}: empreinte de matérialisation incohérente.`,
        );
      }
    }
    const departmentSituation = Object.freeze(
      await this.departementsService.buildSituationSnapshot(zones, aggregate),
    );
    const communeArretesMunicipaux = Object.freeze([
      ...((await this.loadArretesMunicipaux()) || []),
    ]);
    const sourceComputedAt = new Date(metadata.sourceComputedAt);
    if (Number.isNaN(sourceComputedAt.getTime())) {
      throw new Error(
        `Publication ${publicationId}: date de calcul source invalide.`,
      );
    }

    return Object.freeze({
      zones,
      features: indexes.features,
      zonesIndex: indexes.zonesIndex,
      zonesCommunesIndex: indexes.zonesCommunesIndex,
      zoneTree: indexes.zoneTree,
      communeArretesMunicipaux,
      version: sourceComputedAt,
      loadedAt: new Date(),
      communeAssociationCount: indexes.communeAssociationCount,
      departmentSituation,
      aggregate,
      publication: Object.freeze({
        id: metadata.publicationId,
        revision: String(metadata.revision),
        geojsonUrl: metadata.geojsonUrl || null,
        geojsonChecksum: metadata.geojsonChecksum || null,
        pmtilesUrl: metadata.pmtilesUrl || null,
        pmtilesChecksum: metadata.pmtilesChecksum || null,
        zoneCount: expectedZoneCount,
        contentFingerprint: metadata.contentFingerprint || null,
        sourceComputedAt,
        activatedAt: metadata.activatedAt
          ? new Date(metadata.activatedAt)
          : null,
        status: metadata.status,
      }),
    });
  }

  private deepFreeze<T>(value: T): T {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
      return value;
    }
    Object.values(value).forEach((child) => this.deepFreeze(child));
    return Object.freeze(value);
  }

  private publishActiveSnapshot(snapshot: ZoneCacheSnapshot): void {
    this.departementsService.publishSituation([
      ...snapshot.departmentSituation,
    ]);
    this.activeSnapshot = snapshot;
  }

  private prunePublicationSnapshots(): void {
    if (this.publicationSnapshots.size <= this.maxCachedPublications) return;

    const protectedIds = new Set([
      this.activeSnapshot?.publication?.id,
      this.availablePublicationState.activePublicationId,
      this.availablePublicationState.candidatePublicationId,
    ]);
    for (const publicationId of this.publicationSnapshots.keys()) {
      if (this.publicationSnapshots.size <= this.maxCachedPublications) break;
      if (!protectedIds.has(publicationId)) {
        this.publicationSnapshots.delete(publicationId);
      }
    }
  }

  private prunePublicationSnapshotsForCandidate(publicationId: string): void {
    const protectedIds = new Set([
      this.activeSnapshot?.publication?.id,
      this.availablePublicationState.activePublicationId,
      publicationId,
    ]);
    for (const cachedPublicationId of this.publicationSnapshots.keys()) {
      if (!protectedIds.has(cachedPublicationId)) {
        this.publicationSnapshots.delete(cachedPublicationId);
      }
    }
  }

  private async getOrLoadRetiredSnapshot(
    publicationId: string,
  ): Promise<ZoneCacheSnapshot> {
    return this.withSecondarySnapshotLoad(async () => {
      const cached = this.publicationSnapshots.get(publicationId);
      if (cached) return cached;
      if (
        this.availablePublicationState.candidatePublicationId ||
        this.availablePublicationState.activePublicationId !==
          (this.activeSnapshot?.publication?.id || null)
      ) {
        throw new HttpException(
          `Cette publication est temporairement indisponible.`,
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }

      this.prunePublicationSnapshotsForRetiredPin(publicationId);
      return this.getOrLoadPublicationSnapshot(publicationId, ['retired']);
    });
  }

  private async withSecondarySnapshotLoad<T>(
    load: () => Promise<T>,
  ): Promise<T> {
    let releaseQueue!: () => void;
    const previousLoad = this.secondarySnapshotLoadQueue;
    this.secondarySnapshotLoadQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    await previousLoad;

    try {
      return await load();
    } finally {
      releaseQueue();
    }
  }

  private prunePublicationSnapshotsForRetiredPin(publicationId: string): void {
    const protectedIds = new Set([
      this.activeSnapshot?.publication?.id,
      this.availablePublicationState.activePublicationId,
      this.availablePublicationState.candidatePublicationId,
      publicationId,
    ]);
    for (const cachedPublicationId of this.publicationSnapshots.keys()) {
      if (!protectedIds.has(cachedPublicationId)) {
        this.publicationSnapshots.delete(cachedPublicationId);
      }
    }
  }

  private mapZonesWithRestrictions(zonesWithGeom: any[]): readonly any[] {
    return zonesWithGeom.map((z) => {
      const usages = z.restriction?.usages?.filter((u) => {
        if (z.type === 'SUP') return u.concerneEsu;
        if (z.type === 'SOU') return u.concerneEso;
        if (z.type === 'AEP') return u.concerneAep;
        return true;
      });

      const mappedUsages = usages?.map((u) => {
        let description = '';
        switch (z.niveauGravite) {
          case 'vigilance':
            description = u.descriptionVigilance;
            break;
          case 'alerte':
            description = u.descriptionAlerte;
            break;
          case 'alerte_renforcee':
            description = u.descriptionAlerteRenforcee;
            break;
          case 'crise':
            description = u.descriptionCrise;
            break;
        }
        return Object.freeze({
          id: u.id,
          nom: u.nom,
          thematique: u.thematique?.nom,
          description,
          concerneParticulier: u.concerneParticulier,
          concerneEntreprise: u.concerneEntreprise,
          concerneCollectivite: u.concerneCollectivite,
          concerneExploitation: u.concerneExploitation,
        });
      });

      return Object.freeze({
        id: z.id,
        idSandre: z.idSandre,
        code: z.code,
        nom: z.nom,
        type: z.type,
        ressourceInfluencee: z.ressourceInfluencee,
        niveauGravite: z.niveauGravite,
        departement: z.restriction?.arreteRestriction?.departement?.code,
        arrete: Object.freeze({
          id: z.restriction?.arreteRestriction?.id,
          dateDebutValidite: z.restriction?.arreteRestriction?.dateDebut,
          dateFinValidite: z.restriction?.arreteRestriction?.dateFin,
          cheminFichier: z.restriction?.arreteRestriction?.fichier?.url,
          cheminFichierArreteCadre: z.restriction?.arreteCadre?.fichier?.url,
        }),
        usages: mappedUsages ? Object.freeze(mappedUsages) : mappedUsages,
      });
    });
  }

  /**
   * Étape 1 : Charger les zones avec leurs restrictions depuis la base de données.
   */
  private async loadZones(): Promise<any[]> {
    this.logger.log('LOADING ZONES WITH RESTRICTIONS');
    const rawZones = await this.zoneAlerteComputedRepository
      .createQueryBuilder('zone_alerte_computed')
      .select('zone_alerte_computed.id', 'id')
      .addSelect('zone_alerte_computed.idSandre', 'idSandre')
      .addSelect('zone_alerte_computed.code', 'code')
      .addSelect('zone_alerte_computed.nom', 'nom')
      .addSelect('zone_alerte_computed.type', 'type')
      .addSelect(
        'zone_alerte_computed.ressourceInfluencee',
        'ressourceInfluencee',
      )
      .addSelect('zone_alerte_computed.niveauGravite', 'niveauGravite')
      .addSelect(
        'ST_AsGeoJSON(ST_TRANSFORM(zone_alerte_computed.geom, 4326))',
        'geom',
      )
      .getRawMany();

    // Mapping initial des zones avec des restrictions vides pour les enrichir plus tard.
    const toReturn = rawZones.map((zone) => ({
      ...zone,
      communes: [],
      restriction: [],
    }));

    this.logger.log(`${rawZones.length} zones loaded.`);
    return toReturn;
  }

  /**
   * Étape 2 : Charger les restrictions associées à chaque zone.
   */
  private async loadZonesRestrictions(zones: any[]): Promise<void> {
    this.logger.log('LOADING ALL ZONES & COMMUNES - MAPPING RESTRICTION');

    const batchSize = 1000;
    for (let i = 0; i < zones.length; i += batchSize) {
      const batch = zones.slice(i, i + batchSize);
      this.logger.log(
        `LOADING ALL ZONES & COMMUNES - MAPPING RESTRICTION - BATCH ${i}`,
      );
      await Promise.all(
        batch.map(async (zone) => {
          const z = await this.zoneAlerteComputedRepository.findOne(<
            FindOneOptions
          >{
            where: {
              id: zone.id,
              restriction: {
                arreteRestriction: {
                  statut: 'publie',
                },
              },
            },
            relations: [
              'restriction',
              'restriction.arreteRestriction',
              'restriction.arreteRestriction.fichier',
              'restriction.arreteRestriction.departement',
              'restriction.arreteCadre',
              'restriction.arreteCadre.fichier',
              'restriction.usages',
              'restriction.usages.thematique',
            ],
          });
          zone.restriction = z ? z.restriction : [];
          return zone;
        }),
      );
    }
  }

  /**
   * Étape 3 : Charger les communes associées à chaque zone.
   */
  private async loadZonesCommunes(zones: any[]): Promise<void> {
    this.logger.log('LOADING ALL ZONES & COMMUNES - MAPPING COMMUNES');
    const batchSize = 1000;

    for (let i = 0; i < zones.length; i += batchSize) {
      const batch = zones.slice(i, i + batchSize);

      this.logger.log(
        `LOADING ALL ZONES & COMMUNES - MAPPING COMMUNE - BATCH ${i}`,
      );
      await Promise.all(
        batch.map(async (zone) => {
          const z = await this.zoneAlerteComputedRepository.findOne({
            where: { id: zone.id },
            relations: ['communes'],
          });
          zone.communes = z ? z.communes : [];
        }),
      );
    }
  }

  /**
   * Étape 4 : Construire une structure optimisée pour les recherches spatiales.
   */
  private async buildZoneIndexes(
    zonesWithGeom: any[],
    zones: readonly any[],
  ): Promise<{
    features: readonly ZoneSpatialFeature[];
    zonesIndex: Readonly<Record<string, any>>;
    zonesCommunesIndex: Readonly<Record<string, readonly any[]>>;
    zoneTree: any;
    communeAssociationCount: number;
  }> {
    const features: ZoneSpatialFeature[] = [];
    const zonesCommunesIndex: Record<string, any[]> = {};
    const zonesIndex = keyBy(zones, 'id');
    let communeAssociationCount = 0;

    if (zones.length === 0) {
      return {
        features: Object.freeze(features),
        zonesIndex: Object.freeze(zonesIndex),
        zonesCommunesIndex: Object.freeze(zonesCommunesIndex),
        zoneTree: Object.freeze({ search: () => [] }),
        communeAssociationCount,
      };
    }

    // Import dynamique de Flatbush pour éviter les problèmes avec SSR.
    const Flatbush = (await import('flatbush')).default;
    const zoneTree = new Flatbush(zones.length);

    for (const zone of zones) {
      const fullZone = zonesWithGeom.find((z) => z.id === zone.id);
      const geojson = JSON.parse(fullZone.geom);
      const bbox = computeBbox(geojson);
      features.push(
        Object.freeze({
          geometry: fullZone.geom,
          zoneId: zone.id,
        }),
      );
      zoneTree.add(bbox[0], bbox[1], bbox[2], bbox[3]);

      for (const commune of fullZone.communes) {
        if (!zonesCommunesIndex[commune.code]) {
          zonesCommunesIndex[commune.code] = [];
        }
        zonesCommunesIndex[commune.code].push(zone);
        communeAssociationCount++;
      }
    }

    zoneTree.finish();
    Object.values(zonesCommunesIndex).forEach(Object.freeze);
    this.logger.log('ZONE TREE BUILT');
    return {
      features: Object.freeze(features),
      zonesIndex: Object.freeze(zonesIndex),
      zonesCommunesIndex: Object.freeze(zonesCommunesIndex),
      zoneTree,
      communeAssociationCount,
    };
  }

  /**
   * Étape 5 : Mettre à jour les arrêtés municipaux.
   */
  private async loadArretesMunicipaux(): Promise<Commune[]> {
    if (this.arretesMunicipauxLoadPromise) {
      return this.arretesMunicipauxLoadPromise;
    }

    const load = this.loadArretesMunicipauxFromDatabase();
    this.arretesMunicipauxLoadPromise = load;
    try {
      return await load;
    } finally {
      if (this.arretesMunicipauxLoadPromise === load) {
        this.arretesMunicipauxLoadPromise = null;
      }
    }
  }

  private async loadArretesMunicipauxFromDatabase(): Promise<Commune[]> {
    this.logger.log('MISE A JOUR DES ARRETES MUNICIPAUX');
    const communeArretesMunicipaux =
      await this.communesService.findArretesMunicipaux();
    this.logger.log(
      `LOADED ${communeArretesMunicipaux?.length || 0} ARRETES MUNICIPAUX.`,
    );
    return communeArretesMunicipaux;
  }

  private refreshArretesMunicipaux(): Promise<void> {
    if (this.arretesMunicipauxRefreshPromise) {
      return this.arretesMunicipauxRefreshPromise;
    }

    const refresh = this.refreshArretesMunicipauxInternal().finally(() => {
      if (this.arretesMunicipauxRefreshPromise === refresh) {
        this.arretesMunicipauxRefreshPromise = null;
      }
    });
    this.arretesMunicipauxRefreshPromise = refresh;
    return refresh;
  }

  private async refreshArretesMunicipauxInternal(): Promise<void> {
    const communeArretesMunicipaux = Object.freeze([
      ...((await this.loadArretesMunicipaux()) || []),
    ]);
    const snapshot = this.activeSnapshot;
    if (!snapshot) return;

    for (const [publicationId, publicationSnapshot] of this
      .publicationSnapshots) {
      this.publicationSnapshots.set(
        publicationId,
        Object.freeze({
          ...publicationSnapshot,
          communeArretesMunicipaux,
        }),
      );
    }
    this.activeSnapshot = snapshot.publication
      ? this.publicationSnapshots.get(snapshot.publication.id) || snapshot
      : Object.freeze({
          ...snapshot,
          communeArretesMunicipaux,
        });
  }

  /**
   * Formate une liste de zones d'alerte.
   * @param zones - Liste des zones à formater
   * @param profil - Profil utilisateur pour filtrer les usages
   * @param zoneType - Type de zone spécifique à sélectionner (facultatif)
   * @param commune - Code commune pour récupérer les arrêtés municipaux (facultatif)
   * @returns Liste des zones formatées ou une zone unique si `zoneType` est fourni
   */
  formatZones(
    zones: readonly any[],
    profil?: string,
    zoneType?: string,
    commune?: string,
    snapshot = this.activeSnapshot,
  ): any[] {
    if (!zones || zones.length === 0) {
      return [];
    }

    const communeArreteMunicipal = commune
      ? snapshot?.communeArretesMunicipaux.find(
          (c) => c.code === this.communesService.normalizeCodeCommune(commune),
        )?.arretesMunicipaux[0]
      : null;

    if (zoneType) {
      const toReturn = zones.find((z) => z.type === zoneType);
      return toReturn
        ? [this.formatZone(toReturn, profil, communeArreteMunicipal)]
        : [];
    }

    const formattedZones = zones.map((z) =>
      this.formatZone(z, profil, communeArreteMunicipal),
    );

    if (communeArreteMunicipal?.fichier?.url) {
      ['AEP', 'SOU', 'SUP'].forEach((zoneType) => {
        if (!formattedZones.some((zone) => zone.type === zoneType)) {
          formattedZones.push({
            id: null,
            type: zoneType,
            arreteMunicipalCheminFichier: communeArreteMunicipal.fichier.url,
          });
        }
      });
    }

    return formattedZones;
  }

  /**
   * Formate une zone d'alerte individuelle.
   * @param zone - La zone à formater
   * @param profil - Profil utilisateur pour filtrer les usages (facultatif)
   * @param arreteMunicipal - Arrêté municipal associé à la zone (facultatif)
   * @returns La zone formatée
   */
  formatZone(zone: any, profil?: string, arreteMunicipal?: ArreteMunicipal) {
    if (!zone) {
      return arreteMunicipal?.fichier?.url
        ? {
            id: null,
            arreteMunicipalCheminFichier: arreteMunicipal.fichier.url,
          }
        : null;
    }

    // Ajout de l'arrêté municipal si présent
    const formattedZone = {
      ...zone,
      arreteMunicipalCheminFichier:
        arreteMunicipal?.fichier?.url || zone.arreteMunicipalCheminFichier,
    };

    // Filtrage des usages en fonction du profil
    if (profil && Array.isArray(zone.usages)) {
      formattedZone.usages = zone.usages.filter((u) => {
        const mapping = {
          particulier: u.concerneParticulier,
          entreprise: u.concerneEntreprise,
          exploitation: u.concerneExploitation,
          collectivite: u.concerneCollectivite,
        };
        return mapping[profil];
      });
    }

    // Duplication des attributs pour être ISO SANDRE
    return {
      ...formattedZone,
      gid: zone.idSandre,
      CdZAS: zone.code,
      LbZAS: zone.nom,
      TypeZAS: zone.type,
    };
  }

  /**
   * Vérification régulière s'il n'y a pas de nouvelles zones
   */
  @Cron(CronExpression.EVERY_10_SECONDS)
  async updateZones(): Promise<void> {
    await this.refreshZonesIfStale(true);
  }

  /**
   * Vérification régulière s'il n'y a pas de nouveaaux arrêtés municipaux
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async updateArretesMunicipaux(): Promise<void> {
    try {
      // Le jeu est petit et relu intégralement : cela couvre aussi les suppressions
      // et les transactions concurrentes qu'un watermark updated_at peut manquer.
      await this.refreshArretesMunicipaux();
    } catch (error) {
      this.reportOperationalError(error, 'arretes-municipaux');
    }
  }

  async getCacheStatus(
    checkAvailableVersion = false,
  ): Promise<ZoneCacheStatus> {
    if (checkAvailableVersion) {
      try {
        const publicationState = await this.getPublicationState();
        if (!publicationState.activePublicationId) {
          await this.getZoneComputationDate();
        }
        if (
          !this.isVersionLagging() &&
          this.isCandidatePreloadCurrent(publicationState)
        ) {
          this.lastCacheError = null;
        }
      } catch (error) {
        this.reportCacheError(error, 'health-version-check');
      }
    }

    const snapshot = this.activeSnapshot;
    const versionCheckExpired =
      !this.lastSuccessfulZoneComputationCheckAt ||
      Date.now() - this.lastSuccessfulZoneComputationCheckAt.getTime() >
        this.zoneComputationCheckGraceMs;
    const usable = Boolean(snapshot);
    const candidatePreloadCurrent = this.isCandidatePreloadCurrent(
      this.availablePublicationState,
    );
    const fresh = Boolean(
      snapshot &&
      !this.isVersionLagging() &&
      candidatePreloadCurrent &&
      !versionCheckExpired &&
      !this.lastCacheError,
    );
    const status = !snapshot ? 'unavailable' : fresh ? 'ready' : 'degraded';
    const instances = await this.getPublicationInstanceSummary();

    return {
      status,
      usable,
      fresh,
      loading: this.loading,
      loadedVersion: snapshot?.version?.toISOString() || null,
      availableVersion: this.availablePublicationState.activePublicationId
        ? snapshot?.publication?.id ===
          this.availablePublicationState.activePublicationId
          ? snapshot.version?.toISOString() || null
          : null
        : this.lastAvailableZoneComputationDate?.toISOString() || null,
      loadedAt: snapshot?.loadedAt.toISOString() || null,
      lastVersionCheckAt: this.lastZoneComputationCheckAt
        ? new Date(this.lastZoneComputationCheckAt).toISOString()
        : null,
      lastSuccessfulVersionCheckAt:
        this.lastSuccessfulZoneComputationCheckAt?.toISOString() || null,
      lastError: this.lastCacheError
        ? {
            at: this.lastCacheError.at.toISOString(),
            phase: this.lastCacheError.phase,
          }
        : null,
      counts: {
        zones: snapshot?.zones.length || 0,
        features: snapshot?.features.length || 0,
        communes: snapshot
          ? Object.keys(snapshot.zonesCommunesIndex).length
          : 0,
        communeAssociations: snapshot?.communeAssociationCount || 0,
        arretesMunicipaux: snapshot?.communeArretesMunicipaux.length || 0,
      },
      publication: {
        mode: snapshot?.publication ? 'versioned' : 'legacy',
        activeId: snapshot?.publication?.id || null,
        activeRevision: snapshot?.publication?.revision || null,
        availableActiveId: this.availablePublicationState.activePublicationId,
        candidateId: this.availablePublicationState.candidatePublicationId,
        loadedFingerprint: snapshot?.publication?.contentFingerprint || null,
        candidatePreloaded: Boolean(
          this.availablePublicationState.candidatePublicationId &&
          candidatePreloadCurrent,
        ),
        cachedPublications: this.publicationSnapshots.size,
        instances,
      },
    };
  }

  async getPublication(): Promise<{
    id: string;
    revision: string;
    geojsonUrl: string | null;
    geojsonChecksum: string | null;
    pmtilesUrl: string | null;
    pmtilesChecksum: string | null;
    zoneCount: number;
    contentFingerprint?: string;
  }> {
    await this.refreshZonesIfStale(true);
    if (!this.activeSnapshot) {
      throw new HttpException(
        `Les données des zones sont en cours de chargement.`,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const publication = this.activeSnapshot?.publication;
    if (!publication) {
      throw new HttpException(
        `Aucune publication versionnée n'est disponible.`,
        HttpStatus.NOT_FOUND,
      );
    }
    return {
      id: publication.id,
      revision: publication.revision,
      geojsonUrl: publication.geojsonUrl,
      geojsonChecksum: publication.geojsonChecksum,
      pmtilesUrl: publication.pmtilesUrl,
      pmtilesChecksum: publication.pmtilesChecksum,
      zoneCount: publication.zoneCount,
      ...(publication.contentFingerprint
        ? { contentFingerprint: publication.contentFingerprint }
        : {}),
    };
  }

  private async resolveSnapshot(
    publicationId?: string,
  ): Promise<ZoneCacheSnapshot> {
    if (!publicationId) {
      await this.refreshZonesIfStale(true);
      return this.requireSnapshot();
    }
    if (!isUUID(publicationId)) {
      throw new HttpException(
        `L'identifiant de publication n'est pas valide.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    if (publicationId === this.activeSnapshot?.publication?.id) {
      return this.activeSnapshot;
    }

    let publication: Pick<ZonePublication, 'id' | 'status'> | null;
    try {
      publication = await this.zonePublicationRepository.findOne({
        select: { id: true, status: true },
        where: { id: publicationId },
      });
    } catch (error) {
      throw this.publicationUnavailable(error);
    }
    if (
      !publication ||
      (publication.status !== 'active' && publication.status !== 'retired')
    ) {
      throw this.publicationGone();
    }
    let snapshot: ZoneCacheSnapshot;
    try {
      snapshot =
        publication.status === 'retired'
          ? await this.getOrLoadRetiredSnapshot(publicationId)
          : await this.getOrLoadPublicationSnapshot(publicationId, ['active']);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw this.publicationUnavailable(error);
    }
    if (publicationId === this.availablePublicationState.activePublicationId) {
      this.publishActiveSnapshot(snapshot);
    }
    this.prunePublicationSnapshots();
    return snapshot;
  }

  private publicationGone(): HttpException {
    return new HttpException(
      `Cette publication n'est plus disponible.`,
      HttpStatus.GONE,
    );
  }

  private publicationUnavailable(error: unknown): HttpException {
    this.reportOperationalError(error, 'pinned-publication');
    return new HttpException(
      `Cette publication est temporairement indisponible.`,
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  private requireSnapshot(): ZoneCacheSnapshot {
    if (this.activeSnapshot) return this.activeSnapshot;

    throw new HttpException(
      `Les données des zones sont en cours de chargement.`,
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  private isVersionLagging(): boolean {
    if (this.availablePublicationState.activePublicationId) {
      return (
        this.activeSnapshot?.publication?.id !==
        this.availablePublicationState.activePublicationId
      );
    }
    if (this.activeSnapshot?.publication) return true;
    if (!this.lastAvailableZoneComputationDate) return false;
    if (!this.activeSnapshot?.version) return true;
    return (
      this.lastAvailableZoneComputationDate.getTime() >
      this.activeSnapshot.version.getTime()
    );
  }

  private isCandidatePreloadCurrent(state: PublicationState): boolean {
    if (!state.candidatePublicationId) return true;
    return Boolean(
      ['candidate', 'retired'].includes(
        this.publicationSnapshots.get(state.candidatePublicationId)?.publication
          ?.status || '',
      ),
    );
  }

  private writePublicationHeartbeat(force = false): Promise<void> {
    if (this.publicationHeartbeatPromise) {
      if (force) this.publicationHeartbeatQueued = true;
      return this.publicationHeartbeatPromise;
    }

    if (
      !force &&
      Date.now() - this.lastPublicationHeartbeatAt <
        this.publicationHeartbeatIntervalMs
    ) {
      return Promise.resolve();
    }

    const heartbeat = this.flushPublicationHeartbeats().finally(() => {
      if (this.publicationHeartbeatPromise === heartbeat) {
        this.publicationHeartbeatPromise = null;
      }
    });
    this.publicationHeartbeatPromise = heartbeat;
    return heartbeat;
  }

  private async flushPublicationHeartbeats(): Promise<void> {
    do {
      this.publicationHeartbeatQueued = false;
      await this.writePublicationHeartbeatOnce();
    } while (this.publicationHeartbeatQueued);
  }

  private async writePublicationHeartbeatOnce(): Promise<void> {
    const activeSnapshot = this.activeSnapshot;
    const candidateId = this.availablePublicationState.candidatePublicationId;
    const candidateSnapshot = candidateId
      ? this.publicationSnapshots.get(candidateId)
      : null;
    const acknowledgedSnapshot = candidateSnapshot || activeSnapshot;
    this.lastPublicationHeartbeatAt = Date.now();
    try {
      await this.zonePublicationInstanceRepository.upsert(
        {
          instanceId: this.instanceId,
          activePublicationId: activeSnapshot?.publication?.id || null,
          candidatePublicationId: candidateSnapshot ? candidateId : null,
          zoneCount: acknowledgedSnapshot?.zones.length ?? null,
          communeLinkCount:
            acknowledgedSnapshot?.communeAssociationCount ?? null,
          contentFingerprint:
            acknowledgedSnapshot?.publication?.contentFingerprint ?? null,
          lastError: this.lastCacheError?.phase || null,
          heartbeatAt: () => 'now()',
        },
        ['instanceId'],
      );
    } catch (error) {
      this.reportOperationalError(error, 'publication-heartbeat');
    }
  }

  private async getPublicationInstanceSummary(): Promise<PublicationInstanceSummary> {
    try {
      const [summary] = await this.zonePublicationInstanceRepository.query(
        `
          SELECT
            COUNT(*)::integer AS "live",
            COUNT(*) FILTER (
              WHERE "activePublicationId" = $1
                AND ($3::varchar IS NULL OR "contentFingerprint" = $3)
            )::integer AS "activeReady",
            COUNT(*) FILTER (
              WHERE "candidatePublicationId" = $2
                AND ($4::varchar IS NULL OR "contentFingerprint" = $4)
            )::integer AS "candidateReady"
          FROM "zone_publication_instance"
          WHERE "heartbeatAt" >= now() - interval '30 seconds'
        `,
        [
          this.activeSnapshot?.publication?.id || null,
          this.availablePublicationState.candidatePublicationId,
          this.activeSnapshot?.publication?.contentFingerprint || null,
          this.availablePublicationState.candidatePublicationId
            ? this.publicationSnapshots.get(
                this.availablePublicationState.candidatePublicationId,
              )?.publication?.contentFingerprint || null
            : null,
        ],
      );
      return {
        live: Number(summary?.live || 0),
        activeReady: Number(summary?.activeReady || 0),
        candidateReady: Number(summary?.candidateReady || 0),
      };
    } catch (error) {
      this.reportOperationalError(error, 'publication-instance-summary');
      return { live: 0, activeReady: 0, candidateReady: 0 };
    }
  }

  private reportCacheError(error: unknown, phase: string): void {
    const normalizedError =
      error instanceof Error ? error : new Error(String(error));
    this.lastCacheError = {
      at: new Date(),
      message: normalizedError.message,
      phase,
    };
    this.logger.error(
      `LOADING ALL ZONES & COMMUNES - ERROR (${phase})`,
      normalizedError.stack || normalizedError.message,
    );
    if (process.env.SENTRY_DSN?.trim()) {
      Sentry.captureException(normalizedError, {
        tags: { component: 'zones-cache', phase },
      });
    }
  }

  private reportOperationalError(error: unknown, phase: string): void {
    const normalizedError =
      error instanceof Error ? error : new Error(String(error));
    this.logger.error(
      `POST ZONE CACHE LOAD - ERROR (${phase})`,
      normalizedError.stack || normalizedError.message,
    );
    if (process.env.SENTRY_DSN?.trim()) {
      Sentry.captureException(normalizedError, {
        tags: { component: 'zones-cache', phase },
      });
    }
  }
}
