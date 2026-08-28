import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { ConfigService as NestConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Departement } from '@shared/entities/departement.entity';
import { Restriction } from '@shared/entities/restriction.entity';
import { Usage } from '@shared/entities/usage.entity';
import { ZoneAlerte } from '@shared/entities/zone_alerte.entity';
import { ZoneAlerteComputed } from '@shared/entities/zone_alerte_computed.entity';
import { ZoneAlerteComputedHistoric } from '@shared/entities/zone_alerte_computed_historic.entity';
import moment, { Moment } from 'moment';
import { readFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { DataSource, FindManyOptions, In, IsNull, Repository } from 'typeorm';
import { ArreteRestrictionService } from '../arrete_restriction/arrete_restriction.service';
import { CommuneService } from '../commune/commune.service';
import { ConfigService } from '../config/config.service';
import { Utils } from '../core/utils';
import { assertHistoricMutableGeometryReplayEnabled } from '../core/historic-geometry-replay';
import { DepartementService } from '../departement/departement.service';
import { RegleauLogger } from '../logger/regleau.logger';
import { RestrictionService } from '../restriction/restriction.service';
import { S3Service } from '../shared/services/s3.service';
import { StatisticService } from '../statistic/statistic.service';
import {
  EmptyHistoricStatisticDay,
  parseHistoricEmptyStatisticsRangeMaxDays,
  StatisticCommuneService,
} from '../statistic_commune/statistic_commune.service';
import { StatisticDepartementService } from '../statistic_departement/statistic_departement.service';
import { ZoneAlerteService } from '../zone_alerte/zone_alerte.service';
import { sourceRevisionColumn } from '../zone_publication/zone_publication.config';
import {
  HistoricDepartmentCheckpointOptions,
  HistoricDepartmentCheckpointService,
} from './historic-department-checkpoint.service';
import { LEGACY_HISTORIC_EMPTY_GEOMETRY_ZONE_IDS } from './legacy-historic-empty-geometries';
import { generateEmptyPmtiles } from './empty-pmtiles';
import {
  collectComputedHistoricPmtilesFeatureIds,
  collectLegacyHistoricBackfillPmtilesFeatureIds,
  COMPUTED_HISTORIC_PMTILES_MAX_ZOOM,
  generatePmtiles,
} from './pmtiles-generation';

export interface HistoricCursorState {
  mapCursor: string | null;
  statsCursor: string | null;
  mapGeneration: string;
  statsGeneration: string;
}

type HistoricCoverageZone = {
  id?: number;
  type?: string;
  departement?: { code?: string };
  restriction?: { arreteRestriction?: { id?: number } };
};

export const HISTORIC_DEPARTMENT_CONCURRENCY_DEFAULT = 1;
export const HISTORIC_DEPARTMENT_CONCURRENCY_MAX = 4;
export const HISTORIC_EMPTY_STATISTICS_RANGE_ENABLED_ENV =
  'HISTORIC_EMPTY_STATISTICS_RANGE_ENABLED';

export function isHistoricEmptyStatisticsRangeEnabled(
  value = process.env[HISTORIC_EMPTY_STATISTICS_RANGE_ENABLED_ENV],
): boolean {
  if (value === undefined || value.trim() === '') {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  throw new Error(
    `${HISTORIC_EMPTY_STATISTICS_RANGE_ENABLED_ENV} must be true or false`,
  );
}

export function readHistoricDepartmentConcurrency(
  value = process.env.HISTORIC_DEPARTMENT_CONCURRENCY,
): number {
  if (value === undefined || value.trim() === '') {
    return HISTORIC_DEPARTMENT_CONCURRENCY_DEFAULT;
  }
  const normalized = value.trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(
      'HISTORIC_DEPARTMENT_CONCURRENCY must be a positive integer',
    );
  }
  const parsed = Number(normalized);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed > HISTORIC_DEPARTMENT_CONCURRENCY_MAX
  ) {
    throw new Error(
      `HISTORIC_DEPARTMENT_CONCURRENCY must be at most ${HISTORIC_DEPARTMENT_CONCURRENCY_MAX}`,
    );
  }
  return parsed;
}

export function readHistoricSkipCommuneIntersections(
  value = process.env.HISTORIC_SKIP_COMMUNE_INTERSECTIONS,
): boolean {
  if (value === undefined || value.trim() === '') {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  throw new Error('HISTORIC_SKIP_COMMUNE_INTERSECTIONS must be true or false');
}

export async function withHistoricArtifactCleanup<T>(
  paths: readonly string[],
  action: () => Promise<T>,
  onCleanupError: (path: string, error: unknown) => void = () => undefined,
): Promise<T> {
  try {
    return await action();
  } finally {
    await Promise.all(
      paths.map(async (path) => {
        try {
          await rm(path, { force: true });
        } catch (error) {
          onCleanupError(path, error);
        }
      }),
    );
  }
}

@Injectable()
export class ZoneAlerteComputedHistoricService {
  private readonly logger = new RegleauLogger(
    'ZoneAlerteComputedHistoricService',
  );
  constructor(
    @Inject(forwardRef(() => ArreteRestrictionService))
    private readonly arreteResrictionService: ArreteRestrictionService,
    private readonly zoneAlerteService: ZoneAlerteService,
    private readonly nestConfigService: NestConfigService,
    private readonly s3Service: S3Service,
    private readonly statisticService: StatisticService,
    private readonly departementService: DepartementService,
    private readonly communeService: CommuneService,
    @InjectRepository(ZoneAlerteComputedHistoric)
    private readonly zoneAlerteComputedHistoricRepository: Repository<ZoneAlerteComputedHistoric>,
    private readonly restrictionService: RestrictionService,
    @Inject(forwardRef(() => StatisticDepartementService))
    private readonly statisticDepartementService: StatisticDepartementService,
    @Inject(forwardRef(() => StatisticCommuneService))
    private readonly statisticCommuneService: StatisticCommuneService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    private readonly historicDepartmentCheckpointService: HistoricDepartmentCheckpointService,
  ) {
    setTimeout(() => {
      // this.computeHistoricMapsComputed(moment('2024-04-29'));
      // this.computeHistoricMaps(moment('2023-01-01'));
    }, 5000);
  }

  findOne(id: number): Promise<any> {
    return this.zoneAlerteComputedHistoricRepository
      .createQueryBuilder('zone_alerte_computed_historic')
      .select('zone_alerte_computed_historic.id', 'id')
      .addSelect('zone_alerte_computed_historic.code', 'code')
      .addSelect('zone_alerte_computed_historic.nom', 'nom')
      .addSelect('zone_alerte_computed_historic.type', 'type')
      .addSelect(
        'ST_AsGeoJSON(ST_TRANSFORM(zone_alerte_computed_historic.geom, 4326))',
        'geom',
      )
      .where('zone_alerte_computed_historic.id = :id', { id })
      .getRawOne();
  }

  async computeHistoricMaps(
    date?: Moment,
    dateStats?: Moment,
    expectedMapCursor?: string | null,
    expectedStatsCursor?: string | null,
    expectedMapGeneration?: string | number,
    expectedStatsGeneration?: string | number,
    expectedSourceRevision?: string,
    dateMax?: string,
    expectedHistoricComputeEpoch?: string | number,
  ) {
    assertHistoricMutableGeometryReplayEnabled();
    const dateDebut = date ? date : moment();
    const dateFin = this.getBoundedHistoricEndDate(
      moment('2024-04-28'),
      dateMax,
    );
    let mapCursor =
      expectedMapCursor === undefined
        ? date?.format('YYYY-MM-DD') || null
        : expectedMapCursor;
    let statsCursor =
      expectedStatsCursor === undefined
        ? dateStats?.format('YYYY-MM-DD') || null
        : expectedStatsCursor;
    let mapGeneration = String(expectedMapGeneration ?? 0);
    let statsGeneration = String(expectedStatsGeneration ?? 0);
    const historicComputeEpoch =
      expectedHistoricComputeEpoch === undefined
        ? undefined
        : String(expectedHistoricComputeEpoch);
    const emptyRangeEnabled =
      isHistoricEmptyStatisticsRangeEnabled() &&
      expectedSourceRevision !== undefined &&
      historicComputeEpoch !== undefined;
    const emptyRangeMaxDays = emptyRangeEnabled
      ? parseHistoricEmptyStatisticsRangeMaxDays()
      : 0;
    const pendingEmptyDays: Array<{
      dateString: string;
      statisticDate: Date;
    }> = [];

    const advanceMapCursor = async (completedThrough: string) => {
      if (!mapCursor || completedThrough >= mapCursor) {
        await this.assertExpectedSourceRevision(expectedSourceRevision);
        const advanced = await this.configService.advanceComputeMapDate(
          mapCursor,
          mapGeneration,
          completedThrough,
          expectedSourceRevision,
        );
        this.assertHistoricCursorAdvanced(
          'map',
          advanced,
          mapCursor,
          mapGeneration,
          completedThrough,
        );
        mapCursor = completedThrough;
        mapGeneration = this.nextGeneration(mapGeneration);
      }
    };

    const flushPendingEmptyDays = async () => {
      if (pendingEmptyDays.length === 0) {
        return;
      }
      const range = pendingEmptyDays.splice(0, pendingEmptyDays.length);
      let lastStatsCursorAdvanced: string | undefined;
      const rangeDays: EmptyHistoricStatisticDay[] = range.map((day) => ({
        date: day.statisticDate,
        beforeCommuneStatistics: () =>
          this.statisticDepartementService.computeDepartementStatisticsRestrictions(
            [],
            day.statisticDate,
            true,
            true,
          ),
        beforeCertification: async () => {
          await this.statisticService.computeDepartementsSituationHistoric(
            [],
            day.dateString,
          );
          await this.assertExpectedSourceRevision(expectedSourceRevision);
          const advanced = await this.configService.advanceComputeStatsDate(
            statsCursor,
            statsGeneration,
            day.dateString,
            expectedSourceRevision,
          );
          this.assertHistoricCursorAdvanced(
            'statistics',
            advanced,
            statsCursor,
            statsGeneration,
            day.dateString,
          );
          statsCursor = day.dateString;
          statsGeneration = this.nextGeneration(statsGeneration);
          lastStatsCursorAdvanced = day.dateString;
        },
      }));
      try {
        await this.statisticCommuneService.computeEmptyHistoricCommuneStatisticsRange(
          rangeDays,
          {
            sourceRevision: expectedSourceRevision!,
            historicComputeEpoch: historicComputeEpoch!,
          },
        );
      } catch (error) {
        if (lastStatsCursorAdvanced) {
          await this.configService.setConfig(
            lastStatsCursorAdvanced,
            lastStatsCursorAdvanced,
          );
        }
        throw error;
      }
      for (const day of range) {
        await advanceMapCursor(day.dateString);
      }
    };

    for (
      let m = moment(dateDebut);
      m.diff(dateFin, 'days') <= 0;
      m.add(1, 'days')
    ) {
      await this.assertExpectedSourceRevision(expectedSourceRevision);
      const ars = await this.arreteResrictionService.findByDate(m);
      const arIds = ars.map((ar) => ar.id);
      const zas: ZoneAlerte[] = <ZoneAlerte[]>(
        await this.zoneAlerteService.findByArreteRestriction(arIds)
      );

      const historicZones = await this.formatLegacyHistoricZones(zas, arIds, m);
      const zasFormated = historicZones.features;
      await this.assertHistoricSourceCoverage(
        arIds,
        historicZones.zones,
        m,
        'legacy',
      );
      await this.assertExpectedSourceRevision(expectedSourceRevision);
      const shouldBufferEmptyDay =
        emptyRangeEnabled &&
        Boolean(dateStats && m.isSameOrAfter(dateStats, 'day')) &&
        historicZones.zones.length === 0;
      if (!shouldBufferEmptyDay) {
        await flushPendingEmptyDays();
      }

      const geojson = {
        type: 'FeatureCollection',
        features: zasFormated,
      };
      const legacyPmtilesFeatureIds =
        collectLegacyHistoricBackfillPmtilesFeatureIds(
          zasFormated,
          LEGACY_HISTORIC_EMPTY_GEOMETRY_ZONE_IDS,
        );
      const expectedPmtilesFeatureIds =
        legacyPmtilesFeatureIds.expectedFeatureIds;
      if (legacyPmtilesFeatureIds.excludedEmptyGeometryIds.length > 0) {
        this.logger.warn(
          JSON.stringify({
            type: 'legacy_historic_pmtiles_empty_geometries_excluded',
            computedFor: m.format('YYYY-MM-DD'),
            zoneIds: legacyPmtilesFeatureIds.excludedEmptyGeometryIds,
          }),
        );
      }

      const path = this.nestConfigService.get('PATH_TO_WRITE_FILE');

      const fileNameToSave = `zones_arretes_en_vigueur_${m.format('YYYY-MM-DD')}`;
      const geojsonPath = `${path}/${fileNameToSave}.geojson`;
      const pmtilesPath = `${path}/${fileNameToSave}.pmtiles`;
      await withHistoricArtifactCleanup(
        [geojsonPath, pmtilesPath],
        async () => {
          await writeFile(geojsonPath, JSON.stringify(geojson));
          if (expectedPmtilesFeatureIds.length === 0) {
            await generateEmptyPmtiles({
              workingDirectory: path,
              outputPath: pmtilesPath,
            });
          } else {
            await generatePmtiles({
              workingDirectory: path,
              inputPath: geojsonPath,
              outputPath: pmtilesPath,
              expectedFeatureIds: expectedPmtilesFeatureIds,
            });
          }
          const fileToTransferPmtiles = {
            originalname: `${fileNameToSave}.pmtiles`,
            buffer: readFileSync(pmtilesPath),
          };
          const fileToTransferGeojson = {
            originalname: `${fileNameToSave}.geojson`,
            buffer: readFileSync(geojsonPath),
          };
          await this.s3Service.uploadFile(
            fileToTransferPmtiles as Express.Multer.File,
            'pmtiles/',
          );
          await this.s3Service.uploadFile(
            fileToTransferGeojson as Express.Multer.File,
            'geojson/',
          );
        },
        (artifactPath, error) =>
          this.logger.error(
            `ERROR CLEANING HISTORIC ARTIFACT ${artifactPath}`,
            error instanceof Error ? error.toString() : String(error),
          ),
      );
      if (shouldBufferEmptyDay) {
        pendingEmptyDays.push({
          dateString: m.format('YYYY-MM-DD'),
          statisticDate: new Date(m.format('YYYY-MM-DD')),
        });
        if (pendingEmptyDays.length >= emptyRangeMaxDays) {
          await flushPendingEmptyDays();
        }
        continue;
      }
      if (dateStats && m.isSameOrAfter(dateStats, 'day')) {
        const zonesForStatistics = historicZones.zones.map((zone) => {
          const computedZone = zone as unknown as ZoneAlerteComputed;
          computedZone.restriction = zone.restrictions[0];
          return computedZone;
        });
        const statisticDate = new Date(m.format('YYYY-MM-DD'));
        const completedThrough = m.format('YYYY-MM-DD');
        let statsCursorAdvanced = false;
        try {
          await this.statisticCommuneService.computeCommuneStatisticsRestrictions(
            zonesForStatistics,
            statisticDate,
            true,
            true,
            undefined,
            {
              beforeCommuneStatistics: () =>
                this.statisticDepartementService.computeDepartementStatisticsRestrictions(
                  zonesForStatistics,
                  statisticDate,
                  true,
                  true,
                ),
              beforeCertification: async () => {
                await this.statisticService.computeDepartementsSituationHistoric(
                  historicZones.zones,
                  completedThrough,
                );
                await this.assertExpectedSourceRevision(expectedSourceRevision);
                const advanced =
                  await this.configService.advanceComputeStatsDate(
                    statsCursor,
                    statsGeneration,
                    completedThrough,
                    expectedSourceRevision,
                  );
                this.assertHistoricCursorAdvanced(
                  'statistics',
                  advanced,
                  statsCursor,
                  statsGeneration,
                  completedThrough,
                );
                statsCursorAdvanced = true;
              },
              sourceRevision: expectedSourceRevision,
              historicComputeEpoch,
              requireNationalCoverage: true,
            },
          );
        } catch (error) {
          if (statsCursorAdvanced) {
            await this.configService.setConfig(
              completedThrough,
              completedThrough,
            );
          }
          throw error;
        }
        statsCursor = completedThrough;
        statsGeneration = this.nextGeneration(statsGeneration);
      }
      const completedThrough = m.format('YYYY-MM-DD');
      await advanceMapCursor(completedThrough);
    }
    await flushPendingEmptyDays();
    return { mapCursor, statsCursor, mapGeneration, statsGeneration };
  }

  private async formatLegacyHistoricZones(
    zones: ZoneAlerte[],
    activeArIds: number[],
    date: Moment,
  ) {
    const dateString = date.format('YYYY-MM-DD');
    const activeArIdSet = new Set(activeArIds);
    const normalizedZones = zones.map((zone) => {
      const restriction = zone.restrictions
        ?.filter((candidate) =>
          activeArIdSet.has(candidate.arreteRestriction?.id),
        )
        .sort((left, right) =>
          this.compareHistoricRestrictionsNewestFirst(left, right),
        )[0];
      if (!restriction) {
        throw new Error(
          `Missing applicable restriction for historic zone ${zone.id} on ${dateString}`,
        );
      }
      this.assertHistoricRestrictionLoaded(restriction, zone.id, dateString);
      return Object.assign(Object.create(Object.getPrototypeOf(zone)), zone, {
        restrictions: [restriction],
      }) as ZoneAlerte;
    });
    const rawGeometries =
      await this.zoneAlerteService.findLegacyHistoricGeometriesByIds(
        normalizedZones.map((zone) => zone.id),
        LEGACY_HISTORIC_EMPTY_GEOMETRY_ZONE_IDS,
      );

    const features = normalizedZones.map((zone) => {
      const restriction = zone.restrictions[0];
      const geometry = this.parseHistoricGeometry(
        rawGeometries.get(zone.id),
        zone.id,
        dateString,
      );
      zone.geom = geometry;
      return {
        type: 'Feature',
        geometry,
        properties: {
          id: zone.id,
          idSandre: zone.idSandre,
          nom: zone.nom,
          code: zone.code,
          type: zone.type,
          niveauGravite: restriction.niveauGravite,
          departement: zone.departement,
          arreteRestriction: {
            id: restriction.arreteRestriction.id,
            numero: restriction.arreteRestriction.numero,
            dateDebut: restriction.arreteRestriction.dateDebut,
            dateFin: restriction.arreteRestriction.dateFin,
            dateSignature: restriction.arreteRestriction.dateSignature,
            fichier: restriction.arreteRestriction.fichier?.url,
          },
          restrictions: this.formatHistoricUsages(
            restriction,
            zone.id,
            dateString,
          ),
        },
      };
    });
    return { features, zones: normalizedZones };
  }

  private compareHistoricRestrictionsNewestFirst(
    left: Restriction,
    right: Restriction,
  ): number {
    const leftArrete = left.arreteRestriction;
    const rightArrete = right.arreteRestriction;
    const dateDebutComparison = String(
      rightArrete?.dateDebut ?? '',
    ).localeCompare(String(leftArrete?.dateDebut ?? ''));
    if (dateDebutComparison !== 0) {
      return dateDebutComparison;
    }
    const dateSignatureComparison = String(
      rightArrete?.dateSignature ?? '',
    ).localeCompare(String(leftArrete?.dateSignature ?? ''));
    if (dateSignatureComparison !== 0) {
      return dateSignatureComparison;
    }
    return (rightArrete?.id ?? 0) - (leftArrete?.id ?? 0);
  }

  private assertHistoricRestrictionLoaded(
    restriction: Restriction,
    zoneId: number,
    date: string,
  ): void {
    if (!restriction.arreteRestriction) {
      throw new Error(`Missing decree for historic zone ${zoneId} on ${date}`);
    }
    if (
      restriction.usages !== undefined &&
      !Array.isArray(restriction.usages)
    ) {
      throw new Error(
        `Usages were not loaded for historic zone ${zoneId} on ${date}`,
      );
    }
  }

  private formatHistoricUsages(
    restriction: Restriction,
    zoneId: number,
    date: string,
  ) {
    return (restriction.usages ?? []).map((usage) => {
      if (!usage.thematique?.nom) {
        throw new Error(
          `Missing theme for historic zone ${zoneId} usage ${usage.id} on ${date}`,
        );
      }
      return this.formatHistoricUsage(usage, restriction);
    });
  }

  private formatHistoricUsage(
    usage: Usage,
    restriction: Restriction,
    niveauGravite = restriction.niveauGravite,
  ) {
    let description;
    switch (niveauGravite) {
      case 'vigilance':
        description = usage.descriptionVigilance;
        break;
      case 'alerte':
        description = usage.descriptionAlerte;
        break;
      case 'alerte_renforcee':
        description = usage.descriptionAlerteRenforcee;
        break;
      case 'crise':
        description = usage.descriptionCrise;
        break;
    }
    return {
      nom: usage.nom,
      thematique: usage.thematique.nom,
      concerneParticulier: usage.concerneParticulier,
      concerneEntreprise: usage.concerneEntreprise,
      concerneCollectivite: usage.concerneCollectivite,
      concerneExploitation: usage.concerneExploitation,
      concerneEso: usage.concerneEso,
      concerneEsu: usage.concerneEsu,
      concerneAep: usage.concerneAep,
      description,
    };
  }

  private parseHistoricGeometry(
    rawGeometry: string | undefined,
    zoneId: number,
    date: string,
  ): ZoneAlerte['geom'] {
    if (!rawGeometry) {
      throw new Error(
        `Missing geometry for historic zone ${zoneId} on ${date}`,
      );
    }
    try {
      const geometry = JSON.parse(rawGeometry);
      if (!geometry || typeof geometry !== 'object') {
        throw new Error('GeoJSON geometry is empty');
      }
      return geometry;
    } catch (error) {
      throw new Error(
        `Invalid geometry for historic zone ${zoneId} on ${date}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async computeHistoricMapsComputed(
    date?: Moment,
    dateStats?: Moment,
    expectedMapCursor?: string | null,
    expectedStatsCursor?: string | null,
    expectedMapGeneration?: string | number,
    expectedStatsGeneration?: string | number,
    expectedSourceRevision?: string,
    dateMax?: string,
    expectedHistoricComputeEpoch?: string | number,
  ) {
    assertHistoricMutableGeometryReplayEnabled();
    const requestedStartDate = date ? moment(date) : moment();
    const dateFin = this.getBoundedHistoricEndDate(
      moment().subtract(1, 'days'),
      dateMax,
    );
    let mapCursor =
      expectedMapCursor === undefined
        ? date?.format('YYYY-MM-DD') || null
        : expectedMapCursor;
    let statsCursor =
      expectedStatsCursor === undefined
        ? dateStats?.format('YYYY-MM-DD') || null
        : expectedStatsCursor;
    let mapGeneration = String(expectedMapGeneration ?? 0);
    let statsGeneration = String(expectedStatsGeneration ?? 0);
    const checkpointContext = {
      historicComputeEpoch:
        expectedHistoricComputeEpoch === undefined
          ? undefined
          : String(expectedHistoricComputeEpoch),
      expectedSourceRevision,
    };
    await this.historicDepartmentCheckpointService.purgeStaleCheckpoints(
      checkpointContext,
    );
    const dateDebut = await this.resolveComputedHistoricStartDate(
      requestedStartDate,
      dateFin,
      mapCursor,
      statsCursor,
      checkpointContext,
    );
    let previousMaterializedDate =
      mapCursor &&
      !moment(mapCursor, 'YYYY-MM-DD', true).isAfter(dateDebut, 'day')
        ? mapCursor
        : null;
    // const dateFin = moment('23/06/2024', 'DD/MM/YYYY');

    for (
      let m = moment(dateDebut);
      m.diff(dateFin, 'days', true) <= 0;
      m.add(1, 'days')
    ) {
      await this.assertExpectedSourceRevision(expectedSourceRevision);
      const activeArIds = (
        await this.arreteResrictionService.findByDate(m)
      ).map((arrete) => arrete.id);
      this.logger.log(
        `COMPUTING ZONES D'ALERTES ${m.format('DD/MM/YYYY')} - BEGIN`,
      );
      await this.computeZonesForDate(m, undefined, {
        previousDate: previousMaterializedDate,
        historicComputeEpoch: checkpointContext.historicComputeEpoch,
        expectedSourceRevision,
      });
      previousMaterializedDate = m.format('YYYY-MM-DD');
      // On récupère toutes les restrictions en cours
      this.logger.log(
        `COMPUTING ZONES D'ALERTES ${m.format('DD/MM/YYYY')} - END`,
      );

      const allZonesComputed = await this.computeGeoJson(
        m,
        activeArIds,
        expectedSourceRevision,
      );
      if (dateStats && m.isSameOrAfter(dateStats, 'day')) {
        const statisticDate = new Date(m.format('YYYY-MM-DD'));
        const completedThrough = m.format('YYYY-MM-DD');
        let statsCursorAdvanced = false;
        try {
          await this.statisticCommuneService.computeCommuneStatisticsRestrictions(
            allZonesComputed,
            statisticDate,
            true,
            false,
            undefined,
            {
              beforeCommuneStatistics: () =>
                this.statisticDepartementService.computeDepartementStatisticsRestrictions(
                  allZonesComputed,
                  statisticDate,
                  true,
                ),
              beforeCertification: async () => {
                await this.statisticService.computeDepartementsSituation(
                  allZonesComputed,
                  completedThrough,
                );
                await this.assertExpectedSourceRevision(expectedSourceRevision);
                const advanced =
                  await this.configService.advanceComputeStatsDate(
                    statsCursor,
                    statsGeneration,
                    completedThrough,
                    expectedSourceRevision,
                  );
                this.assertHistoricCursorAdvanced(
                  'statistics',
                  advanced,
                  statsCursor,
                  statsGeneration,
                  completedThrough,
                );
                statsCursorAdvanced = true;
              },
              sourceRevision: expectedSourceRevision,
              historicComputeEpoch: checkpointContext.historicComputeEpoch,
              requireNationalCoverage: true,
            },
          );
        } catch (error) {
          if (statsCursorAdvanced) {
            await this.configService.setConfig(
              completedThrough,
              completedThrough,
            );
          }
          throw error;
        }
        statsCursor = completedThrough;
        statsGeneration = this.nextGeneration(statsGeneration);
      }
      await this.zoneAlerteComputedHistoricRepository
        .createQueryBuilder()
        .update()
        .set({ enabled: true })
        .where('1 = 1')
        .execute();
      const completedThrough = m.format('YYYY-MM-DD');
      if (!mapCursor || completedThrough >= mapCursor) {
        await this.assertExpectedSourceRevision(expectedSourceRevision);
        const advanced = await this.configService.advanceComputeMapDate(
          mapCursor,
          mapGeneration,
          completedThrough,
          expectedSourceRevision,
        );
        this.assertHistoricCursorAdvanced(
          'map',
          advanced,
          mapCursor,
          mapGeneration,
          completedThrough,
        );
        mapCursor = completedThrough;
        mapGeneration = this.nextGeneration(mapGeneration);
      }
    }
    await this.statisticCommuneService.sortStatCommune();
    await this.statisticDepartementService.sortStatDepartement();
    return { mapCursor, statsCursor, mapGeneration, statsGeneration };
  }

  private assertHistoricCursorAdvanced(
    cursor: 'map' | 'statistics',
    advanced: boolean,
    expectedCurrent: string | null,
    expectedGeneration: string,
    completedThrough: string,
  ): void {
    if (!advanced) {
      throw new Error(
        `Historic ${cursor} cursor changed concurrently while advancing ${expectedCurrent || 'null'}@${expectedGeneration} -> ${completedThrough}`,
      );
    }
  }

  private nextGeneration(current: string): string {
    return (BigInt(current) + 1n).toString();
  }

  private async resolveComputedHistoricStartDate(
    requestedStartDate: Moment,
    dateFin: Moment,
    mapCursor: string | null,
    statsCursor: string | null,
    checkpointContext: {
      historicComputeEpoch?: string;
      expectedSourceRevision?: string;
    },
  ): Promise<Moment> {
    const requestedStart = requestedStartDate.format('YYYY-MM-DD');
    if (mapCursor !== requestedStart || statsCursor !== requestedStart) {
      return requestedStartDate;
    }

    const interruptedDate = moment(requestedStartDate).add(1, 'day');
    if (interruptedDate.isAfter(dateFin, 'day')) {
      return requestedStartDate;
    }

    const resumesInterruptedDate =
      await this.historicDepartmentCheckpointService.hasAnyCheckpointForDate(
        interruptedDate,
        requestedStartDate,
        checkpointContext,
      );
    if (!resumesInterruptedDate) {
      return requestedStartDate;
    }

    this.logger.log(
      `RESUMING PARTIAL HISTORIC DAY ${interruptedDate.format('YYYY-MM-DD')} AFTER CERTIFIED ${requestedStart} (epoch=${checkpointContext.historicComputeEpoch}, sourceRevision=${checkpointContext.expectedSourceRevision})`,
    );
    return interruptedDate;
  }

  private getBoundedHistoricEndDate(
    naturalEndDate: Moment,
    dateMax?: string,
  ): Moment {
    if (dateMax === undefined) {
      return naturalEndDate;
    }
    const requestedEndDate = moment(dateMax, 'YYYY-MM-DD', true);
    if (!requestedEndDate.isValid()) {
      throw new Error(`Invalid historic chunk end date: ${dateMax}`);
    }
    return requestedEndDate.isBefore(naturalEndDate, 'day')
      ? requestedEndDate
      : naturalEndDate;
  }

  private async assertExpectedSourceRevision(
    expectedSourceRevision?: string,
  ): Promise<void> {
    if (expectedSourceRevision === undefined) {
      return;
    }
    const [sourceState] = await this.dataSource.query(
      `SELECT ${sourceRevisionColumn()}::text AS "revision"
       FROM "zone_publication_source_state"
       WHERE "id" = 1`,
    );
    const actualSourceRevision = sourceState
      ? String(sourceState.revision)
      : 'missing';
    if (actualSourceRevision !== expectedSourceRevision) {
      throw new Error(
        `Historic source revision changed (${expectedSourceRevision} -> ${actualSourceRevision})`,
      );
    }
  }

  private async assertHistoricSourceCoverage(
    activeArIds: number[],
    outputZones: HistoricCoverageZone[],
    date: Moment,
    mode: 'legacy' | 'computed',
  ): Promise<void> {
    if (activeArIds.length === 0) {
      if (outputZones.length > 0) {
        throw new Error(
          `Historic map ${date.format('YYYY-MM-DD')} contains zones without an active source order`,
        );
      }
      return;
    }
    const computedMode = mode === 'computed';
    const mappableRestrictionSql = computedMode
      ? `(restriction_source."zoneAlerteId" IS NOT NULL
          OR EXISTS (
            SELECT 1
            FROM "restriction_commune" commune_source
            WHERE commune_source."restrictionId" = restriction_source.id
          ))`
      : `restriction_source."zoneAlerteId" IS NOT NULL`;
    const sourceZoneTypeSql = computedMode
      ? `CASE
          WHEN restriction_source."zoneAlerteId" IS NOT NULL
            THEN source_zone.type::text
          WHEN EXISTS (
            SELECT 1
            FROM "restriction_commune" commune_source
            WHERE commune_source."restrictionId" = restriction_source.id
          ) THEN 'AEP'
          ELSE NULL
        END`
      : 'source_zone.type::text';
    const sourceRows: Array<{
      arId: string | number;
      departmentCode: string | null;
      zoneType: string | null;
      mappableCount: string | number;
      sourceZoneIds: number[] | null;
    }> = await this.dataSource.query(
      `
        SELECT
          source_order.id AS "arId",
          source_department.code AS "departmentCode",
          ${sourceZoneTypeSql} AS "zoneType",
          (COUNT(DISTINCT restriction_source.id) FILTER (
            WHERE ${mappableRestrictionSql}
          ))::integer AS "mappableCount",
          ARRAY_REMOVE(ARRAY_AGG(DISTINCT restriction_source."zoneAlerteId") FILTER (
            WHERE restriction_source."zoneAlerteId" IS NOT NULL
          ), NULL) AS "sourceZoneIds"
        FROM "arrete_restriction" source_order
        LEFT JOIN "restriction" restriction_source
          ON restriction_source."arreteRestrictionId" = source_order.id
        LEFT JOIN "zone_alerte" source_zone
          ON source_zone.id = restriction_source."zoneAlerteId"
        ${
          computedMode
            ? `LEFT JOIN "departement" source_department
              ON source_department.id = source_order."departementId"`
            : `LEFT JOIN "departement" source_department
              ON source_department.id = source_zone."departementId"`
        }
        WHERE source_order.id = ANY($1::integer[])
        GROUP BY source_order.id, source_department.code, ${sourceZoneTypeSql}
      `,
      [activeArIds],
    );

    const expectedArIds = new Set(activeArIds);
    const observedArIds = new Set(sourceRows.map((row) => Number(row.arId)));
    if (
      observedArIds.size !== expectedArIds.size ||
      [...expectedArIds].some((id) => !observedArIds.has(id))
    ) {
      throw new Error(
        `Unable to certify historic source coverage on ${date.format('YYYY-MM-DD')}`,
      );
    }
    for (const row of sourceRows) {
      const count = Number(row.mappableCount);
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error(
          `Unable to certify historic source coverage on ${date.format('YYYY-MM-DD')}`,
        );
      }
    }

    const mappableCountByAr = new Map<number, number>();
    for (const row of sourceRows) {
      const arId = Number(row.arId);
      mappableCountByAr.set(
        arId,
        (mappableCountByAr.get(arId) ?? 0) + Number(row.mappableCount),
      );
    }
    const unmappableArIds = [...mappableCountByAr]
      .filter(([, count]) => count === 0)
      .map(([arId]) => arId);
    if (computedMode && unmappableArIds.length > 0) {
      throw new Error(
        `Historic map ${date.format('YYYY-MM-DD')} has active source order(s) without mappable restrictions: ${unmappableArIds.join(',')}`,
      );
    }
    if (!computedMode && unmappableArIds.length > 0) {
      this.logger.warn(
        `HISTORIC LEGACY SOURCE ${date.format('YYYY-MM-DD')}: ${unmappableArIds.length}/${expectedArIds.size} active orders have no mappable zone restriction`,
      );
    }

    const outputDepartmentCodes = new Set<string>();
    for (const zone of outputZones) {
      const departmentCode = zone.departement?.code;
      if (!departmentCode) {
        throw new Error(
          `Historic map ${date.format('YYYY-MM-DD')} contains a zone without department`,
        );
      }
      outputDepartmentCodes.add(departmentCode);
    }
    const sourceDepartmentCodes = new Set(
      sourceRows
        .filter((row) => Number(row.mappableCount) > 0)
        .map((row) => row.departmentCode)
        .filter((code): code is string => Boolean(code)),
    );
    const missingDepartments = [...sourceDepartmentCodes].filter(
      (code) => !outputDepartmentCodes.has(code),
    );
    const unexpectedDepartments = [...outputDepartmentCodes].filter(
      (code) => !sourceDepartmentCodes.has(code),
    );
    if (missingDepartments.length > 0 || unexpectedDepartments.length > 0) {
      throw new Error(
        `Historic map ${date.format('YYYY-MM-DD')} source coverage mismatch (missing=${missingDepartments.join(',') || 'none'}, unexpected=${unexpectedDepartments.join(',') || 'none'})`,
      );
    }

    if (!computedMode) {
      const expectedZoneIds = new Set(
        sourceRows.flatMap((row) =>
          (row.sourceZoneIds ?? []).map((id) => Number(id)),
        ),
      );
      const outputZoneIds = new Set(outputZones.map((zone) => Number(zone.id)));
      const invalidZoneIds = [...expectedZoneIds, ...outputZoneIds].filter(
        (id) => !Number.isSafeInteger(id) || id <= 0,
      );
      if (invalidZoneIds.length > 0) {
        throw new Error(
          `Unable to certify historic source coverage on ${date.format('YYYY-MM-DD')}`,
        );
      }
      const missingZoneIds = [...expectedZoneIds].filter(
        (id) => !outputZoneIds.has(id),
      );
      const unexpectedZoneIds = [...outputZoneIds].filter(
        (id) => !expectedZoneIds.has(id),
      );
      if (missingZoneIds.length > 0 || unexpectedZoneIds.length > 0) {
        throw new Error(
          `Historic map ${date.format('YYYY-MM-DD')} zone coverage mismatch (missing=${missingZoneIds.join(',') || 'none'}, unexpected=${unexpectedZoneIds.join(',') || 'none'})`,
        );
      }
      return;
    }

    const expectedSourceKeys = new Set(
      sourceRows
        .filter((row) => Number(row.mappableCount) > 0)
        .map((row) => {
          if (!row.departmentCode || !row.zoneType) {
            throw new Error(
              `Unable to certify historic source coverage on ${date.format('YYYY-MM-DD')}`,
            );
          }
          return `${row.departmentCode}:${row.zoneType}`;
        }),
    );
    const outputSourceKeys = new Set(
      outputZones.map((zone) => {
        const departmentCode = zone.departement?.code;
        if (!departmentCode || !zone.type) {
          throw new Error(
            `Unable to certify historic source coverage on ${date.format('YYYY-MM-DD')}`,
          );
        }
        return `${departmentCode}:${zone.type}`;
      }),
    );
    const missingSourceKeys = [...expectedSourceKeys].filter(
      (key) => !outputSourceKeys.has(key),
    );
    if (missingSourceKeys.length > 0) {
      throw new Error(
        `Historic map ${date.format('YYYY-MM-DD')} source department/type coverage mismatch (missing=${missingSourceKeys.join(',')})`,
      );
    }
  }

  async computeZonesForDate(
    date: Moment,
    departements?: Departement[],
    checkpointOptions?: Omit<HistoricDepartmentCheckpointOptions, 'date'>,
  ) {
    assertHistoricMutableGeometryReplayEnabled();
    const departementsToCompute =
      departements ?? (await this.departementService.findAllLight());

    if (departementsToCompute.length === 0) {
      return;
    }

    const concurrency = Math.min(
      readHistoricDepartmentConcurrency(),
      departementsToCompute.length,
    );
    const skipCommuneIntersections = readHistoricSkipCommuneIntersections();

    await this.zoneAlerteComputedHistoricRepository.delete({
      departement: IsNull(),
    });

    let nextDepartementIndex = 0;
    let firstError: unknown;
    let hasFailed = false;
    const computeNextDepartement = async (): Promise<void> => {
      while (
        !hasFailed &&
        nextDepartementIndex < departementsToCompute.length
      ) {
        const departement = departementsToCompute[nextDepartementIndex++];
        try {
          await this.computeCheckpointedDepartementForDate(
            departement,
            date,
            skipCommuneIntersections,
            checkpointOptions,
          );
        } catch (error) {
          if (!hasFailed) {
            hasFailed = true;
            firstError = error;
          }
        }
      }
    };

    await Promise.all(
      Array.from({ length: concurrency }, () => computeNextDepartement()),
    );
    if (hasFailed) {
      throw firstError;
    }
  }

  private async computeCheckpointedDepartementForDate(
    departement: Departement,
    date: Moment,
    skipCommuneIntersections: boolean,
    checkpointOptions?: Omit<HistoricDepartmentCheckpointOptions, 'date'>,
  ): Promise<void> {
    const options: HistoricDepartmentCheckpointOptions = {
      date,
      previousDate: checkpointOptions?.previousDate ?? null,
      historicComputeEpoch: checkpointOptions?.historicComputeEpoch,
      expectedSourceRevision: checkpointOptions?.expectedSourceRevision,
    };
    const plan = await this.historicDepartmentCheckpointService.prepare(
      departement,
      options,
    );
    if (!plan.shouldCompute) {
      this.logger.log(
        `COMPUTING ${departement.code} - ${departement.nom} - checkpoint ${plan.reason}`,
      );
      return;
    }

    await this.computeDepartementForDate(
      departement,
      date,
      skipCommuneIntersections,
    );
    await this.historicDepartmentCheckpointService.complete(
      departement,
      options,
      plan,
    );
  }

  private async computeDepartementForDate(
    departement: Departement,
    date: Moment,
    skipCommuneIntersections: boolean,
  ): Promise<void> {
    const param = departement.parametres.find(
      (p) =>
        date.isSameOrAfter(moment(p.dateDebut)) &&
        (!p.dateFin || date.isSameOrBefore(moment(p.dateFin))),
    )?.superpositionCommune;
    const zonesSaved = await this.computeRegleAr(departement, date);
    if (zonesSaved.length > 0) {
      switch (param) {
        case 'no':
        case 'no_all':
          break;
        case 'yes_all':
          await this.computeYesDistinct(departement, false);
          await this.computeYesAll(departement, false);
          break;
        case 'yes_only_aep':
          await this.computeYesDistinct(departement, true);
          break;
        case 'yes_except_aep':
          await this.computeYesDistinct(departement, false);
          await this.computeYesAll(departement, true);
          break;
        case 'yes_distinct':
          await this.computeYesDistinct(departement, false);
          break;
        default:
          this.logger.error(
            `COMPUTING ${departement.code} - ${departement.nom} - ${param} not implemented`,
            '',
          );
      }
    }
    if (!skipCommuneIntersections) {
      await this.computeCommunesIntersected(departement);
    }
  }

  findZonesForStatistics(departementCodes?: string[]) {
    const options: FindManyOptions<ZoneAlerteComputedHistoric> = {
      select: {
        id: true,
        type: true,
        departement: {
          code: true,
        },
        restriction: {
          niveauGravite: true,
        },
      },
      relations: ['departement', 'restriction'],
    };

    if (departementCodes?.length > 0) {
      options.where = {
        departement: {
          code: In(departementCodes),
        },
      };
    }

    return this.zoneAlerteComputedHistoricRepository.find(options);
  }

  findZonesForHistoricBackfill(departementCodes: string[]) {
    if (departementCodes.length === 0) {
      return Promise.resolve([]);
    }
    return this.zoneAlerteComputedHistoricRepository.find({
      relations: [
        'departement',
        'restriction',
        'restriction.arreteRestriction',
        'restriction.arreteRestriction.fichier',
        'restriction.usages',
        'restriction.usages.thematique',
      ],
      where: {
        departement: {
          code: In(departementCodes),
        },
      },
    });
  }

  async computeRegleAr(departement: Departement, date: Moment) {
    const arretesRestrictions =
      await this.arreteResrictionService.findByDepartementAndDate(
        departement.code,
        date,
      );
    this.logger.log(
      `COMPUTING ${departement.code} - ${departement.nom} - ${arretesRestrictions.length} arrêtés de restriction`,
    );
    let zonesToSave = [];
    for (const ar of arretesRestrictions) {
      await Promise.all(
        ar.restrictions.map(async (restriction) => {
          if (restriction.zoneAlerte) {
            const arreteCadreId = restriction.arreteCadre?.id;
            const za = await this.zoneAlerteService.findOne(
              restriction.zoneAlerte.id,
              arreteCadreId === undefined ? undefined : [arreteCadreId],
            );
            za.restriction = {
              id: restriction.id,
              niveauGravite: restriction.niveauGravite,
            };
            za.departement = { id: departement.id };

            if (
              za.arreteCadreZoneAlerteCommunes &&
              za.arreteCadreZoneAlerteCommunes[0] &&
              za.arreteCadreZoneAlerteCommunes[0].communes?.length > 0
            ) {
              za.geom =
                await this.zoneAlerteService.getUnionGeomOfZoneAndCommunes(
                  za.id,
                  za.arreteCadreZoneAlerteCommunes[0].communes.map((c) => c.id),
                );
            }
            // SAUVEGARDE ZONE ESU ou ESO
            zonesToSave.push(za);
          } else if (restriction.communes?.length > 0) {
            const za = {
              nom: restriction.nomGroupementAep,
              type: 'AEP',
              geom: null,
              departement: { id: departement.id },
              bassinVersant: null,
              restriction: {
                id: restriction.id,
                niveauGravite: restriction.niveauGravite,
              },
            };
            za.geom = (
              await this.communeService.getUnionGeomOfCommunes(
                restriction.communes,
              )
            ).geom;
            // SAUVEGARDE ZONE AEP
            zonesToSave.push(za);
          }
        }),
      );
    }

    zonesToSave = zonesToSave
      .filter((z) => z.geom)
      .map((z) => {
        z.id = null;
        z.geom = JSON.parse(z.geom);
        z.niveauGravite = z.restriction.niveauGravite;
        return z;
      })
      .filter((z) => z.geom.coordinates.length > 0);
    await this.zoneAlerteComputedHistoricRepository.delete({
      departement: departement,
    });
    const toReturn =
      await this.zoneAlerteComputedHistoricRepository.save(zonesToSave);
    if (toReturn.length > 0) {
      await this.cleanZones(departement);
    }
    const param = departement.parametres.find(
      (p) =>
        date.isSameOrAfter(moment(p.dateDebut)) &&
        (!p.dateFin || date.isSameOrBefore(moment(p.dateFin))),
    )?.superpositionCommune;
    if (!param || param !== 'yes_all') {
      await this.computeRegleAepNotSpecific(departement, date);
    }
    this.logger.log(
      `COMPUTING ${departement.code} - ${departement.nom} - ${zonesToSave.length} zones ajoutées`,
    );
    return toReturn;
  }

  async computeRegleAepNotSpecific(departement: Departement, date: Moment) {
    const arretesRestrictions =
      await this.arreteResrictionService.findByDepartementAndDate(
        departement.code,
        date,
      );
    const zonesDepartement =
      await this.getZonesAlerteComputedByDepartement(departement);
    let zonesToSave = [];
    for (const ar of arretesRestrictions) {
      const zonesAr = zonesDepartement.filter(
        (z) => z.restriction?.arreteRestriction.id === ar.id,
      );
      if (
        ar.niveauGraviteSpecifiqueEap === false &&
        ar.ressourceEapCommunique &&
        zonesAr.length > 0
      ) {
        let allZones;

        if (
          ar.ressourceEapCommunique === 'eso' ||
          ar.ressourceEapCommunique === 'esu'
        ) {
          allZones = zonesAr.filter(
            (z) =>
              z.type ===
                (ar.ressourceEapCommunique === 'eso' ? 'SOU' : 'SUP') &&
              ar.restrictions.some((r) => r.id === z.restriction.id),
          );
          allZones = structuredClone(allZones);
        } else {
          const zonesEsu: any = structuredClone(
            zonesAr.filter((z) => z?.type === 'SUP'),
          );
          const zonesEso: any = structuredClone(
            zonesAr.filter((z) => z?.type === 'SOU'),
          );
          allZones = [...zonesEsu, ...zonesEso];
        }

        // On boucle sur toutes les zones et on stock un tableau intersect avec les autres zones
        if (allZones.length > 1) {
          for (const zone of allZones) {
            zone.intersect = await this.getIntersect(
              zone.id,
              allZones.filter((z) => z.id !== zone.id).map((z) => z.id),
            );
          }
        }

        // Pour les zones de l'AR qui ne s'intersectent pas, on peut les copier et les enregistrer sous AEP
        const zonesWithoutIntersection = allZones
          .filter((z) => !z.intersect || z.intersect.length < 1)
          .map((z) => {
            z.type = 'AEP';
            return z;
          });
        zonesToSave = zonesToSave.concat(zonesWithoutIntersection);
        // Pour chaque couple de zone qui s'intersectent, vérifier celle qui a le niveau de gravité max et qui doit être prioritaire
        let zonesWithIntersection = allZones
          .filter((z) => z.intersect && z.intersect.length > 0)
          .map((z) => {
            z.add = [];
            z.remove = [];
            return z;
          });
        for (const z of allZones.filter(
          (z) => z.intersect && z.intersect.length > 0,
        )) {
          for (const zIntersected of z.intersect) {
            // On décide ici quelle portion de quelle zone on ajoute ou on enlève à l'autre
            // Si même niveau de gravité, on prend la zone au pif
            // Si ressource naturelle && ressource influencée, la ressource naturelle à l'aval pour l'AEP
            if (
              (z.type === zIntersected.type &&
                !z.ressourceInfluencee &&
                zIntersected.ressourceInfluencee) ||
              (!(
                z.type === zIntersected.type &&
                z.ressourceInfluencee &&
                !zIntersected.ressourceInfluencee
              ) &&
                this.getNiveauGravite(z.id, ar.restrictions) >=
                  this.getNiveauGravite(zIntersected.id, ar.restrictions))
            ) {
              zonesWithIntersection
                .find((zwi) => zwi.id === z.id)
                .add.push(zIntersected.id);
              zonesWithIntersection
                .find((zwi) => zwi.id === zIntersected.id)
                .remove.push(z.id);
            } else {
              zonesWithIntersection
                .find((zwi) => zwi.id === z.id)
                .remove.push(zIntersected.id);
              zonesWithIntersection
                .find((zwi) => zwi.id === zIntersected.id)
                .add.push(z.id);
            }

            // On supprime la zone en question de zIntersected afin de ne pas faire le calcul en double
            const zi = allZones.find((az) => az.id === zIntersected.id);
            zi.intersect = zi.intersect.filter((iz) => iz.id !== z.id);
          }
        }
        for (const z of zonesWithIntersection) {
          // On construit les nouvelles géométries de zones
          z.geom = (await this.computeNewZone(z)).geom;
        }
        zonesWithIntersection = zonesWithIntersection.map((z) => {
          z.type = 'AEP';
          return z;
        });
        zonesToSave = zonesToSave.concat(zonesWithIntersection);
      }
    }
    zonesToSave = zonesToSave
      .map((z) => {
        z.id = null;
        z.geom = JSON.parse(z.geom);
        return z;
      })
      .filter((z) => z.geom.coordinates?.length > 0);
    const toReturn =
      await this.zoneAlerteComputedHistoricRepository.save(zonesToSave);
    if (toReturn.length > 0) {
      await this.cleanZones(departement);
    }
  }

  // Chaque type de zone doit être harmonisé indépendamment à la commune
  async computeYesDistinct(departement, onlyAep: boolean) {
    this.logger.log(
      `COMPUTING ${departement.code} - ${departement.nom} - ${onlyAep ? 'YES_ONLY_AEP' : 'YES_DISTINCT'} BEGIN`,
    );
    // On récupères les communes avec des ZA qui ne couvrent pas totalement la zone
    const communes =
      await this.communeService.getZoneAlerteComputedHistoricForHarmonisation(
        departement.id,
      );
    const zoneTypes = onlyAep ? ['AEP'] : ['SUP', 'SOU', 'AEP'];
    const queries = [];
    for (const commune of communes) {
      for (const zoneType of zoneTypes) {
        let zonesSameType = commune.zones.filter((z) => z.type === zoneType);
        // Gestion des zones influencées
        // Si il y a des ressources influencées ET des ressources naturelles, on exclut les ressources influencées des calculs
        if (
          zonesSameType.length > 1 &&
          zonesSameType.some(
            (z) => z.ressourceInfluencee && z.areaCommunePercentage >= 5,
          ) &&
          zonesSameType.some(
            (z) => !z.ressourceInfluencee && z.areaCommunePercentage >= 5,
          )
        ) {
          zonesSameType = zonesSameType.filter((z) => !z.ressourceInfluencee);
        }

        // Quand une seule zone, on l'agrandie à la geometrie de la commune
        if (
          zonesSameType.length === 1 &&
          zonesSameType[0].areaCommunePercentage >= 5
        ) {
          queries.push(
            this.getQueryToExtendZone(zonesSameType[0].id, commune.id),
          );
        } else if (zonesSameType.length > 1) {
          // Si plusieurs zones, soit elles sont toutes au même niveau de gravité et on prend celle qui couvre le plus le territoire
          // Soit on prend celle qui a le niveau de gravité le plus élevé
          const zonesSameTypeExploitables = zonesSameType.filter(
            (z) => z.areaCommunePercentage >= 5,
          );
          if (zonesSameTypeExploitables.length >= 1) {
            const maxNiveauGravite = zonesSameTypeExploitables.reduce(
              (prev, current) => {
                return Utils.getNiveau(prev.niveauGravite) >
                  Utils.getNiveau(current.niveauGravite)
                  ? prev
                  : current;
              },
            );
            const zonesSameTypeMaxNiveau = zonesSameTypeExploitables.filter(
              (z) => z.niveauGravite === maxNiveauGravite.niveauGravite,
            );
            const zoneToExtend =
              zonesSameTypeMaxNiveau.length === 1
                ? zonesSameTypeMaxNiveau[0]
                : zonesSameTypeMaxNiveau.reduce((prev, current) => {
                    return prev.areaCommune > current.areaCommune
                      ? prev
                      : current;
                  });
            const zonesToReduce = zonesSameType.filter(
              (z) => z.id !== zoneToExtend.id,
            );
            queries.push(
              this.getQueryToExtendZone(zoneToExtend.id, commune.id),
            );
            zonesToReduce.forEach((z) => {
              queries.push(this.getQueryToReduceZone(z.id, commune.id));
            });
          }
        }
      }
    }
    await Promise.all(queries.map((q) => q.execute()));
    await this.cleanZones(departement);
    this.logger.log(
      `COMPUTING ${departement.code} - ${departement.nom} - ${onlyAep ? 'YES_ONLY_AEP' : 'YES_DISTINCT'} END`,
    );
  }

  async computeYesAll(departement, exceptAep: boolean) {
    this.logger.log(
      `COMPUTING ${departement.code} - ${departement.nom} - ${exceptAep ? 'YES_EXCEPT_AEP' : 'YES_ALL'} BEGIN`,
    );
    // On récupères les communes avec des ZA (même celles qui couvrent totalement la commune)
    const communes =
      await this.communeService.getZoneAlerteComputedHistoricForHarmonisation(
        departement.id,
      );
    const zoneTypes = exceptAep ? ['SUP', 'SOU'] : ['SUP', 'SOU', 'AEP'];
    const queries = [];
    let zonesToSave = [];
    for (const commune of communes) {
      // On filtre sur les aires des zones / communes pour éviter les zones résiduelles
      const zones = commune.zones.filter(
        (z) =>
          zoneTypes.includes(z.type) &&
          commune.area.toFixed(10) === z.areaCommune.toFixed(10),
      );
      if (!zones || zones.length <= 0) {
        continue;
      }
      const maxNiveauGravite = zones.reduce((prev, current) => {
        return Utils.getNiveau(prev.niveauGravite) >
          Utils.getNiveau(current.niveauGravite)
          ? prev
          : current;
      }).niveauGravite;
      for (const zoneType of zoneTypes) {
        // Normalement il y a au maximum une zone par type mais si ils ont fait plusieurs AR avec des règles de gestions différentes il se peut que plusieurs zones AEP se superposent
        let zonesSameType = zones.filter((z) => z.type === zoneType);

        // Gestion des ressources influencées
        if (
          zonesSameType.some((z) => z.ressourceInfluencee) &&
          zonesSameType.some((z) => !z.ressourceInfluencee)
        ) {
          zonesSameType = zonesSameType.filter((z) => !z.ressourceInfluencee);
        }

        if (
          zonesSameType.length === 1 &&
          zonesSameType[0].niveauGravite !== maxNiveauGravite
        ) {
          // Si il n'y a qu'une zone et que ce n'est pas son niveau de gravité de base, on la duplique pour avoir la zone au niveau de la commune avec le bon niveau de gravité
          const zoneToDuplicate = await this.findOneWithCommuneZone(
            zonesSameType[0].id,
            commune.id,
          );
          zoneToDuplicate.niveauGravite = maxNiveauGravite;
          zonesToSave.push(zoneToDuplicate);
          queries.push(
            this.getQueryToReduceZone(zonesSameType[0].id, commune.id),
          );
        } else if (zonesSameType.length > 1) {
          // Si plusieurs zones du même type, on prend celle qui a le niveau de gravité le plus élevé, ou une au pif
          const maxNiveauGraviteZonesSameType = zonesSameType.reduce(
            (prev, current) => {
              return Utils.getNiveau(prev.niveauGravite) >
                Utils.getNiveau(current.niveauGravite)
                ? prev
                : current;
            },
          ).niveauGravite;
          let zoneToKeep = zonesSameType.filter(
            (z) => z.niveauGravite === maxNiveauGraviteZonesSameType,
          );
          if (zoneToKeep.length > 1) {
            zoneToKeep = zoneToKeep.reduce((prev, current) => {
              return prev.areaCommune > current.areaCommune ? prev : current;
            });
          } else {
            zoneToKeep = zoneToKeep[0];
          }
          if (zoneToKeep.niveauGravite !== maxNiveauGravite) {
            const zoneToDuplicate = await this.findOneWithCommuneZone(
              zoneToKeep.id,
              commune.id,
            );
            zoneToDuplicate.niveauGravite = maxNiveauGravite;
            zonesToSave.push(zoneToDuplicate);
            queries.push(this.getQueryToReduceZone(zoneToKeep.id, commune.id));
          } else {
            queries.push(this.getQueryToExtendZone(zoneToKeep.id, commune.id));
          }
          zonesSameType
            .filter((z) => z.id !== zoneToKeep.id && !z.ressourceInfluencee)
            .forEach((z) => {
              queries.push(this.getQueryToReduceZone(z.id, commune.id));
            });
        } else if (zonesSameType.length <= 0) {
          // Si il n'y a pas de zone, on en crée une
          let zoneToDuplicate = zones
            .filter((z) => z.niveauGravite === maxNiveauGravite)
            .reduce((prev, current) => {
              return prev.areaCommune > current.areaCommune ? prev : current;
            });
          zoneToDuplicate = await this.findOneWithCommuneZone(
            zoneToDuplicate.id,
            commune.id,
          );
          zoneToDuplicate.type = zoneType;
          zonesToSave.push(zoneToDuplicate);
        }
      }
    }
    await Promise.all(queries.map((q) => q.execute()));
    zonesToSave = zonesToSave.map((z) => {
      z.id = null;
      z.geom = JSON.parse(z.geom);
      return z;
    });
    await this.zoneAlerteComputedHistoricRepository.save(zonesToSave);
    await this.fusionSameZones(departement);
    await this.cleanZones(departement);
    this.logger.log(
      `COMPUTING ${departement.code} - ${departement.nom} - ${exceptAep ? 'YES_EXCEPT_AEP' : 'YES_ALL'} END`,
    );
  }

  getNiveauGravite(zoneId, restrictions) {
    const r = restrictions.find((r) =>
      r.zonesAlerteComputed?.some((z) => z.id === zoneId),
    );
    return Utils.getNiveau(r?.niveauGravite);
  }

  getQueryToExtendZone(zoneId, communeId) {
    return this.zoneAlerteComputedHistoricRepository
      .createQueryBuilder('zone_alerte_computed_historic')
      .update()
      .set({
        geom: () =>
          `ST_UNION(zone_alerte_computed_historic.geom, (select c.geom from commune as c where c.id = ${communeId}))`,
      })
      .where('zone_alerte_computed_historic.id = :id', { id: zoneId });
  }

  getQueryToReduceZone(zoneId, communeId) {
    return this.zoneAlerteComputedHistoricRepository
      .createQueryBuilder('zone_alerte_computed_historic')
      .update()
      .set({
        geom: () =>
          `ST_DIFFERENCE(zone_alerte_computed_historic.geom, (select c.geom from commune as c where c.id = ${communeId}))`,
      })
      .where('zone_alerte_computed_historic.id = :id', { id: zoneId });
  }

  async cleanZones(departement: Departement) {
    await this.zoneAlerteComputedHistoricRepository
      .createQueryBuilder('zone_alerte_computed_historic')
      .update()
      .set({
        geom: () =>
          `st_makevalid(geom, 'method=structure keepcollapsed=false')`,
      })
      .where('not st_isvalid(geom)')
      .andWhere('"departementId" = :id', { id: departement.id })
      .execute();
    await this.zoneAlerteComputedHistoricRepository
      .createQueryBuilder('zone_alerte_computed_historic')
      .update()
      .set({ geom: () => 'ST_CollectionExtract(geom, 3)' })
      .where('"departementId" = :id', { id: departement.id })
      .execute();
    await this.dataSource.query(
      `
        UPDATE zone_alerte_computed_historic
        SET geom = ST_CollectionExtract(
          ST_MakeValid(geom, 'method=structure keepcollapsed=false'),
          3
        )
        WHERE "departementId" = $1
          AND geom IS NOT NULL
          AND NOT ST_IsEmpty(geom)
          AND NOT ST_IsValid(geom, 0)
      `,
      [departement.id],
    );
    await this.dataSource.query(
      `
        DELETE FROM zone_alerte_computed_historic
        WHERE "departementId" = $1
          AND (
            geom IS NULL
            OR ST_IsEmpty(geom)
            OR ST_GeometryType(geom) NOT IN ('ST_Polygon', 'ST_MultiPolygon')
          )
      `,
      [departement.id],
    );
    const [validation] = await this.dataSource.query(
      `
        SELECT COALESCE(array_agg(id ORDER BY id), ARRAY[]::integer[])
          AS "invalidIds"
        FROM zone_alerte_computed_historic
        WHERE "departementId" = $1
          AND geom IS NOT NULL
          AND NOT ST_IsEmpty(geom)
          AND ST_GeometryType(geom) IN ('ST_Polygon', 'ST_MultiPolygon')
          AND NOT ST_IsValid(geom, 0)
      `,
      [departement.id],
    );
    const invalidIds = (validation?.invalidIds ?? []).map(Number);
    if (invalidIds.length > 0) {
      throw new Error(
        `Geometries de zones historiques calculees invalides apres nettoyage: ${invalidIds.join(',')}`,
      );
    }
    // Clean des résidus de moins de 100m²
    await this.dataSource.query(
      `
WITH cleaned_geometries AS (
      SELECT
          id,
          ST_Collect(geom) AS cleaned_geom
      FROM (
          SELECT
              id,
              (ST_Dump(geom)).geom AS geom
          FROM zone_alerte_computed_historic
          WHERE "departementId" = $1
      ) AS dumped
      WHERE ST_GeometryType(geom) = 'ST_Polygon' AND ST_Area(ST_Transform(geom, 2154)) > 100
      GROUP BY id
    )
    UPDATE zone_alerte_computed_historic
    SET geom = cleaned_geometries.cleaned_geom
    FROM cleaned_geometries
    WHERE zone_alerte_computed_historic.id = cleaned_geometries.id AND zone_alerte_computed_historic."departementId" = $1;
  `,
      [departement.id],
    );
    return;
  }

  async computeCommunesIntersected(departement: Departement) {
    const zones = await this.zoneAlerteComputedHistoricRepository
      .createQueryBuilder('zone_alerte_computed_historic')
      .select([
        'zone_alerte_computed_historic.id',
        'zone_alerte_computed_historic.idSandre',
        'zone_alerte_computed_historic.nom',
        'zone_alerte_computed_historic.code',
        'zone_alerte_computed_historic.type',
      ])
      .leftJoin('zone_alerte_computed_historic.departement', 'departement')
      // Au moins 1% de la surface en commun
      .leftJoinAndSelect(
        'commune',
        'commune',
        'commune.departement = departement.id AND ST_INTERSECTS(zone_alerte_computed_historic.geom, commune.geom) AND ST_Area(ST_Intersection(zone_alerte_computed_historic.geom, commune.geom)) / ST_AREA(commune.geom) > 0.01',
      )
      .where('departement.id = :id', { id: departement.id })
      .andWhere(
        `ST_GeometryType(zone_alerte_computed_historic.geom) IN ('ST_Polygon', 'ST_MultiPolygon')`,
      )
      .andWhere(
        'ST_IsValid(ST_TRANSFORM(zone_alerte_computed_historic.geom, 4326))',
      )
      .andWhere('ST_IsValid(ST_TRANSFORM(commune.geom, 4326))')
      .getRawMany();
    const toSave = [];
    zones.forEach((z) => {
      if (!toSave.some((s) => s.id === z.zone_alerte_computed_historic_id)) {
        toSave.push({
          id: z.zone_alerte_computed_historic_id,
          communes: [],
        });
      }
      const s = toSave.find((s) => s.id === z.zone_alerte_computed_historic_id);
      if (z.commune_id) {
        s.communes.push({
          id: z.commune_id,
        });
      }
    });
    await this.zoneAlerteComputedHistoricRepository.save(toSave);
  }

  async getZonesAlerteComputedByDepartement(
    departement: Departement,
  ): Promise<ZoneAlerteComputedHistoric[]> {
    const zonesDepartement = await this.zoneAlerteComputedHistoricRepository
      .createQueryBuilder('zone_alerte_computed_historic')
      .select(
        'ST_AsGeoJSON(ST_TRANSFORM(zone_alerte_computed_historic.geom, 4326))',
        'geom',
      )
      .addSelect('zone_alerte_computed_historic.id', 'id')
      .addSelect('zone_alerte_computed_historic.idSandre', 'idSandre')
      .addSelect('zone_alerte_computed_historic.nom', 'nom')
      .addSelect('zone_alerte_computed_historic.code', 'code')
      .addSelect('zone_alerte_computed_historic.type', 'type')
      .addSelect(
        'zone_alerte_computed_historic.ressourceInfluencee',
        'ressourceInfluencee',
      )
      .addSelect('departement.id', 'departement_id')
      .addSelect('"niveauGravite"')
      .leftJoin('zone_alerte_computed_historic.departement', 'departement')
      .where('departement.id = :id', { id: departement.id })
      .getRawMany<ZoneAlerteComputedHistoric & { departement_id: number }>();
    await Promise.all(
      zonesDepartement.map(async (z) => {
        z.restriction =
          await this.restrictionService.findOneByZoneAlerteComputedHistoric(
            z.id,
          );
        z.departement = {
          id: z.departement_id,
        } as Departement;
        return z;
      }),
    );
    return zonesDepartement;
  }

  computeNewZone(zone: any) {
    const qb = this.zoneAlerteComputedHistoricRepository.createQueryBuilder(
      'zone_alerte_computed_historic',
    );
    let sqlString = `ST_AsGeoJSON(ST_TRANSFORM(`;
    if (zone.remove && zone.remove.length > 0) {
      sqlString += `ST_DIFFERENCE(zone_alerte_computed_historic.geom, `;
      sqlString += `(SELECT ST_UNION(zaBis.geom) FROM zone_alerte_computed_historic as zaBis WHERE zaBis.id IN (${zone.remove.join(', ')}))`;
      sqlString += `)`;
    } else {
      sqlString += `zone_alerte_computed_historic.geom`;
    }
    sqlString += `, 4326))`;
    return qb
      .select(sqlString, 'geom')
      .where('zone_alerte_computed_historic.id = :id', { id: zone.id })
      .getRawOne();
  }

  getIntersect(zoneId: number, otherZonesId: number[]) {
    return this.zoneAlerteComputedHistoricRepository
      .createQueryBuilder('zone_alerte_computed_historic')
      .select('zone_alerte_computed_historic.id', 'id')
      .addSelect('zone_alerte_computed_historic.code', 'code')
      .addSelect('zone_alerte_computed_historic.nom', 'nom')
      .addSelect('zone_alerte_computed_historic.type', 'type')
      .where('zone_alerte_computed_historic.id != :id', { id: zoneId })
      .andWhere('zone_alerte_computed_historic.id IN(:...ids)', {
        ids: otherZonesId,
      })
      .andWhere(
        'ST_INTERSECTS(zone_alerte_computed_historic.geom, (SELECT zaBis.geom FROM zone_alerte_computed_historic as zaBis WHERE zaBis.id = :id))',
        { id: zoneId },
      )
      .getRawMany();
  }

  getZonesIntersectedWithCommune(
    zones: ZoneAlerteComputedHistoric[],
    communeId: number,
  ) {
    return (
      this.zoneAlerteComputedHistoricRepository
        .createQueryBuilder('zone_alerte_computed_historic')
        .select('zone_alerte_computed_historic.id', 'id')
        .addSelect('zone_alerte_computed_historic.code', 'code')
        .addSelect('zone_alerte_computed_historic.nom', 'nom')
        .addSelect('zone_alerte_computed_historic.type', 'type')
        .where('zone_alerte_computed_historic.id IN(:...zonesId)', {
          zonesId: zones.map((z) => z.id),
        })
        .andWhere(
          `ST_GeometryType(zone_alerte_computed_historic.geom) IN ('ST_Polygon', 'ST_MultiPolygon')`,
        )
        .andWhere(
          'ST_INTERSECTS(zone_alerte_computed_historic.geom, (SELECT c.geom FROM commune as c WHERE c.id = :communeId))',
          { communeId },
        )
        // Au moins 1% de la surface en commun
        .andWhere(
          'ST_Area(ST_Intersection(zone_alerte_computed_historic.geom, (SELECT c.geom FROM commune as c WHERE c.id = :communeId))) / ST_Area((SELECT c.geom FROM commune as c WHERE c.id = :communeId)) > 0.01',
          { communeId },
        )
        .getRawMany()
    );
  }

  async findOneWithCommuneZone(id: number, communeId: number): Promise<any> {
    const zoneFull = await this.zoneAlerteComputedHistoricRepository.findOne({
      where: { id },
      relations: ['departement', 'bassinVersant', 'restriction'],
    });
    const zoneGeom = await this.zoneAlerteComputedHistoricRepository
      .createQueryBuilder('zone_alerte_computed')
      .select(
        `ST_AsGeoJSON(ST_TRANSFORM((select commune.geom from commune where commune.id = ${communeId}), 4326))`,
        'geom',
      )
      .where('zone_alerte_computed.id = :id', { id })
      .getRawOne();
    zoneFull.geom = zoneGeom.geom;
    return zoneFull;
  }

  async fusionSameZones(departement: Departement) {
    const groupedResults = await this.zoneAlerteComputedHistoricRepository
      .createQueryBuilder('zone_alerte_computed_historic')
      .select('MIN(id)', 'id')
      .addSelect(['nom', 'type', '"niveauGravite"'])
      .addSelect('ST_Union(geom)', 'merged_geom')
      .groupBy('nom')
      .addGroupBy('type')
      .addGroupBy('"niveauGravite"')
      .where('"departementId" = :id', { id: departement.id })
      .having('COUNT(*) > 1')
      .getRawMany();

    await Promise.all(
      groupedResults.map(async (row) => {
        const { id, merged_geom } = row;
        return this.dataSource.query(
          `
UPDATE zone_alerte_computed_historic
    SET geom = $1
    WHERE id = $2
  `,
          [merged_geom, id],
        );
      }),
    );

    await Promise.all(
      groupedResults.map(async (row) => {
        const { nom, type, niveauGravite, id } = row;
        return this.dataSource.query(
          `
DELETE FROM zone_alerte_computed_historic 
    WHERE nom = $2 AND type = $3 AND "niveauGravite" = $4 AND "departementId" = $5 AND id != $1
  `,
          [id, nom, type, niveauGravite, departement.id],
        );
      }),
    );
  }

  async computeGeoJson(
    date: Moment,
    activeArIds?: number[],
    expectedSourceRevision?: string,
  ) {
    const allZonesComputed: any =
      await this.zoneAlerteComputedHistoricRepository.find(<FindManyOptions>{
        select: {
          id: true,
          idSandre: true,
          code: true,
          nom: true,
          type: true,
          niveauGravite: true,
          departement: {
            code: true,
            nom: true,
          },
          restriction: {
            niveauGravite: true,
            arreteRestriction: {
              id: true,
              numero: true,
              dateDebut: true,
              dateFin: true,
              dateSignature: true,
              fichier: {
                url: true,
              },
            },
            usages: {
              nom: true,
              concerneParticulier: true,
              concerneEntreprise: true,
              concerneExploitation: true,
              concerneCollectivite: true,
              concerneEso: true,
              concerneEsu: true,
              concerneAep: true,
              descriptionVigilance: true,
              descriptionAlerte: true,
              descriptionAlerteRenforcee: true,
              descriptionCrise: true,
              thematique: {
                nom: true,
              },
            },
          },
        },
        relations: [
          'departement',
          'restriction',
          'restriction.usages',
          'restriction.usages.thematique',
          'restriction.arreteRestriction',
          'restriction.arreteRestriction.fichier',
        ],
      });

    const allZones = await this.formatComputedHistoricZones(
      allZonesComputed,
      date,
    );
    const sourceArIds =
      activeArIds ??
      (await this.arreteResrictionService.findByDate(date)).map(
        (arrete) => arrete.id,
      );
    await this.assertHistoricSourceCoverage(
      sourceArIds,
      allZonesComputed,
      date,
      'computed',
    );
    await this.assertExpectedSourceRevision(expectedSourceRevision);

    const geojson = {
      type: 'FeatureCollection',
      features: allZones,
    };
    const computedPmtilesFeatureIds =
      collectComputedHistoricPmtilesFeatureIds(allZones);
    const expectedPmtilesFeatureIds =
      computedPmtilesFeatureIds.expectedFeatureIds;
    if (computedPmtilesFeatureIds.excludedNonRenderableGeometryIds.length > 0) {
      this.logger.warn(
        JSON.stringify({
          type: 'computed_historic_pmtiles_non_renderable_geometries_excluded',
          computedFor: date.format('YYYY-MM-DD'),
          zoneIds: computedPmtilesFeatureIds.excludedNonRenderableGeometryIds,
        }),
      );
    }

    const path = this.nestConfigService.get('PATH_TO_WRITE_FILE');
    const fileName = `zones_arretes_en_vigueur_${date.format('YYYY-MM-DD')}`;
    const geojsonPath = `${path}/${fileName}.geojson`;
    const pmtilesPath = `${path}/${fileName}.pmtiles`;
    await withHistoricArtifactCleanup(
      [geojsonPath, pmtilesPath],
      async () => {
        await writeFile(geojsonPath, JSON.stringify(geojson));
        if (expectedPmtilesFeatureIds.length === 0) {
          await generateEmptyPmtiles({
            workingDirectory: path,
            outputPath: pmtilesPath,
          });
        } else {
          await generatePmtiles({
            workingDirectory: path,
            inputPath: geojsonPath,
            outputPath: pmtilesPath,
            expectedFeatureIds: expectedPmtilesFeatureIds,
            optionalFeatureIds:
              computedPmtilesFeatureIds.excludedNonRenderableGeometryIds,
            maximumZoom: COMPUTED_HISTORIC_PMTILES_MAX_ZOOM,
          });
        }
        const fileToTransferPmtiles = {
          originalname: `${fileName}.pmtiles`,
          buffer: readFileSync(pmtilesPath),
        };
        const fileToTransferGeojson = {
          originalname: `${fileName}.geojson`,
          buffer: readFileSync(geojsonPath),
        };
        await this.s3Service.uploadFile(
          fileToTransferPmtiles as Express.Multer.File,
          'pmtiles/',
        );
        await this.s3Service.uploadFile(
          fileToTransferGeojson as Express.Multer.File,
          'geojson/',
        );
      },
      (artifactPath, error) =>
        this.logger.error(
          `ERROR CLEANING HISTORIC ARTIFACT ${artifactPath}`,
          error instanceof Error ? error.toString() : String(error),
        ),
    );
    return allZonesComputed;
  }

  async findLegacyHistoricDepartmentZones(
    departementCode: string,
    computedFor: string,
  ): Promise<ZoneAlerteComputedHistoric[]> {
    const date = moment.utc(computedFor, 'YYYY-MM-DD', true);
    if (!date.isValid() || date.format('YYYY-MM-DD') !== computedFor) {
      throw new Error(`Invalid historic department date: ${computedFor}`);
    }
    const arretes = await this.arreteResrictionService.findByDepartementAndDate(
      departementCode,
      date,
    );
    const arreteIds = arretes.map((arrete) => arrete.id);
    if (arreteIds.length === 0) {
      return [];
    }
    const zones = (await this.zoneAlerteService.findByArreteRestriction(
      arreteIds,
    )) as ZoneAlerte[];
    const normalized = await this.formatLegacyHistoricZones(
      zones,
      arreteIds,
      date,
    );
    return normalized.zones.map((zone) => {
      const restriction = zone.restrictions[0];
      return Object.assign(Object.create(Object.getPrototypeOf(zone)), zone, {
        restriction,
        niveauGravite: restriction.niveauGravite,
      }) as unknown as ZoneAlerteComputedHistoric;
    });
  }

  async buildHistoricDepartmentFeatureCollection(
    zones: readonly ZoneAlerteComputedHistoric[],
    computedFor: string,
    legacy: boolean,
  ): Promise<{ type: 'FeatureCollection'; features: any[] }> {
    const date = moment.utc(computedFor, 'YYYY-MM-DD', true);
    if (!date.isValid() || date.format('YYYY-MM-DD') !== computedFor) {
      throw new Error(`Invalid historic department date: ${computedFor}`);
    }
    if (legacy) {
      const legacyZones = zones as unknown as ZoneAlerte[];
      const activeArIds = [
        ...new Set(
          legacyZones.flatMap((zone) =>
            (zone.restrictions ?? [])
              .map((restriction) => restriction.arreteRestriction?.id)
              .filter((id): id is number => Number.isInteger(id)),
          ),
        ),
      ];
      const formatted = await this.formatLegacyHistoricZones(
        legacyZones,
        activeArIds,
        date,
      );
      return { type: 'FeatureCollection', features: formatted.features };
    }
    return {
      type: 'FeatureCollection',
      features: await this.formatComputedHistoricZones([...zones], date),
    };
  }

  private async formatComputedHistoricZones(
    zones: ZoneAlerteComputedHistoric[],
    date: Moment,
  ) {
    const dateString = date.format('YYYY-MM-DD');
    const rawGeometries = await this.findComputedHistoricGeometriesByIds(
      zones.map((zone) => zone.id),
    );

    return zones.map((zone) => {
      const geometry = this.parseHistoricGeometry(
        rawGeometries.get(zone.id),
        zone.id,
        dateString,
      );
      zone.geom = geometry;
      const restriction = zone.restriction;
      const usages = restriction
        ? this.formatHistoricUsagesForComputed(
            restriction,
            zone.niveauGravite,
            zone.id,
            dateString,
          )
        : undefined;
      return {
        type: 'Feature',
        geometry,
        properties: {
          id: zone.id,
          idSandre: zone.idSandre,
          nom: zone.nom,
          code: zone.code,
          type: zone.type,
          niveauGravite: zone.niveauGravite,
          departement: zone.departement,
          arreteRestriction: {
            id: restriction?.arreteRestriction?.id,
            numero: restriction?.arreteRestriction?.numero,
            dateDebut: restriction?.arreteRestriction?.dateDebut,
            dateFin: restriction?.arreteRestriction?.dateFin,
            dateSignature: restriction?.arreteRestriction?.dateSignature,
            fichier: restriction?.arreteRestriction?.fichier?.url,
          },
          restrictions: usages,
        },
      };
    });
  }

  private async findComputedHistoricGeometriesByIds(
    ids: readonly number[],
  ): Promise<ReadonlyMap<number, string>> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) {
      return new Map();
    }
    const rows: Array<{ id: number; geom: string | null }> =
      await this.dataSource.query(
        `
          WITH transformed AS MATERIALIZED (
            SELECT
              zone.id,
              ST_Transform(zone.geom, 4326) AS geom
            FROM "zone_alerte_computed_historic" zone
            WHERE zone.id = ANY($1::int[])
          ), normalized AS MATERIALIZED (
            SELECT
              transformed.id,
              CASE
                WHEN ST_IsValid(transformed.geom, 0) THEN transformed.geom
                ELSE ST_CollectionExtract(
                  ST_MakeValid(
                    transformed.geom,
                    'method=structure keepcollapsed=false'
                  ),
                  3
                )
              END AS geom
            FROM transformed
          )
          SELECT
            normalized.id AS "id",
            CASE
              WHEN normalized.geom IS NULL
                OR ST_IsEmpty(normalized.geom)
                OR ST_GeometryType(normalized.geom) NOT IN ('ST_Polygon', 'ST_MultiPolygon')
                OR NOT ST_IsValid(normalized.geom, 0)
              THEN NULL
              ELSE ST_AsGeoJSON(normalized.geom)
            END AS "geom"
          FROM normalized
          ORDER BY normalized.id
        `,
        [uniqueIds],
      );
    const geometries = new Map<number, string>();
    for (const row of rows) {
      if (row.geom) {
        geometries.set(Number(row.id), row.geom);
      }
    }
    const missingIds = uniqueIds.filter((id) => !geometries.has(id));
    if (missingIds.length > 0) {
      throw new Error(
        `Missing geometry for computed historic zone(s): ${missingIds.join(', ')}`,
      );
    }
    return geometries;
  }

  private formatHistoricUsagesForComputed(
    restriction: Restriction,
    niveauGravite: ZoneAlerteComputedHistoric['niveauGravite'],
    zoneId: number,
    date: string,
  ) {
    if (!restriction.arreteRestriction) {
      throw new Error(
        `Missing decree for computed historic zone ${zoneId} on ${date}`,
      );
    }
    if (
      restriction.usages !== undefined &&
      !Array.isArray(restriction.usages)
    ) {
      throw new Error(
        `Usages were not loaded for computed historic zone ${zoneId} on ${date}`,
      );
    }
    return (restriction.usages ?? []).map((usage) => {
      if (!usage.thematique?.nom) {
        throw new Error(
          `Missing theme for computed historic zone ${zoneId} usage ${usage.id} on ${date}`,
        );
      }
      return this.formatHistoricUsage(usage, restriction, niveauGravite);
    });
  }

  async getZonesArea(zones: ZoneAlerteComputed[]) {
    return this.zoneAlerteComputedHistoricRepository
      .createQueryBuilder('zone_alerte_computed_historic')
      .select(
        'SUM(ST_Area(zone_alerte_computed_historic.geom::geography)/1000000)',
        'area',
      )
      .where('zone_alerte_computed_historic.id IN(:...ids)', {
        ids: zones.map((z) => z.id),
      })
      .getRawOne();
  }
}
