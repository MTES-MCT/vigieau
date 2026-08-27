import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryRunner, Repository } from 'typeorm';
import { StatisticCommune } from '@shared/entities/statistic_commune.entity';
import { ZoneAlerteComputed } from '@shared/entities/zone_alerte_computed.entity';
import { RegleauLogger } from '../logger/regleau.logger';
import { CommuneService } from '../commune/commune.service';
// Moment still exposes a CommonJS callable export under the current Jest/NodeNext setup.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import moment = require('moment');
import { Moment } from 'moment';
import { sourceRevisionColumn } from '../zone_publication/zone_publication.config';
import {
  isExactEmptyMultiPolygonGeometry,
  LEGACY_HISTORIC_EMPTY_GEOMETRY_ZONE_IDS,
} from '../zone_alerte_computed/legacy-historic-empty-geometries';

const STATISTIC_COMMUNE_SNAPSHOT_LOCK =
  'vigieau:statistic-commune:snapshot-computation';
export const CURRENT_COMMUNE_STATISTICS_LOCK_WAIT_TIMEOUT_MS_DEFAULT = 600_000;
const CURRENT_COMMUNE_STATISTICS_LOCK_WAIT_TIMEOUT_MS_LIMIT = 1_800_000;
const DEFAULT_COMMUNE_STATISTICS_BATCH_SIZE = 250;
const MAX_COMMUNE_STATISTICS_BATCH_SIZE = 1000;
export const HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS_DEFAULT = 7;
const HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS_LIMIT = 31;
const STATISTIC_ZONE_TYPES = ['SUP', 'SOU', 'AEP'] as const;
const STATISTIC_SEVERITIES = [
  'vigilance',
  'alerte',
  'alerte_renforcee',
  'crise',
] as const;

export type StatisticSeverity = (typeof STATISTIC_SEVERITIES)[number];

export function parseCommuneStatisticsBatchSize(
  value: string | undefined,
): number {
  if (value === undefined) {
    return DEFAULT_COMMUNE_STATISTICS_BATCH_SIZE;
  }

  const normalizedValue = value.trim();
  if (!/^\d+$/.test(normalizedValue)) {
    throw new Error(
      `Invalid COMMUNE_STATISTICS_BATCH_SIZE: ${value} (expected an integer between 1 and ${MAX_COMMUNE_STATISTICS_BATCH_SIZE})`,
    );
  }

  const batchSize = Number(normalizedValue);
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > MAX_COMMUNE_STATISTICS_BATCH_SIZE
  ) {
    throw new Error(
      `Invalid COMMUNE_STATISTICS_BATCH_SIZE: ${value} (expected an integer between 1 and ${MAX_COMMUNE_STATISTICS_BATCH_SIZE})`,
    );
  }

  return batchSize;
}

export function parseHistoricEmptyStatisticsRangeMaxDays(
  value = process.env.HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS,
): number {
  if (value === undefined || value.trim() === '') {
    return HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS_DEFAULT;
  }
  const normalizedValue = value.trim();
  if (!/^[1-9]\d*$/.test(normalizedValue)) {
    throw new Error(
      'Invalid HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS: expected a positive integer',
    );
  }
  const maxDays = Number(normalizedValue);
  if (
    !Number.isSafeInteger(maxDays) ||
    maxDays > HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS_LIMIT
  ) {
    throw new Error(
      `Invalid HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS: expected at most ${HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS_LIMIT}`,
    );
  }
  return maxDays;
}

export function parseCurrentCommuneStatisticsLockWaitTimeoutMs(
  value = process.env.CURRENT_COMMUNE_STATISTICS_LOCK_WAIT_TIMEOUT_MS,
): number {
  if (value === undefined || value.trim() === '') {
    return CURRENT_COMMUNE_STATISTICS_LOCK_WAIT_TIMEOUT_MS_DEFAULT;
  }
  const normalizedValue = value.trim();
  if (!/^[1-9]\d*$/.test(normalizedValue)) {
    throw new Error(
      'Invalid CURRENT_COMMUNE_STATISTICS_LOCK_WAIT_TIMEOUT_MS: expected a positive integer',
    );
  }
  const timeoutMs = Number(normalizedValue);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs > CURRENT_COMMUNE_STATISTICS_LOCK_WAIT_TIMEOUT_MS_LIMIT
  ) {
    throw new Error(
      `Invalid CURRENT_COMMUNE_STATISTICS_LOCK_WAIT_TIMEOUT_MS: expected at most ${CURRENT_COMMUNE_STATISTICS_LOCK_WAIT_TIMEOUT_MS_LIMIT}`,
    );
  }
  return timeoutMs;
}

interface CommuneStatisticRestriction {
  date: string;
  SOU: StatisticSeverity | null;
  SUP: StatisticSeverity | null;
  AEP: StatisticSeverity | null;
}

export interface HistoricCommuneStatisticSegment {
  runId: string;
  departementId: number;
  communeId: number;
  validFrom: string;
  validThrough: string;
  SOU: StatisticSeverity | null;
  SUP: StatisticSeverity | null;
  AEP: StatisticSeverity | null;
  sourceGeneration: string;
  inputSignature: string;
}

export interface HistoricCommuneStatisticSegmentBatch {
  runId: string;
  departementId: number;
  departementCode: string;
  computedFor: string;
  validThrough: string;
  sourceGeneration: string;
  inputSignature: string;
  offset: number;
  expectedCommuneCount: number;
  processedCommuneCount: number;
  segments: readonly HistoricCommuneStatisticSegment[];
}

export interface HistoricCommuneStatisticSegmentSink {
  /** Implementations must make repeated writes of the same primary keys idempotent. */
  writeSegments(batch: HistoricCommuneStatisticSegmentBatch): Promise<void>;
}

export interface HistoricCommuneStatisticStagingOptions {
  runId: string;
  departementId: number;
  departementCode: string;
  sourceGeneration: string;
  inputSignature: string;
  validThrough?: string;
  historicNotComputed?: boolean;
  sink: HistoricCommuneStatisticSegmentSink;
}

export interface HistoricCommuneStatisticStagingResult {
  expectedCommuneCount: number;
  processedCommuneCount: number;
  segmentCount: number;
}

export interface HistoricCommuneStatisticShadowInput {
  communeId: number;
  currentRestrictions?: readonly unknown[] | null;
  currentRestrictionsByMonth?: readonly unknown[] | null;
  segments: readonly HistoricCommuneStatisticSegment[];
}

export interface HistoricCommuneStatisticShadow {
  communeId: number;
  nextRestrictions: unknown[];
  nextRestrictionsByMonth: unknown[];
}

interface StatisticZoneInput {
  id: number;
  departementCode: string;
}

interface CommuneZoneIntersection {
  communeId: number | string;
  zoneId: number | string | null;
}

interface StatisticSnapshotHooks {
  beforeCommuneStatistics?: () => Promise<void>;
  beforeCertification?: () => Promise<void>;
  deferCertificationUntilPublication?: boolean;
  preserveBootstrapBarrier?: boolean;
  requireNationalCoverage?: boolean;
  publishCurrentDate?: boolean;
  bumpLegacyRevisionOnCompletion?: boolean;
  sourceRevision?: string;
  historicComputeEpoch?: string;
}

interface StatisticSnapshotCertificationOptions {
  requireNationalCoverage?: boolean;
  publishCurrentDate?: boolean;
  bumpLegacyRevisionOnCompletion?: boolean;
}

export interface EmptyHistoricStatisticDay {
  date: Date;
  beforeCommuneStatistics?: () => Promise<void>;
  beforeCertification?: () => Promise<void>;
}

export interface EmptyHistoricStatisticRangeOptions {
  sourceRevision: string;
  historicComputeEpoch: string;
}

interface MonthlyStatisticComputationOptions {
  aggregateThrough?: Moment;
  allowedReadySnapshot?: {
    date: string;
    sourceRevision: string;
  };
}

const HISTORIC_RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA_256_PATTERN = /^[0-9a-f]{64}$/;

function getStringProperty(value: unknown, property: string): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = (value as Record<string, unknown>)[property];
  return typeof candidate === 'string' ? candidate : null;
}

function isStrictDate(value: string, format: 'YYYY-MM-DD' | 'YYYY-MM') {
  return moment.utc(value, format, true).isValid();
}

function sortStatisticValues(
  values: unknown[],
  format: 'YYYY-MM-DD' | 'YYYY-MM',
): unknown[] {
  return values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => {
      const leftDate = getStringProperty(left.value, 'date');
      const rightDate = getStringProperty(right.value, 'date');
      const leftValid = leftDate !== null && isStrictDate(leftDate, format);
      const rightValid = rightDate !== null && isStrictDate(rightDate, format);
      if (leftValid !== rightValid) {
        return leftValid ? -1 : 1;
      }
      if (leftValid && rightValid && leftDate !== rightDate) {
        return leftDate.localeCompare(rightDate);
      }
      return left.index - right.index;
    })
    .map(({ value }) => value);
}

function validateHistoricSegment(
  segment: HistoricCommuneStatisticSegment,
): void {
  if (!HISTORIC_RUN_ID_PATTERN.test(segment.runId)) {
    throw new Error(`Invalid historic statistic run id: ${segment.runId}`);
  }
  if (
    !Number.isInteger(segment.departementId) ||
    segment.departementId <= 0 ||
    !Number.isInteger(segment.communeId) ||
    segment.communeId <= 0
  ) {
    throw new Error('Invalid historic statistic segment identifiers');
  }
  if (
    !isStrictDate(segment.validFrom, 'YYYY-MM-DD') ||
    !isStrictDate(segment.validThrough, 'YYYY-MM-DD') ||
    segment.validThrough < segment.validFrom
  ) {
    throw new Error(
      `Invalid historic statistic segment range: ${segment.validFrom}/${segment.validThrough}`,
    );
  }
  if (!/^\d+$/.test(segment.sourceGeneration)) {
    throw new Error(
      `Invalid historic statistic source generation: ${segment.sourceGeneration}`,
    );
  }
  if (!SHA_256_PATTERN.test(segment.inputSignature)) {
    throw new Error('Invalid historic statistic input signature');
  }
  for (const type of STATISTIC_ZONE_TYPES) {
    const severity = segment[type];
    if (
      severity !== null &&
      !STATISTIC_SEVERITIES.includes(severity as StatisticSeverity)
    ) {
      throw new Error(
        `Invalid historic statistic severity for ${type}: ${String(severity)}`,
      );
    }
  }
}

function restrictionFromSegment(
  segment: HistoricCommuneStatisticSegment,
  date: string,
): CommuneStatisticRestriction {
  return {
    date,
    SOU: segment.SOU,
    SUP: segment.SUP,
    AEP: segment.AEP,
  };
}

function restrictionsAreEqual(
  left: CommuneStatisticRestriction,
  right: CommuneStatisticRestriction,
): boolean {
  return (
    left.SOU === right.SOU && left.SUP === right.SUP && left.AEP === right.AEP
  );
}

function statisticRestrictionWeight(value: unknown): number {
  let highestSeverity = -1;
  for (const type of STATISTIC_ZONE_TYPES) {
    const severity = getStringProperty(value, type);
    highestSeverity = Math.max(
      highestSeverity,
      STATISTIC_SEVERITIES.indexOf(severity as StatisticSeverity),
    );
  }
  switch (highestSeverity) {
    case 0:
      return 0.5;
    case 1:
      return 2;
    case 2:
      return 3;
    case 3:
      return 4;
    default:
      return 0;
  }
}

export function reduceHistoricCommuneStatisticShadow(
  input: HistoricCommuneStatisticShadowInput,
): HistoricCommuneStatisticShadow {
  if (!Number.isInteger(input.communeId) || input.communeId <= 0) {
    throw new Error(
      `Invalid historic statistic commune id: ${input.communeId}`,
    );
  }

  const restrictionsByDate = new Map<string, CommuneStatisticRestriction>();
  let runId: string | null = null;
  let departementId: number | null = null;
  let sourceGeneration: string | null = null;
  for (const segment of input.segments) {
    validateHistoricSegment(segment);
    if (segment.communeId !== input.communeId) {
      throw new Error(
        `Historic statistic segment commune mismatch: ${segment.communeId}/${input.communeId}`,
      );
    }
    if (
      (runId !== null && runId !== segment.runId) ||
      (departementId !== null && departementId !== segment.departementId) ||
      (sourceGeneration !== null &&
        sourceGeneration !== segment.sourceGeneration)
    ) {
      throw new Error('Historic statistic shadow mixes incompatible segments');
    }
    runId = segment.runId;
    departementId = segment.departementId;
    sourceGeneration = segment.sourceGeneration;

    const lastDate = moment.utc(segment.validThrough, 'YYYY-MM-DD', true);
    for (
      const cursor = moment.utc(segment.validFrom, 'YYYY-MM-DD', true);
      cursor.isSameOrBefore(lastDate, 'day');
      cursor.add(1, 'day')
    ) {
      const date = cursor.format('YYYY-MM-DD');
      const restriction = restrictionFromSegment(segment, date);
      const existing = restrictionsByDate.get(date);
      if (existing && !restrictionsAreEqual(existing, restriction)) {
        throw new Error(
          `Conflicting historic statistic segments for commune ${input.communeId} on ${date}`,
        );
      }
      restrictionsByDate.set(date, restriction);
    }
  }

  const touchedDates = new Set(restrictionsByDate.keys());
  const nextRestrictions = sortStatisticValues(
    [
      ...(input.currentRestrictions ?? []).filter(
        (value) => !touchedDates.has(getStringProperty(value, 'date') ?? ''),
      ),
      ...restrictionsByDate.values(),
    ],
    'YYYY-MM-DD',
  );

  const touchedMonths = new Set(
    [...touchedDates].map((date) => date.slice(0, 7)),
  );
  const nextMonthlyValues: unknown[] = [
    ...(input.currentRestrictionsByMonth ?? []).filter(
      (value) => !touchedMonths.has(getStringProperty(value, 'date') ?? ''),
    ),
  ];
  const ponderationByMonth = new Map(
    [...touchedMonths].map((month) => [month, 0]),
  );
  for (const value of nextRestrictions) {
    const date = getStringProperty(value, 'date');
    if (date === null || !isStrictDate(date, 'YYYY-MM-DD')) {
      continue;
    }
    const month = date.slice(0, 7);
    const ponderation = ponderationByMonth.get(month);
    if (ponderation !== undefined) {
      ponderationByMonth.set(
        month,
        ponderation + statisticRestrictionWeight(value),
      );
    }
  }
  for (const [month, ponderation] of [...ponderationByMonth].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    nextMonthlyValues.push({ date: month, ponderation });
  }

  return {
    communeId: input.communeId,
    nextRestrictions,
    nextRestrictionsByMonth: sortStatisticValues(nextMonthlyValues, 'YYYY-MM'),
  };
}

@Injectable()
export class StatisticCommuneService {
  private readonly logger = new RegleauLogger('StatisticCommuneService');

  constructor(
    @InjectRepository(StatisticCommune)
    private readonly statisticCommuneRepository: Repository<StatisticCommune>,
    private readonly communeService: CommuneService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {
    // setTimeout(() => {
    //   this.computeByMonth();
    // }, 5000);
  }

  async getStatisticCommuneStream(queryRunner?: QueryRunner) {
    const queryable = queryRunner ?? this.dataSource;
    const repository = queryRunner
      ? queryRunner.manager.getRepository(StatisticCommune)
      : this.statisticCommuneRepository;
    await this.assertNoIncompleteSnapshots(undefined, undefined, queryable);
    return repository
      .createQueryBuilder('sc')
      .innerJoin('sc.commune', 'commune')
      .select('commune.code', 'commune_code')
      .addSelect('commune.nom', 'commune_nom')
      .addSelect('sc.restrictions', 'sc_restrictions')
      .where(
        `NOT EXISTS (
          SELECT 1
          FROM statistic_commune_snapshot snapshot
          WHERE snapshot.status <> 'completed'
        )`,
      )
      .orderBy('commune.code', 'ASC')
      .stream();
  }

  async getStatisticCommuneStreamForYear(year: number) {
    if (!Number.isInteger(year) || year < 2013 || year > 9999) {
      throw new Error(`Invalid statistic year: ${year}`);
    }

    const startDate = `${year}-01-01`;
    const endDate = `${year + 1}-01-01`;
    await this.assertNoIncompleteSnapshots(startDate, endDate);

    return this.statisticCommuneRepository
      .createQueryBuilder('sc')
      .innerJoin('sc.commune', 'commune')
      .select('commune.code', 'commune_code')
      .addSelect('commune.nom', 'commune_nom')
      .addSelect(
        `COALESCE(
          (
            SELECT jsonb_agg(restriction.value ORDER BY restriction.value ->> 'date')
            FROM jsonb_array_elements(COALESCE(sc.restrictions, '[]'::jsonb)) AS restriction(value)
            WHERE restriction.value ->> 'date' >= :startDate::text
              AND restriction.value ->> 'date' < :endDate::text
          ),
          '[]'::jsonb
        )`,
        'sc_restrictions',
      )
      .setParameters({ startDate, endDate })
      .where(
        `NOT EXISTS (
          SELECT 1
          FROM statistic_commune_snapshot snapshot
          WHERE snapshot.status <> 'completed'
            AND (
              snapshot.scope = 'bootstrap'
              OR (
                snapshot."snapshotDate" >= :startDate::date
                AND snapshot."snapshotDate" < :endDate::date
              )
            )
        )`,
      )
      .orderBy('commune.code', 'ASC')
      .stream();
  }

  async computeCommuneStatisticsRestrictions(
    zones: ZoneAlerteComputed[],
    date: Date,
    historic?: boolean,
    historicNotComputed?: boolean,
    departementCodes?: string[],
    hooks?: StatisticSnapshotHooks,
  ) {
    const batchSize = parseCommuneStatisticsBatchSize(
      process.env.COMMUNE_STATISTICS_BATCH_SIZE,
    );
    const dateString = date.toISOString().split('T')[0];
    this.logger.log(
      `COMPUTING COMMUNE STATISTICS RESTRICTIONS - ${dateString}`,
    );

    const queryRunner = this.dataSource.createQueryRunner();
    let connected = false;
    let locked = false;
    let snapshotStarted = false;
    let statisticZoneGeometryPrepared = false;
    let processedCommuneCount = 0;
    const snapshotScope = this.getSnapshotScope(departementCodes);
    let nationalSnapshotAlreadyCompleted = false;

    try {
      await queryRunner.connect();
      connected = true;
      await this.acquireStatisticCommuneSnapshotLock(
        queryRunner,
        historic !== true,
      );
      locked = true;

      if (snapshotScope !== 'national') {
        nationalSnapshotAlreadyCompleted =
          await this.hasCompletedNationalSnapshot(queryRunner, dateString);
      }

      const communeSize = await this.communeService.count(departementCodes);
      await this.markSnapshotRunning(
        queryRunner,
        dateString,
        snapshotScope,
        communeSize,
        hooks?.sourceRevision,
      );
      snapshotStarted = true;
      if (communeSize === 0) {
        throw new Error('Aucune commune a calculer pour le snapshot');
      }

      const { zoneInputs, zonesById } = this.prepareStatisticZones(
        zones,
        dateString,
      );
      const { statisticZoneInputs, excludedEmptyGeometryIds } =
        this.filterLegacyHistoricEmptyStatisticZoneInputs(
          zoneInputs,
          zonesById,
          historic === true && historicNotComputed === true,
        );
      this.warnExcludedLegacyHistoricStatisticGeometries(
        excludedEmptyGeometryIds,
        dateString,
      );
      if (statisticZoneInputs.length > 0) {
        statisticZoneGeometryPrepared = true;
        await this.prepareStatisticZoneGeometryTable(
          queryRunner,
          statisticZoneInputs,
          Boolean(historic),
          Boolean(historicNotComputed),
        );
      }

      await hooks?.beforeCommuneStatistics?.();

      for (let i = 0; i < communeSize; i += batchSize) {
        this.logger.log(`BATCH ${i}`);
        const communes = await this.communeService.findWithStats(
          batchSize,
          i,
          departementCodes,
        );
        if (communes.length === 0) {
          throw new Error(
            `Lot communal vide a partir de ${i} pour ${communeSize} communes attendues`,
          );
        }

        const restrictions = await this.computeCommuneStatisticBatch(
          queryRunner,
          communes,
          dateString,
          Boolean(historicNotComputed),
          statisticZoneInputs.length > 0,
          zonesById,
        );
        const nextProcessedCommuneCount =
          processedCommuneCount + communes.length;
        await this.persistCommuneStatisticsBatch(
          queryRunner,
          restrictions,
          dateString,
          snapshotScope,
          nextProcessedCommuneCount,
        );
        processedCommuneCount = nextProcessedCommuneCount;
      }

      const finalCommuneSize =
        await this.communeService.count(departementCodes);
      if (processedCommuneCount !== finalCommuneSize) {
        throw new Error(
          `Snapshot communal incomplet: ${processedCommuneCount}/${finalCommuneSize} communes calculees`,
        );
      }
      await hooks?.beforeCertification?.();
      await this.markSnapshotCompleted(
        queryRunner,
        dateString,
        snapshotScope,
        processedCommuneCount,
        nationalSnapshotAlreadyCompleted,
        hooks?.deferCertificationUntilPublication === true,
        hooks?.preserveBootstrapBarrier === true,
        hooks?.sourceRevision,
        hooks?.historicComputeEpoch,
        {
          requireNationalCoverage: hooks?.requireNationalCoverage === true,
          publishCurrentDate: hooks?.publishCurrentDate === true,
          bumpLegacyRevisionOnCompletion:
            hooks?.bumpLegacyRevisionOnCompletion === true,
        },
      );
    } catch (error) {
      if (snapshotStarted) {
        await this.markSnapshotFailed(
          queryRunner,
          dateString,
          snapshotScope,
          processedCommuneCount,
          error,
        );
      }
      throw error;
    } finally {
      if (statisticZoneGeometryPrepared) {
        try {
          await queryRunner.query(
            'DROP TABLE IF EXISTS pg_temp."statistic_zone_geometry"',
          );
        } catch (error) {
          this.logger.error(
            'ERREUR LORS DU NETTOYAGE DES GEOMETRIES STATISTIQUES TEMPORAIRES',
            error,
          );
        }
      }
      if (locked) {
        try {
          await queryRunner.query(
            'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked',
            [STATISTIC_COMMUNE_SNAPSHOT_LOCK],
          );
        } catch (error) {
          this.logger.error(
            'ERREUR LORS DE LA LIBERATION DU VERROU DES STATISTIQUES COMMUNALES',
            error,
          );
        }
      }
      if (connected) {
        try {
          await queryRunner.release();
        } catch (error) {
          this.logger.error(
            'ERREUR LORS DE LA LIBERATION DE LA CONNEXION DES STATISTIQUES COMMUNALES',
            error,
          );
        }
      }
    }
  }

  async stageHistoricCommuneStatisticsRestrictions(
    zones: ZoneAlerteComputed[],
    date: Date,
    options: HistoricCommuneStatisticStagingOptions,
  ): Promise<HistoricCommuneStatisticStagingResult> {
    this.validateHistoricStagingOptions(date, options);
    const batchSize = parseCommuneStatisticsBatchSize(
      process.env.COMMUNE_STATISTICS_BATCH_SIZE,
    );
    const dateString = date.toISOString().slice(0, 10);
    const validThrough = options.validThrough ?? dateString;
    const { zoneInputs, zonesById } = this.prepareStatisticZones(
      zones,
      dateString,
    );
    const foreignZone = zoneInputs.find(
      (zone) => zone.departementCode !== options.departementCode,
    );
    if (foreignZone) {
      throw new Error(
        `Zone ${foreignZone.id} hors du departement ${options.departementCode}`,
      );
    }
    const { statisticZoneInputs, excludedEmptyGeometryIds } =
      this.filterLegacyHistoricEmptyStatisticZoneInputs(
        zoneInputs,
        zonesById,
        options.historicNotComputed === true,
      );
    this.warnExcludedLegacyHistoricStatisticGeometries(
      excludedEmptyGeometryIds,
      dateString,
      options.runId,
    );

    this.logger.log(
      `STAGING HISTORIC COMMUNE STATISTICS - ${options.departementCode} - ${dateString}`,
    );
    const queryRunner = this.dataSource.createQueryRunner();
    let connected = false;
    let statisticZoneGeometryPrepared = false;
    let processedCommuneCount = 0;
    let segmentCount = 0;

    try {
      await queryRunner.connect();
      connected = true;
      const departementCodes = [options.departementCode];
      const communeSize = await this.communeService.count(departementCodes);
      if (communeSize === 0) {
        throw new Error(
          `Aucune commune a calculer pour le departement ${options.departementCode}`,
        );
      }

      if (statisticZoneInputs.length > 0) {
        statisticZoneGeometryPrepared = true;
        await this.prepareStatisticZoneGeometryTable(
          queryRunner,
          statisticZoneInputs,
          true,
          options.historicNotComputed === true,
        );
      }

      for (let offset = 0; offset < communeSize; offset += batchSize) {
        const communes = await this.communeService.findWithStats(
          batchSize,
          offset,
          departementCodes,
        );
        if (communes.length === 0) {
          throw new Error(
            `Lot communal historique vide a partir de ${offset} pour ${communeSize} communes attendues`,
          );
        }
        for (const commune of communes) {
          if (
            commune.departement?.id !== options.departementId ||
            commune.departement?.code !== options.departementCode
          ) {
            throw new Error(
              `Commune ${commune.id} hors du departement historique attendu ${options.departementCode}/${options.departementId}`,
            );
          }
        }

        const restrictions = await this.computeCommuneStatisticBatch(
          queryRunner,
          communes,
          dateString,
          options.historicNotComputed === true,
          statisticZoneInputs.length > 0,
          zonesById,
        );
        const segments = restrictions.map(
          ({ communeId, restriction }): HistoricCommuneStatisticSegment => ({
            runId: options.runId,
            departementId: options.departementId,
            communeId,
            validFrom: restriction.date,
            validThrough,
            SOU: restriction.SOU,
            SUP: restriction.SUP,
            AEP: restriction.AEP,
            sourceGeneration: options.sourceGeneration,
            inputSignature: options.inputSignature,
          }),
        );
        const nextProcessedCommuneCount =
          processedCommuneCount + communes.length;
        await options.sink.writeSegments({
          runId: options.runId,
          departementId: options.departementId,
          departementCode: options.departementCode,
          computedFor: dateString,
          validThrough,
          sourceGeneration: options.sourceGeneration,
          inputSignature: options.inputSignature,
          offset,
          expectedCommuneCount: communeSize,
          processedCommuneCount: nextProcessedCommuneCount,
          segments,
        });
        processedCommuneCount = nextProcessedCommuneCount;
        segmentCount += segments.length;
      }

      const finalCommuneSize =
        await this.communeService.count(departementCodes);
      if (processedCommuneCount !== finalCommuneSize) {
        throw new Error(
          `Staging communal historique incomplet: ${processedCommuneCount}/${finalCommuneSize} communes calculees`,
        );
      }
      return {
        expectedCommuneCount: finalCommuneSize,
        processedCommuneCount,
        segmentCount,
      };
    } finally {
      if (statisticZoneGeometryPrepared) {
        try {
          await queryRunner.query(
            'DROP TABLE IF EXISTS pg_temp."statistic_zone_geometry"',
          );
        } catch (error) {
          this.logger.error(
            'ERREUR LORS DU NETTOYAGE DU STAGING COMMUNAL HISTORIQUE',
            error,
          );
        }
      }
      if (connected) {
        try {
          await queryRunner.release();
        } catch (error) {
          this.logger.error(
            'ERREUR LORS DE LA LIBERATION DU STAGING COMMUNAL HISTORIQUE',
            error,
          );
        }
      }
    }
  }

  reduceHistoricCommuneStatisticShadow(
    input: HistoricCommuneStatisticShadowInput,
  ): HistoricCommuneStatisticShadow {
    return reduceHistoricCommuneStatisticShadow(input);
  }

  async finalizeLegacyCurrentPublication(
    date: Date,
    sourceRevision: string,
    historicComputeEpoch: string,
  ): Promise<void> {
    if (
      Number.isNaN(date.getTime()) ||
      !/^\d+$/.test(sourceRevision) ||
      !/^\d+$/.test(historicComputeEpoch)
    ) {
      throw new Error('Invalid legacy statistic publication context');
    }
    const snapshotDate = date.toISOString().slice(0, 10);
    const queryRunner = this.dataSource.createQueryRunner();
    let transactionStarted = false;
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();
      transactionStarted = true;
      const [result] = await queryRunner.query(
        `
          WITH current_context AS MATERIALIZED (
            SELECT 1
            FROM "zone_publication_source_state" source_state
            CROSS JOIN "config" config
            WHERE source_state."id" = 1
              AND ${sourceRevisionColumn('source_state')} = $2::bigint
              AND config."id" = 1
              AND config."historicComputeEpoch" = $3::bigint
            FOR SHARE OF source_state, config
          ), national_coverage AS MATERIALIZED (
            SELECT
              (SELECT COUNT(*)::integer FROM "departement")
                AS "expectedDepartementCount",
              (
                SELECT COUNT(*)::integer
                FROM "departement" departement
                JOIN "statistic_departement" statistic_departement
                  ON statistic_departement."departementId" = departement."id"
                WHERE (
                  SELECT COUNT(*)
                  FROM jsonb_array_elements(
                    COALESCE(statistic_departement."restrictions", '[]'::jsonb)
                  ) AS restriction(value)
                  WHERE restriction.value ->> 'date' = $1::text
                ) = 1
              ) AS "departementRestrictionCount",
              (
                SELECT COUNT(*)::integer
                FROM "departement" departement
                WHERE COALESCE(
                  (
                    SELECT statistic."departementSituation"::jsonb
                    FROM "statistic" statistic
                    WHERE statistic."date" = $1::date
                  ),
                  '{}'::jsonb
                ) ? departement."code"
              ) AS "departementSituationCount",
              (
                SELECT COUNT(*)::integer
                FROM jsonb_object_keys(
                  COALESCE(
                    (
                      SELECT statistic."departementSituation"::jsonb
                      FROM "statistic" statistic
                      WHERE statistic."date" = $1::date
                    ),
                    '{}'::jsonb
                  )
                ) AS situation_key
              ) AS "departementSituationKeyCount"
          ), publication_context AS MATERIALIZED (
            SELECT
              publication_state."id",
              publication_state."currentPublishedDate"
            FROM "statistic_publication_state" publication_state
            CROSS JOIN current_context
            WHERE publication_state."id" = 1
              AND (
                publication_state."currentPublishedDate" IS NULL
                OR publication_state."currentPublishedDate" <= $1::date
              )
            FOR UPDATE OF publication_state
          ), already_published AS MATERIALIZED (
            SELECT snapshot."snapshotDate"
            FROM "statistic_commune_snapshot" snapshot
            CROSS JOIN current_context
            CROSS JOIN national_coverage coverage
            CROSS JOIN publication_context
            WHERE snapshot."snapshotDate" = $1::date
              AND snapshot."scope" = 'national'
              AND snapshot."status" = 'completed'
              AND snapshot."sourceRevision" = $2::bigint
              AND snapshot."expectedCommuneCount" > 0
              AND snapshot."processedCommuneCount" =
                  snapshot."expectedCommuneCount"
              AND publication_context."currentPublishedDate" = $1::date
              AND coverage."expectedDepartementCount" = 101
              AND coverage."departementRestrictionCount" = 101
              AND coverage."departementSituationCount" = 101
              AND coverage."departementSituationKeyCount" = 101
            FOR SHARE OF snapshot
          ), ready_snapshot AS MATERIALIZED (
            SELECT snapshot."snapshotDate"
            FROM "statistic_commune_snapshot" snapshot
            CROSS JOIN current_context
            WHERE snapshot."snapshotDate" = $1::date
              AND snapshot."scope" = 'national'
              AND snapshot."status" = 'ready'
              AND snapshot."sourceRevision" = $2::bigint
              AND snapshot."expectedCommuneCount" > 0
              AND snapshot."processedCommuneCount" =
                  snapshot."expectedCommuneCount"
            FOR UPDATE OF snapshot
          ), eligible_snapshot AS MATERIALIZED (
            SELECT ready_snapshot."snapshotDate"
            FROM ready_snapshot
            CROSS JOIN national_coverage coverage
            CROSS JOIN publication_context
            WHERE coverage."expectedDepartementCount" = 101
              AND coverage."departementRestrictionCount" = 101
              AND coverage."departementSituationCount" = 101
              AND coverage."departementSituationKeyCount" = 101
          ), completed_snapshot AS (
            UPDATE "statistic_commune_snapshot" snapshot
            SET "status" = 'completed',
                "processedCommuneCount" = snapshot."expectedCommuneCount",
                "completedAt" = now(),
                "lastError" = NULL,
                "updatedAt" = now()
            FROM eligible_snapshot
            WHERE snapshot."snapshotDate" = eligible_snapshot."snapshotDate"
              AND snapshot."scope" = 'national'
              AND snapshot."status" = 'ready'
              AND snapshot."sourceRevision" = $2::bigint
            RETURNING snapshot."snapshotDate"
          ), completed_siblings AS (
            UPDATE "statistic_commune_snapshot" snapshot
            SET "status" = 'completed',
                "processedCommuneCount" = snapshot."expectedCommuneCount",
                "completedAt" = now(),
                "lastError" = NULL,
                "sourceRevision" = $2::bigint,
                "updatedAt" = now()
            FROM completed_snapshot
            WHERE snapshot."snapshotDate" = completed_snapshot."snapshotDate"
              AND snapshot."scope" <> 'national'
              AND snapshot."scope" <> 'bootstrap'
            RETURNING 1
          ), cleared_bootstrap AS (
            DELETE FROM "statistic_commune_snapshot" snapshot
            USING completed_snapshot
            WHERE snapshot."scope" = 'bootstrap'
            RETURNING 1
          ), published_state AS (
            UPDATE "statistic_publication_state" publication_state
            SET "revision" = publication_state."revision" + 1,
                "currentPublishedDate" = $1::date,
                "updatedAt" = now()
            FROM completed_snapshot, publication_context
            WHERE publication_state."id" = publication_context."id"
            RETURNING publication_state."revision"
          )
          SELECT
            EXISTS(SELECT 1 FROM current_context) AS "contextMatches",
            EXISTS(SELECT 1 FROM publication_context)
              AS "publicationContextMatches",
            (SELECT COUNT(*)::integer FROM ready_snapshot) AS "readyCount",
            (SELECT COUNT(*)::integer FROM already_published)
              AS "alreadyPublishedCount",
            (SELECT COUNT(*)::integer FROM completed_snapshot)
              AS "completedCount",
            (SELECT COUNT(*)::integer FROM completed_siblings)
              AS "completedSiblingCount",
            (SELECT COUNT(*)::integer FROM cleared_bootstrap)
              AS "clearedBootstrapCount",
            (SELECT COUNT(*)::integer FROM published_state)
              AS "publishedStateCount",
            coverage."expectedDepartementCount",
            coverage."departementRestrictionCount",
            coverage."departementSituationCount",
            coverage."departementSituationKeyCount"
          FROM national_coverage coverage
        `,
        [snapshotDate, sourceRevision, historicComputeEpoch],
      );
      if (result?.contextMatches !== true) {
        throw new Error(
          `Legacy statistic publication context changed for ${snapshotDate}`,
        );
      }
      if (
        Number(result?.expectedDepartementCount ?? 0) !== 101 ||
        Number(result?.departementRestrictionCount ?? 0) !== 101 ||
        Number(result?.departementSituationCount ?? 0) !== 101 ||
        Number(result?.departementSituationKeyCount ?? 0) !== 101
      ) {
        throw new Error(
          `Couverture statistique departementale incomplete pour ${snapshotDate}: ` +
            `${Number(result?.departementRestrictionCount ?? 0)}/101 restrictions, ` +
            `${Number(result?.departementSituationCount ?? 0)}/101 situations, ` +
            `${Number(result?.departementSituationKeyCount ?? 0)}/101 cles`,
        );
      }
      if (result?.publicationContextMatches !== true) {
        throw new Error(
          `La publication statistique courante ${snapshotDate} ferait regresser la date publiee`,
        );
      }
      const newlyFinalized =
        Number(result?.readyCount ?? 0) === 1 &&
        Number(result?.completedCount ?? 0) === 1 &&
        Number(result?.publishedStateCount ?? 0) === 1 &&
        Number(result?.alreadyPublishedCount ?? 0) === 0;
      const alreadyFinalized =
        Number(result?.readyCount ?? 0) === 0 &&
        Number(result?.completedCount ?? 0) === 0 &&
        Number(result?.publishedStateCount ?? 0) === 0 &&
        Number(result?.alreadyPublishedCount ?? 0) === 1;
      if (!newlyFinalized && !alreadyFinalized) {
        throw new Error(
          `Le snapshot communal ${snapshotDate} n'est pas pret ou finalise pour la publication legacy`,
        );
      }
      await queryRunner.commitTransaction();
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted && queryRunner.isTransactionActive) {
        try {
          await queryRunner.rollbackTransaction();
        } catch (rollbackError) {
          this.logger.error(
            'ERREUR LORS DU ROLLBACK DE LA PUBLICATION STATISTIQUE LEGACY',
            rollbackError,
          );
        }
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async computeEmptyHistoricCommuneStatisticsRange(
    days: EmptyHistoricStatisticDay[],
    options: EmptyHistoricStatisticRangeOptions,
  ): Promise<void> {
    const maxDays = parseHistoricEmptyStatisticsRangeMaxDays();
    const dateStrings = this.validateEmptyHistoricStatisticRange(
      days,
      maxDays,
      options,
    );
    const batchSize = parseCommuneStatisticsBatchSize(
      process.env.COMMUNE_STATISTICS_BATCH_SIZE,
    );
    const queryRunner = this.dataSource.createQueryRunner();
    let connected = false;
    let locked = false;
    let snapshotsStarted = false;
    let processedCommuneCount = 0;

    this.logger.log(
      `COMPUTING EMPTY COMMUNE STATISTICS RANGE - ${dateStrings[0]}..${dateStrings[dateStrings.length - 1]}`,
    );

    try {
      await queryRunner.connect();
      connected = true;
      await this.acquireStatisticCommuneSnapshotLock(queryRunner, false);
      locked = true;

      const communeSize = await this.communeService.count();
      if (communeSize === 0) {
        throw new Error('Aucune commune a calculer pour les snapshots vides');
      }
      await this.markEmptyHistoricSnapshotsRunning(
        queryRunner,
        dateStrings,
        communeSize,
        options,
      );
      snapshotsStarted = true;

      for (const day of days) {
        await this.assertEmptyHistoricRangeContext(queryRunner, options);
        await day.beforeCommuneStatistics?.();
        await this.assertEmptyHistoricRangeContext(queryRunner, options);
      }

      for (let offset = 0; offset < communeSize; offset += batchSize) {
        this.logger.log(`EMPTY RANGE BATCH ${offset}`);
        const communes = await this.communeService.findWithStats(
          batchSize,
          offset,
        );
        if (communes.length === 0) {
          throw new Error(
            `Lot communal vide a partir de ${offset} pour ${communeSize} communes attendues`,
          );
        }
        const nextProcessedCommuneCount =
          processedCommuneCount + communes.length;
        await this.persistEmptyHistoricCommuneStatisticsBatch(
          queryRunner,
          communes.map((commune) => commune.id),
          dateStrings,
          communeSize,
          nextProcessedCommuneCount,
          options,
        );
        processedCommuneCount = nextProcessedCommuneCount;
      }

      const finalCommuneSize = await this.communeService.count();
      if (
        processedCommuneCount !== finalCommuneSize ||
        finalCommuneSize !== communeSize
      ) {
        throw new Error(
          `Snapshots communaux vides incomplets: ${processedCommuneCount}/${finalCommuneSize} communes calculees, ${communeSize} attendues`,
        );
      }

      for (let index = 0; index < days.length; index += 1) {
        await this.assertEmptyHistoricRangeContext(queryRunner, options);
        await days[index].beforeCertification?.();
        await this.assertEmptyHistoricRangeContext(queryRunner, options);
        await this.markEmptyHistoricSnapshotCompleted(
          queryRunner,
          dateStrings[index],
          processedCommuneCount,
          options,
        );
      }
    } catch (error) {
      if (snapshotsStarted) {
        await this.markEmptyHistoricSnapshotsFailed(
          queryRunner,
          dateStrings,
          processedCommuneCount,
          error,
        );
      }
      throw error;
    } finally {
      if (locked) {
        try {
          await queryRunner.query(
            'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked',
            [STATISTIC_COMMUNE_SNAPSHOT_LOCK],
          );
        } catch (error) {
          this.logger.error(
            'ERREUR LORS DE LA LIBERATION DU VERROU DES STATISTIQUES COMMUNALES',
            error,
          );
        }
      }
      if (connected) {
        try {
          await queryRunner.release();
        } catch (error) {
          this.logger.error(
            'ERREUR LORS DE LA LIBERATION DE LA CONNEXION DES STATISTIQUES COMMUNALES',
            error,
          );
        }
      }
    }
  }

  private async acquireStatisticCommuneSnapshotLock(
    queryRunner: QueryRunner,
    waitForLock: boolean,
  ): Promise<void> {
    if (!waitForLock) {
      const [lock] = await queryRunner.query(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [STATISTIC_COMMUNE_SNAPSHOT_LOCK],
      );
      if (lock?.locked !== true) {
        throw new Error(
          'Un calcul des statistiques communales est deja en cours',
        );
      }
      return;
    }

    const timeoutMs = parseCurrentCommuneStatisticsLockWaitTimeoutMs();
    let lockAcquired = false;
    try {
      await queryRunner.startTransaction();
      await queryRunner.query(
        "SELECT set_config('statement_timeout', $1, true)",
        [`${timeoutMs}ms`],
      );
      await queryRunner.query(
        'SELECT pg_advisory_lock(hashtext($1)) AS locked',
        [STATISTIC_COMMUNE_SNAPSHOT_LOCK],
      );
      lockAcquired = true;
      await queryRunner.commitTransaction();
    } catch (error) {
      if (queryRunner.isTransactionActive) {
        try {
          await queryRunner.rollbackTransaction();
        } catch (rollbackError) {
          this.logger.error(
            "ERREUR LORS DE L'ANNULATION DE L'ATTENTE DU VERROU DES STATISTIQUES COMMUNALES",
            rollbackError,
          );
        }
      }
      if (lockAcquired) {
        try {
          await queryRunner.query(
            'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked',
            [STATISTIC_COMMUNE_SNAPSHOT_LOCK],
          );
        } catch (unlockError) {
          this.logger.error(
            "ERREUR LORS DE LA LIBERATION DU VERROU DES STATISTIQUES COMMUNALES APRES ECHEC D'ACQUISITION",
            unlockError,
          );
        }
      }
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '57014'
      ) {
        throw Object.assign(
          new Error(
            `Delai maximal d'attente du calcul courant des statistiques communales atteint (${timeoutMs} ms)`,
          ),
          { cause: error },
        );
      }
      throw error;
    }
  }

  private validateEmptyHistoricStatisticRange(
    days: EmptyHistoricStatisticDay[],
    maxDays: number,
    options: EmptyHistoricStatisticRangeOptions,
  ): string[] {
    if (days.length === 0 || days.length > maxDays) {
      throw new Error(
        `Invalid empty historic statistic range length: ${days.length}/${maxDays}`,
      );
    }
    if (
      !/^\d+$/.test(options.sourceRevision) ||
      !/^\d+$/.test(options.historicComputeEpoch)
    ) {
      throw new Error('Invalid empty historic statistic range context');
    }
    const dateStrings = days.map((day) => {
      if (!(day.date instanceof Date) || Number.isNaN(day.date.getTime())) {
        throw new Error('Invalid empty historic statistic date');
      }
      return day.date.toISOString().slice(0, 10);
    });
    for (let index = 1; index < dateStrings.length; index += 1) {
      const expected = moment
        .utc(dateStrings[index - 1], 'YYYY-MM-DD', true)
        .add(1, 'day')
        .format('YYYY-MM-DD');
      if (dateStrings[index] !== expected) {
        throw new Error(
          `Empty historic statistic range is not contiguous: ${dateStrings[index - 1]} -> ${dateStrings[index]}`,
        );
      }
    }
    return dateStrings;
  }

  private validateHistoricStagingOptions(
    date: Date,
    options: HistoricCommuneStatisticStagingOptions,
  ): void {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      throw new Error('Invalid historic statistic staging date');
    }
    if (!options || !HISTORIC_RUN_ID_PATTERN.test(options.runId)) {
      throw new Error('Invalid historic statistic staging run id');
    }
    if (
      !Number.isInteger(options.departementId) ||
      options.departementId <= 0 ||
      typeof options.departementCode !== 'string' ||
      options.departementCode.trim() !== options.departementCode ||
      options.departementCode.length === 0
    ) {
      throw new Error('Invalid historic statistic staging department');
    }
    if (!/^\d+$/.test(options.sourceGeneration)) {
      throw new Error('Invalid historic statistic staging source generation');
    }
    if (!SHA_256_PATTERN.test(options.inputSignature)) {
      throw new Error('Invalid historic statistic staging input signature');
    }
    const validFrom = date.toISOString().slice(0, 10);
    if (
      options.validThrough !== undefined &&
      (!isStrictDate(options.validThrough, 'YYYY-MM-DD') ||
        options.validThrough < validFrom)
    ) {
      throw new Error(
        `Invalid historic statistic staging interval: ${validFrom}/${options.validThrough}`,
      );
    }
    if (typeof options.sink?.writeSegments !== 'function') {
      throw new Error('Invalid historic statistic staging sink');
    }
  }

  private async computeCommuneStatisticBatch(
    queryRunner: QueryRunner,
    communes: ReadonlyArray<{ id: number }>,
    dateString: string,
    historicNotComputed: boolean,
    hasZones: boolean,
    zonesById: Map<number, ZoneAlerteComputed>,
  ): Promise<
    Array<{
      communeId: number;
      restriction: CommuneStatisticRestriction;
    }>
  > {
    const intersections = await this.findCommuneZoneIntersections(
      queryRunner,
      communes.map((commune) => commune.id),
      historicNotComputed,
      hasZones,
    );

    const zoneIdsByCommune = new Map<number, Set<number>>();
    for (const intersection of intersections) {
      const communeId = Number(intersection.communeId);
      if (intersection.zoneId === null) {
        throw new Error(
          `Geometrie communale invalide pour la commune ${communeId} le ${dateString}`,
        );
      }
      const zoneId = Number(intersection.zoneId);
      if (!Number.isInteger(communeId) || !Number.isInteger(zoneId)) {
        throw new Error(
          `Intersection communale invalide pour le ${dateString}`,
        );
      }
      const zoneIds = zoneIdsByCommune.get(communeId) ?? new Set<number>();
      zoneIds.add(zoneId);
      zoneIdsByCommune.set(communeId, zoneIds);
    }

    return communes.map((commune) => ({
      communeId: commune.id,
      restriction: this.buildCommuneStatisticRestriction(
        dateString,
        zoneIdsByCommune.get(commune.id) ?? new Set<number>(),
        zonesById,
      ),
    }));
  }

  private prepareStatisticZones(
    zones: ZoneAlerteComputed[],
    dateString: string,
  ): {
    zoneInputs: StatisticZoneInput[];
    zonesById: Map<number, ZoneAlerteComputed>;
  } {
    const zonesById = new Map<number, ZoneAlerteComputed>();
    const zoneInputs: StatisticZoneInput[] = [];
    for (const zone of zones) {
      if (!Number.isInteger(zone.id)) {
        throw new Error(`Zone sans identifiant pour le ${dateString}`);
      }
      if (!zone.departement?.code) {
        throw new Error(
          `Zone ${zone.id} sans departement pour le ${dateString}`,
        );
      }
      if (zonesById.has(zone.id)) {
        continue;
      }
      zonesById.set(zone.id, zone);
      zoneInputs.push({
        id: zone.id,
        departementCode: zone.departement.code,
      });
    }
    return { zoneInputs, zonesById };
  }

  private filterLegacyHistoricEmptyStatisticZoneInputs(
    zoneInputs: StatisticZoneInput[],
    zonesById: ReadonlyMap<number, ZoneAlerteComputed>,
    legacyHistoric: boolean,
  ): {
    statisticZoneInputs: StatisticZoneInput[];
    excludedEmptyGeometryIds: number[];
  } {
    if (!legacyHistoric) {
      return { statisticZoneInputs: zoneInputs, excludedEmptyGeometryIds: [] };
    }

    const excludedEmptyGeometryIds = zoneInputs
      .filter((zoneInput) => {
        const zone = zonesById.get(zoneInput.id);
        return (
          LEGACY_HISTORIC_EMPTY_GEOMETRY_ZONE_IDS.includes(zoneInput.id) &&
          isExactEmptyMultiPolygonGeometry(zone?.geom)
        );
      })
      .map((zoneInput) => zoneInput.id);
    const excludedIds = new Set(excludedEmptyGeometryIds);
    return {
      statisticZoneInputs: zoneInputs.filter(
        (zoneInput) => !excludedIds.has(zoneInput.id),
      ),
      excludedEmptyGeometryIds,
    };
  }

  private warnExcludedLegacyHistoricStatisticGeometries(
    zoneIds: readonly number[],
    computedFor: string,
    runId?: string,
  ): void {
    if (zoneIds.length === 0) {
      return;
    }
    this.logger.warn(
      JSON.stringify({
        type: 'legacy_historic_statistic_empty_geometries_excluded',
        ...(runId === undefined ? {} : { runId }),
        computedFor,
        zoneIds,
      }),
    );
  }

  private async findCommuneZoneIntersections(
    queryRunner: QueryRunner,
    communeIds: number[],
    historicNotComputed: boolean,
    hasZones: boolean,
  ): Promise<CommuneZoneIntersection[]> {
    if (!hasZones || communeIds.length === 0) {
      return [];
    }

    const rawCommuneGeometry = historicNotComputed
      ? 'ST_TRANSFORM(commune.geom, 4326)'
      : 'commune.geom';
    const validGeometry = (geometry: string) => `
      CASE
        WHEN ST_IsValid(${geometry}, 0) THEN ${geometry}
        ELSE ST_CollectionExtract(
          ST_MakeValid(${geometry}, 'method=structure keepcollapsed=false'),
          3
        )
      END`;

    return queryRunner.query(
      `
        WITH raw_communes AS MATERIALIZED (
          SELECT
            commune.id,
            departement.code AS "departementCode",
            ${rawCommuneGeometry} AS geom
          FROM commune
          JOIN departement ON departement.id = commune."departementId"
          WHERE commune.id = ANY($1::integer[])
        ), normalized_communes AS MATERIALIZED (
          SELECT
            raw_communes.id,
            raw_communes."departementCode",
            ${validGeometry('raw_communes.geom')} AS geom
          FROM raw_communes
        ), valid_communes AS MATERIALIZED (
          SELECT *
          FROM normalized_communes
          WHERE geom IS NOT NULL
            AND NOT ST_IsEmpty(geom)
            AND ST_GeometryType(geom) IN ('ST_Polygon', 'ST_MultiPolygon')
            AND ST_IsValid(geom, 0)
        )
        SELECT
          valid_communes.id AS "communeId",
          valid_zones.id AS "zoneId"
        FROM valid_communes
        JOIN pg_temp."statistic_zone_geometry" valid_zones
          ON valid_zones."departementCode" = valid_communes."departementCode"
         AND ST_Intersects(valid_zones.geom, valid_communes.geom)
        WHERE
          ST_Area(ST_Intersection(valid_zones.geom, valid_communes.geom))
          / NULLIF(ST_Area(valid_communes.geom), 0) > 0.01
        UNION ALL
        SELECT
          normalized_communes.id AS "communeId",
          NULL::integer AS "zoneId"
        FROM normalized_communes
        WHERE normalized_communes.geom IS NULL
          OR ST_IsEmpty(normalized_communes.geom)
          OR ST_GeometryType(normalized_communes.geom)
            NOT IN ('ST_Polygon', 'ST_MultiPolygon')
          OR NOT ST_IsValid(normalized_communes.geom, 0)
      `,
      [communeIds],
    );
  }

  private async prepareStatisticZoneGeometryTable(
    queryRunner: QueryRunner,
    zones: StatisticZoneInput[],
    historic: boolean,
    historicNotComputed: boolean,
  ): Promise<void> {
    const table = historicNotComputed
      ? 'zone_alerte'
      : historic
        ? 'zone_alerte_computed_historic'
        : 'zone_alerte_computed';
    const rawGeometry = historicNotComputed
      ? 'ST_Transform(source_zone.geom, 4326)'
      : 'source_zone.geom';

    await queryRunner.query(
      'DROP TABLE IF EXISTS pg_temp."statistic_zone_geometry"',
    );
    await queryRunner.query(
      `
        CREATE TEMP TABLE "statistic_zone_geometry"
        ON COMMIT PRESERVE ROWS AS
        WITH zone_input AS (
          SELECT *
          FROM jsonb_to_recordset($1::jsonb)
            AS input(id integer, "departementCode" text)
        ), transformed AS MATERIALIZED (
          SELECT
            zone_input.id,
            zone_input."departementCode",
            ${rawGeometry} AS geom
          FROM zone_input
          LEFT JOIN "${table}" source_zone ON source_zone.id = zone_input.id
        )
        SELECT
          transformed.id,
          transformed."departementCode",
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
      `,
      [JSON.stringify(zones)],
    );
    const [validation] = await queryRunner.query(
      `
        SELECT
          COUNT(*)::integer AS "loadedCount",
          COALESCE(
            array_agg(id ORDER BY id) FILTER (
              WHERE geom IS NULL
                OR ST_IsEmpty(geom)
                OR ST_GeometryType(geom) NOT IN ('ST_Polygon', 'ST_MultiPolygon')
                OR NOT ST_IsValid(geom, 0)
            ),
            ARRAY[]::integer[]
          ) AS "invalidIds"
        FROM pg_temp."statistic_zone_geometry"
      `,
    );
    const invalidIds = (validation?.invalidIds ?? []).map(Number);
    if (
      Number(validation?.loadedCount ?? 0) !== zones.length ||
      invalidIds.length > 0
    ) {
      throw new Error(
        `Geometries de zones statistiques invalides: ${invalidIds.join(',') || 'nombre de zones incoherent'}`,
      );
    }
  }

  private buildCommuneStatisticRestriction(
    dateString: string,
    zoneIds: Set<number>,
    zonesById: Map<number, ZoneAlerteComputed>,
  ): CommuneStatisticRestriction {
    const restriction: CommuneStatisticRestriction = {
      date: dateString,
      SOU: null,
      SUP: null,
      AEP: null,
    };
    const intersectedZones = [...zoneIds]
      .map((zoneId) => zonesById.get(zoneId))
      .filter((zone): zone is ZoneAlerteComputed => Boolean(zone));

    for (const zoneType of STATISTIC_ZONE_TYPES) {
      for (const severity of STATISTIC_SEVERITIES) {
        if (
          intersectedZones.some(
            (zone) =>
              zone.type === zoneType &&
              zone.restriction?.niveauGravite === severity,
          )
        ) {
          restriction[zoneType] = severity;
        }
      }
    }
    return restriction;
  }

  private async persistCommuneStatisticsBatch(
    queryRunner: QueryRunner,
    restrictions: Array<{
      communeId: number;
      restriction: CommuneStatisticRestriction;
    }>,
    dateString: string,
    snapshotScope: string,
    processedCommuneCount: number,
  ): Promise<void> {
    let transactionStarted = false;
    try {
      await queryRunner.startTransaction();
      transactionStarted = true;
      const payload = JSON.stringify(restrictions);
      await queryRunner.query(
        `
          INSERT INTO "statistic_commune" ("communeId", "restrictions")
          SELECT input."communeId", '[]'::jsonb
          FROM jsonb_to_recordset($1::jsonb)
            AS input("communeId" integer, restriction jsonb)
          ON CONFLICT ("communeId") DO NOTHING
        `,
        [payload],
      );
      const [updateResult] = await queryRunner.query(
        `
          WITH input AS MATERIALIZED (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb)
              AS value("communeId" integer, restriction jsonb)
          ), matched AS MATERIALIZED (
            SELECT
              statistic.id,
              statistic."restrictions",
              input.restriction,
              existing."dateCount",
              existing."identicalCount",
              existing."firstDateOrdinality"
            FROM input
            JOIN "statistic_commune" statistic
              ON statistic."communeId" = input."communeId"
            CROSS JOIN LATERAL (
              SELECT
                COUNT(*) FILTER (
                  WHERE item.value ->> 'date' = $2
                )::integer AS "dateCount",
                COUNT(*) FILTER (
                  WHERE item.value ->> 'date' = $2
                    AND item.value = input.restriction
                )::integer AS "identicalCount",
                MIN(item.ordinality) FILTER (
                  WHERE item.value ->> 'date' = $2
                ) AS "firstDateOrdinality"
              FROM jsonb_array_elements(
                COALESCE(statistic."restrictions", '[]'::jsonb)
              ) WITH ORDINALITY AS item(value, ordinality)
            ) existing
          ), candidate AS MATERIALIZED (
            SELECT
              matched.id,
              normalized."nextRestrictions"
            FROM matched
            CROSS JOIN LATERAL (
              SELECT COALESCE(
                jsonb_agg(
                  item.value
                  ORDER BY
                    CASE
                      WHEN item.value ->> 'date'
                        ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN 0
                      ELSE 1
                    END,
                    CASE
                      WHEN item.value ->> 'date'
                        ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                        THEN item.value ->> 'date'
                      ELSE NULL
                    END,
                    item.phase,
                    item.ordinality
                ),
                '[]'::jsonb
              ) AS "nextRestrictions"
              FROM (
                SELECT
                  CASE
                    WHEN existing.ordinality = matched."firstDateOrdinality"
                      THEN matched.restriction
                    ELSE existing.value
                  END AS value,
                  0 AS phase,
                  existing.ordinality
                FROM jsonb_array_elements(
                  COALESCE(matched."restrictions", '[]'::jsonb)
                ) WITH ORDINALITY AS existing(value, ordinality)
                WHERE existing.value ->> 'date' IS DISTINCT FROM $2
                  OR existing.ordinality = matched."firstDateOrdinality"
                UNION ALL
                SELECT
                  matched.restriction,
                  1 AS phase,
                  1::bigint AS ordinality
                WHERE matched."dateCount" = 0
              ) item
            ) normalized
            WHERE NOT (
              matched."dateCount" = 1
              AND matched."identicalCount" = 1
            )
          ), updated AS (
            UPDATE "statistic_commune" statistic
            SET "restrictions" = candidate."nextRestrictions"
            FROM candidate
            WHERE statistic.id = candidate.id
            RETURNING statistic.id
          )
          SELECT
            (SELECT COUNT(*)::integer FROM matched) AS matched,
            (SELECT COUNT(*)::integer FROM updated) AS updated,
            (
              SELECT COUNT(*)::integer
              FROM matched
              WHERE matched."dateCount" = 1
                AND matched."identicalCount" = 1
            ) AS unchanged
        `,
        [payload, dateString],
      );
      const matchedCount = Number(updateResult?.matched ?? 0);
      if (matchedCount !== restrictions.length) {
        throw new Error(
          `Lot communal incomplet: ${matchedCount}/${restrictions.length} statistiques trouvees`,
        );
      }
      const updatedCount = Number(updateResult?.updated ?? 0);
      const unchangedCount = Number(updateResult?.unchanged ?? 0);
      if (updatedCount + unchangedCount !== restrictions.length) {
        throw new Error(
          `Lot communal incomplet: ${updatedCount} mises a jour + ${unchangedCount} inchangees / ${restrictions.length} statistiques attendues`,
        );
      }
      await this.markSnapshotProgress(
        queryRunner,
        dateString,
        snapshotScope,
        processedCommuneCount,
      );
      await queryRunner.commitTransaction();
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        try {
          await queryRunner.rollbackTransaction();
        } catch (rollbackError) {
          this.logger.error(
            "ERREUR LORS DE L'ANNULATION DU LOT DE STATISTIQUES COMMUNALES",
            rollbackError,
          );
        }
      }
      throw error;
    }
  }

  private async markEmptyHistoricSnapshotsRunning(
    queryRunner: QueryRunner,
    dateStrings: string[],
    expectedCommuneCount: number,
    options: EmptyHistoricStatisticRangeOptions,
  ): Promise<void> {
    const [result] = await queryRunner.query(
      `
        WITH current_context AS MATERIALIZED (
          SELECT 1
          FROM "config" config
          CROSS JOIN "zone_publication_source_state" source_state
          WHERE config."id" = 1
            AND config."historicComputeEpoch" = $4::bigint
            AND source_state."id" = 1
            AND ${sourceRevisionColumn('source_state')} = $3::bigint
        ), target_dates AS MATERIALIZED (
          SELECT unnest($1::date[]) AS "snapshotDate"
        ), started AS (
          INSERT INTO "statistic_commune_snapshot" (
            "snapshotDate", "scope", "status", "expectedCommuneCount",
            "processedCommuneCount", "startedAt", "completedAt", "lastError",
            "sourceRevision", "createdAt", "updatedAt"
          )
          SELECT
            target_dates."snapshotDate", 'national', 'running', $2, 0,
            now(), NULL, NULL, $3::bigint, now(), now()
          FROM target_dates
          CROSS JOIN current_context
          ON CONFLICT ("snapshotDate", "scope") DO UPDATE SET
            "status" = 'running',
            "expectedCommuneCount" = EXCLUDED."expectedCommuneCount",
            "processedCommuneCount" = 0,
            "startedAt" = now(),
            "completedAt" = NULL,
            "lastError" = NULL,
            "sourceRevision" = EXCLUDED."sourceRevision",
            "updatedAt" = now()
          RETURNING 1
        )
        SELECT
          EXISTS(SELECT 1 FROM current_context) AS "contextMatches",
          (SELECT COUNT(*)::integer FROM started) AS affected
      `,
      [
        dateStrings,
        expectedCommuneCount,
        options.sourceRevision,
        options.historicComputeEpoch,
      ],
    );
    if (
      result?.contextMatches !== true ||
      Number(result?.affected ?? 0) !== dateStrings.length
    ) {
      throw new Error(
        `Unable to start empty historic statistic range ${dateStrings[0]}..${dateStrings[dateStrings.length - 1]} in the expected context`,
      );
    }
  }

  private async assertEmptyHistoricRangeContext(
    queryRunner: QueryRunner,
    options: EmptyHistoricStatisticRangeOptions,
  ): Promise<void> {
    const rows = await queryRunner.query(
      `
        SELECT 1
        FROM "config" config
        CROSS JOIN "zone_publication_source_state" source_state
        WHERE config."id" = 1
          AND config."historicComputeEpoch" = $1::bigint
          AND source_state."id" = 1
          AND ${sourceRevisionColumn('source_state')} = $2::bigint
        FOR SHARE OF config, source_state
      `,
      [options.historicComputeEpoch, options.sourceRevision],
    );
    if (rows.length !== 1) {
      throw new Error(
        `Empty historic statistic range context changed (epoch=${options.historicComputeEpoch}, sourceRevision=${options.sourceRevision})`,
      );
    }
  }

  private async persistEmptyHistoricCommuneStatisticsBatch(
    queryRunner: QueryRunner,
    communeIds: number[],
    dateStrings: string[],
    expectedCommuneCount: number,
    processedCommuneCount: number,
    options: EmptyHistoricStatisticRangeOptions,
  ): Promise<void> {
    let transactionStarted = false;
    try {
      await queryRunner.startTransaction();
      transactionStarted = true;
      await this.assertEmptyHistoricRangeContext(queryRunner, options);
      const communePayload = JSON.stringify(
        communeIds.map((communeId) => ({ communeId })),
      );
      const datePayload = JSON.stringify(
        dateStrings.map((date) => ({
          date,
          restriction: { date, SOU: null, SUP: null, AEP: null },
        })),
      );
      await queryRunner.query(
        `
          INSERT INTO "statistic_commune" ("communeId", "restrictions")
          SELECT input."communeId", '[]'::jsonb
          FROM jsonb_to_recordset($1::jsonb)
            AS input("communeId" integer)
          ON CONFLICT ("communeId") DO NOTHING
        `,
        [communePayload],
      );
      const [updateResult] = await queryRunner.query(
        `
          WITH input AS MATERIALIZED (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb)
              AS value("communeId" integer)
          ), target_dates AS MATERIALIZED (
            SELECT
              target.value ->> 'date' AS "date",
              target.value -> 'restriction' AS restriction,
              target.ordinality
            FROM jsonb_array_elements($2::jsonb)
              WITH ORDINALITY AS target(value, ordinality)
          ), matched AS MATERIALIZED (
            SELECT DISTINCT statistic.id
            FROM input
            JOIN "statistic_commune" statistic
              ON statistic."communeId" = input."communeId"
          ), candidate AS NOT MATERIALIZED (
            SELECT
              matched.id,
              statistic."restrictions" AS "currentRestrictions",
              normalized."nextRestrictions"
            FROM matched
            JOIN "statistic_commune" statistic
              ON statistic.id = matched.id
            CROSS JOIN LATERAL (
              SELECT COALESCE(
                jsonb_agg(
                  item.value
                  ORDER BY
                    item."sortClass",
                    item."sortDate",
                    item.phase,
                    item.ordinality
                ),
                '[]'::jsonb
              ) AS "nextRestrictions"
              FROM (
                SELECT
                  existing.value,
                  CASE
                    WHEN existing.value ->> 'date'
                      ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN 0
                    ELSE 1
                  END AS "sortClass",
                  CASE
                    WHEN existing.value ->> 'date'
                      ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                      THEN existing.value ->> 'date'
                    ELSE NULL
                  END AS "sortDate",
                  0 AS phase,
                  existing.ordinality
                FROM jsonb_array_elements(
                  COALESCE(statistic."restrictions", '[]'::jsonb)
                ) WITH ORDINALITY AS existing(value, ordinality)
                LEFT JOIN target_dates
                  ON target_dates."date" = existing.value ->> 'date'
                WHERE target_dates."date" IS NULL
                UNION ALL
                SELECT
                  target_dates.restriction,
                  0 AS "sortClass",
                  target_dates."date" AS "sortDate",
                  1 AS phase,
                  target_dates.ordinality
                FROM target_dates
              ) item
            ) normalized
          ), updated AS (
            UPDATE "statistic_commune" statistic
            SET "restrictions" = candidate."nextRestrictions"
            FROM candidate
            WHERE statistic.id = candidate.id
              AND candidate."nextRestrictions"
                  IS DISTINCT FROM candidate."currentRestrictions"
            RETURNING statistic.id
          )
          SELECT
            (SELECT COUNT(*)::integer FROM matched) AS matched,
            (SELECT COUNT(*)::integer FROM updated) AS updated,
            (
              (SELECT COUNT(*) FROM matched) -
              (SELECT COUNT(*) FROM updated)
            )::integer AS unchanged
        `,
        [communePayload, datePayload],
      );
      const matchedCount = Number(updateResult?.matched ?? 0);
      const updatedCount = Number(updateResult?.updated ?? 0);
      const unchangedCount = Number(updateResult?.unchanged ?? 0);
      if (matchedCount !== communeIds.length) {
        throw new Error(
          `Lot communal vide incomplet: ${matchedCount}/${communeIds.length} statistiques trouvees`,
        );
      }
      if (updatedCount + unchangedCount !== communeIds.length) {
        throw new Error(
          `Lot communal vide incomplet: ${updatedCount} mises a jour + ${unchangedCount} inchangees / ${communeIds.length} statistiques attendues`,
        );
      }
      await this.markEmptyHistoricSnapshotsProgress(
        queryRunner,
        dateStrings,
        expectedCommuneCount,
        processedCommuneCount,
      );
      await queryRunner.commitTransaction();
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        try {
          await queryRunner.rollbackTransaction();
        } catch (rollbackError) {
          this.logger.error(
            "ERREUR LORS DE L'ANNULATION DU LOT VIDE DE STATISTIQUES COMMUNALES",
            rollbackError,
          );
        }
      }
      throw error;
    }
  }

  private async markEmptyHistoricSnapshotsProgress(
    queryRunner: QueryRunner,
    dateStrings: string[],
    expectedCommuneCount: number,
    processedCommuneCount: number,
  ): Promise<void> {
    const [result] = await queryRunner.query(
      `
        WITH progressed AS (
          UPDATE "statistic_commune_snapshot"
          SET "processedCommuneCount" = $3, "updatedAt" = now()
          WHERE "snapshotDate" = ANY($1::date[])
            AND "scope" = 'national'
            AND "status" = 'running'
            AND "expectedCommuneCount" = $2
          RETURNING 1
        )
        SELECT COUNT(*)::integer AS affected FROM progressed
      `,
      [dateStrings, expectedCommuneCount, processedCommuneCount],
    );
    if (Number(result?.affected ?? 0) !== dateStrings.length) {
      throw new Error(
        `La progression de la plage de snapshots communaux ${dateStrings[0]}..${dateStrings[dateStrings.length - 1]} n'a pas ete enregistree`,
      );
    }
  }

  private async markEmptyHistoricSnapshotCompleted(
    queryRunner: QueryRunner,
    dateString: string,
    processedCommuneCount: number,
    options: EmptyHistoricStatisticRangeOptions,
  ): Promise<void> {
    let transactionStarted = false;
    try {
      await queryRunner.startTransaction();
      transactionStarted = true;
      await this.assertEmptyHistoricRangeContext(queryRunner, options);
      await this.markSnapshotCompleted(
        queryRunner,
        dateString,
        'national',
        processedCommuneCount,
        false,
        false,
        false,
        options.sourceRevision,
        options.historicComputeEpoch,
        { requireNationalCoverage: true },
      );
      await queryRunner.commitTransaction();
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        try {
          await queryRunner.rollbackTransaction();
        } catch (rollbackError) {
          this.logger.error(
            "ERREUR LORS DE L'ANNULATION DE LA CERTIFICATION DU SNAPSHOT COMMUNAL VIDE",
            rollbackError,
          );
        }
      }
      throw error;
    }
  }

  private async markEmptyHistoricSnapshotsFailed(
    queryRunner: QueryRunner,
    dateStrings: string[],
    processedCommuneCount: number,
    error: unknown,
  ): Promise<void> {
    const query = `
      UPDATE "statistic_commune_snapshot"
      SET "status" = 'failed',
          "processedCommuneCount" = $2,
          "completedAt" = NULL,
          "lastError" = $3,
          "updatedAt" = now()
      WHERE "snapshotDate" = ANY($1::date[])
        AND "scope" = 'national'
        AND "status" = 'running'
    `;
    const parameters = [
      dateStrings,
      processedCommuneCount,
      error instanceof Error ? error.message : String(error),
    ];
    try {
      await queryRunner.query(query, parameters);
    } catch (snapshotError) {
      this.logger.error(
        "ERREUR LORS DE L'ENREGISTREMENT DE L'ECHEC DE LA PLAGE DE SNAPSHOTS COMMUNAUX",
        snapshotError,
      );
      try {
        await this.dataSource.query(query, parameters);
      } catch (fallbackError) {
        this.logger.error(
          "ERREUR LORS DE L'ENREGISTREMENT DE SECOURS DE LA PLAGE DE SNAPSHOTS COMMUNAUX",
          fallbackError,
        );
      }
    }
  }

  private async assertNoIncompleteSnapshots(
    startDate?: string,
    endDate?: string,
    queryable: Pick<DataSource, 'query'> = this.dataSource,
  ): Promise<void> {
    const parameters: string[] = [];
    const dateFilter =
      startDate && endDate
        ? `AND (
            "scope" = 'bootstrap'
            OR ("snapshotDate" >= $1::date AND "snapshotDate" < $2::date)
          )`
        : '';
    if (startDate && endDate) {
      parameters.push(startDate, endDate);
    }
    const [snapshot] = await queryable.query(
      `
        SELECT "snapshotDate", "scope", "status", "processedCommuneCount", "expectedCommuneCount"
        FROM "statistic_commune_snapshot"
        WHERE "status" <> 'completed'
        ${dateFilter}
        ORDER BY "snapshotDate" ASC
        LIMIT 1
      `,
      parameters,
    );
    if (snapshot) {
      const snapshotDate =
        snapshot.snapshotDate instanceof Date
          ? snapshot.snapshotDate.toISOString().slice(0, 10)
          : String(snapshot.snapshotDate).slice(0, 10);
      throw new Error(
        `Snapshot communal ${snapshotDate} non publie (${snapshot.scope}, ${snapshot.status}, ${Number(snapshot.processedCommuneCount)}/${Number(snapshot.expectedCommuneCount)})`,
      );
    }
  }

  private getSnapshotScope(departementCodes?: string[]): string {
    if (!departementCodes?.length) {
      return 'national';
    }
    return `departements:${[...new Set(departementCodes)].sort().join(',')}`;
  }

  private async hasCompletedNationalSnapshot(
    queryRunner: QueryRunner,
    snapshotDate: string,
  ): Promise<boolean> {
    const [snapshot] = await queryRunner.query(
      `
        SELECT 1
        FROM "statistic_commune_snapshot"
        WHERE "snapshotDate" = $1
          AND "scope" = 'national'
          AND "status" = 'completed'
      `,
      [snapshotDate],
    );
    return Boolean(snapshot);
  }

  private async markSnapshotRunning(
    queryRunner: QueryRunner,
    snapshotDate: string,
    snapshotScope: string,
    expectedCommuneCount: number,
    sourceRevision?: string,
  ): Promise<void> {
    await queryRunner.query(
      `
        INSERT INTO "statistic_commune_snapshot" (
          "snapshotDate", "scope", "status", "expectedCommuneCount",
          "processedCommuneCount", "startedAt", "completedAt", "lastError",
          "sourceRevision", "createdAt", "updatedAt"
        ) VALUES (
          $1, $2, 'running', $3, 0, now(), NULL, NULL, $4, now(), now()
        )
        ON CONFLICT ("snapshotDate", "scope") DO UPDATE SET
          "status" = 'running',
          "expectedCommuneCount" = EXCLUDED."expectedCommuneCount",
          "processedCommuneCount" = 0,
          "startedAt" = now(),
          "completedAt" = NULL,
          "lastError" = NULL,
          "sourceRevision" = EXCLUDED."sourceRevision",
          "updatedAt" = now()
      `,
      [
        snapshotDate,
        snapshotScope,
        expectedCommuneCount,
        sourceRevision ?? null,
      ],
    );
  }

  private async markSnapshotProgress(
    queryRunner: QueryRunner,
    snapshotDate: string,
    snapshotScope: string,
    processedCommuneCount: number,
  ): Promise<void> {
    const [result] = await queryRunner.query(
      `
        WITH progressed_snapshot AS (
          UPDATE "statistic_commune_snapshot"
          SET "processedCommuneCount" = $3, "updatedAt" = now()
          WHERE "snapshotDate" = $1
            AND "scope" = $2
            AND "status" = 'running'
          RETURNING 1
        )
        SELECT COUNT(*)::integer AS affected FROM progressed_snapshot
      `,
      [snapshotDate, snapshotScope, processedCommuneCount],
    );
    if (Number(result?.affected ?? 0) !== 1) {
      throw new Error(
        `La progression du snapshot communal ${snapshotDate} n'a pas ete enregistree`,
      );
    }
  }

  private async markSnapshotCompleted(
    queryRunner: QueryRunner,
    snapshotDate: string,
    snapshotScope: string,
    processedCommuneCount: number,
    nationalSnapshotAlreadyCompleted: boolean,
    deferCertificationUntilPublication: boolean,
    preserveBootstrapBarrier: boolean,
    sourceRevision?: string,
    historicComputeEpoch?: string,
    certificationOptions: StatisticSnapshotCertificationOptions = {},
  ): Promise<void> {
    if (deferCertificationUntilPublication && snapshotScope !== 'national') {
      throw new Error(
        'Seul un snapshot national peut attendre une publication cartographique',
      );
    }
    const completedStatus = deferCertificationUntilPublication
      ? 'ready'
      : snapshotScope === 'national' || nationalSnapshotAlreadyCompleted
        ? 'completed'
        : 'partial';
    if (
      (sourceRevision !== undefined && !/^\d+$/.test(sourceRevision)) ||
      (historicComputeEpoch !== undefined &&
        (!/^\d+$/.test(historicComputeEpoch) || sourceRevision === undefined))
    ) {
      throw new Error('Invalid statistic snapshot certification context');
    }
    const guardedCertification = sourceRevision !== undefined;
    const requireNationalCoverage =
      certificationOptions.requireNationalCoverage === true;
    const publishCurrentDate = certificationOptions.publishCurrentDate === true;
    const bumpLegacyRevisionOnCompletion =
      certificationOptions.bumpLegacyRevisionOnCompletion === true;
    if (
      (requireNationalCoverage ||
        publishCurrentDate ||
        bumpLegacyRevisionOnCompletion) &&
      snapshotScope !== 'national'
    ) {
      throw new Error(
        'Seul un snapshot national peut etre certifie avec une couverture nationale',
      );
    }
    if (publishCurrentDate && bumpLegacyRevisionOnCompletion) {
      throw new Error(
        'La publication courante et le signal de reparation legacy sont mutuellement exclusifs',
      );
    }
    if (
      (requireNationalCoverage ||
        publishCurrentDate ||
        bumpLegacyRevisionOnCompletion) &&
      (!guardedCertification || historicComputeEpoch === undefined)
    ) {
      throw new Error(
        'La certification nationale exige une revision source et un epoch historique',
      );
    }

    const coverageCte = requireNationalCoverage
      ? `,
        national_coverage AS MATERIALIZED (
          SELECT
            (SELECT COUNT(*)::integer FROM "departement")
              AS "expectedDepartementCount",
            (
              SELECT COUNT(*)::integer
              FROM "departement" departement
              JOIN "statistic_departement" statistic_departement
                ON statistic_departement."departementId" = departement."id"
              WHERE (
                SELECT COUNT(*)
                FROM jsonb_array_elements(
                  COALESCE(
                    statistic_departement."restrictions",
                    '[]'::jsonb
                  )
                ) AS restriction(value)
                WHERE restriction.value ->> 'date' = $1::text
              ) = 1
            ) AS "departementRestrictionCount",
            (
              SELECT COUNT(*)::integer
              FROM "departement" departement
              WHERE COALESCE(
                (
                  SELECT statistic."departementSituation"::jsonb
                  FROM "statistic" statistic
                  WHERE statistic."date" = $1::date
                ),
                '{}'::jsonb
              ) ? departement."code"
            ) AS "departementSituationCount",
            (
              SELECT COUNT(*)::integer
              FROM jsonb_object_keys(
                COALESCE(
                  (
                    SELECT statistic."departementSituation"::jsonb
                    FROM "statistic" statistic
                    WHERE statistic."date" = $1::date
                  ),
                  '{}'::jsonb
                )
              ) AS situation_key
            ) AS "departementSituationKeyCount"
        )`
      : '';
    const publicationContextCte = publishCurrentDate
      ? `,
        publication_context AS MATERIALIZED (
          SELECT statistic_state."id"
          FROM "statistic_publication_state" statistic_state
          WHERE statistic_state."id" = 1
            AND (
              statistic_state."currentPublishedDate" IS NULL
              OR statistic_state."currentPublishedDate" <= $1::date
            )
          FOR UPDATE OF statistic_state
        )`
      : '';
    const coveragePredicate = requireNationalCoverage
      ? `
            AND EXISTS (
              SELECT 1
              FROM national_coverage coverage
              WHERE coverage."expectedDepartementCount" = 101
                AND coverage."departementRestrictionCount" = 101
                AND coverage."departementSituationCount" = 101
                AND coverage."departementSituationKeyCount" = 101
            )`
      : '';
    const publicationPredicate = publishCurrentDate
      ? `
            AND EXISTS (SELECT 1 FROM publication_context)`
      : '';
    const legacyPublicationPredicate = bumpLegacyRevisionOnCompletion
      ? `
            AND EXISTS (SELECT 1 FROM legacy_publication_context)`
      : '';
    const publishedStateCte = publishCurrentDate
      ? `,
        published_state AS (
          UPDATE "statistic_publication_state" statistic_state
          SET "revision" = statistic_state."revision" + 1,
              "currentPublishedDate" = $1::date,
              "updatedAt" = now()
          FROM completed_snapshot
          WHERE statistic_state."id" = 1
            AND EXISTS (SELECT 1 FROM publication_context)
          RETURNING statistic_state."revision"
        )`
      : '';
    const legacyPublicationContextCte = bumpLegacyRevisionOnCompletion
      ? `,
        legacy_publication_context AS MATERIALIZED (
          SELECT zone_state."id"
          FROM "zone_publication_state" zone_state
          WHERE zone_state."id" = 1
            AND zone_state."activePublicationId" IS NULL
          FOR UPDATE OF zone_state
        )`
      : '';
    const legacyRepairPublishedStateCte = bumpLegacyRevisionOnCompletion
      ? `,
        legacy_repair_published_state AS (
          UPDATE "statistic_publication_state" statistic_state
          SET "revision" = statistic_state."revision" + 1,
              "updatedAt" = now()
          FROM completed_snapshot, legacy_publication_context
          WHERE statistic_state."id" = 1
            AND statistic_state."currentPublishedDate" IS NOT NULL
            AND $1::date <= statistic_state."currentPublishedDate"
          RETURNING statistic_state."revision"
        )`
      : '';
    const resultProjection = `
          (SELECT COUNT(*)::integer FROM completed_snapshot) AS affected,
          (SELECT COUNT(*)::integer FROM target_snapshot)
            AS "snapshotCount",
          (SELECT target."status" FROM target_snapshot target)
            AS "snapshotStatus",
          (SELECT target."expectedCommuneCount" FROM target_snapshot target)
            AS "snapshotExpectedCommuneCount",
          (SELECT target."processedCommuneCount" FROM target_snapshot target)
            AS "snapshotProcessedCommuneCount"${
              guardedCertification
                ? `,
          (SELECT target."sourceRevision" FROM target_snapshot target)
            AS "snapshotSourceRevision",
          (SELECT COUNT(*)::integer FROM current_context)
            AS "contextCount",
          (SELECT context."sourceRevision" FROM current_context context)
            AS "actualSourceRevision",
          (SELECT context."historicComputeEpoch" FROM current_context context)
            AS "actualHistoricComputeEpoch"`
                : ''
            }${
              publishCurrentDate
                ? `,
          (SELECT COUNT(*)::integer FROM publication_context)
            AS "publicationContextCount",
          (SELECT COUNT(*)::integer FROM published_state)
            AS "publishedStateCount"`
                : ''
            }${
              bumpLegacyRevisionOnCompletion
                ? `,
          (SELECT COUNT(*)::integer FROM legacy_publication_context)
            AS "legacyPublicationContextCount",
          (SELECT COUNT(*)::integer FROM legacy_repair_published_state)
            AS "legacyRepairPublishedStateCount"`
                : ''
            }${
              requireNationalCoverage
                ? `,
          coverage."expectedDepartementCount",
          coverage."departementRestrictionCount",
          coverage."departementSituationCount",
          coverage."departementSituationKeyCount"`
                : ''
            }`;
    const ownsCertificationTransaction = !queryRunner.isTransactionActive;
    let certificationTransactionStarted = false;
    try {
      if (ownsCertificationTransaction) {
        await queryRunner.startTransaction();
        certificationTransactionStarted = true;
      }
      const [result] = await queryRunner.query(
        guardedCertification
          ? `
        WITH target_snapshot AS MATERIALIZED (
          SELECT
            snapshot."snapshotDate", snapshot."scope", snapshot."status",
            snapshot."expectedCommuneCount", snapshot."processedCommuneCount",
            snapshot."sourceRevision"
          FROM "statistic_commune_snapshot" snapshot
          WHERE snapshot."snapshotDate" = $1::date
            AND snapshot."scope" = $2
          FOR UPDATE OF snapshot
        ), current_context AS MATERIALIZED (
          SELECT
            ${sourceRevisionColumn('source_state')} AS "sourceRevision",
            config."historicComputeEpoch" AS "historicComputeEpoch"
          FROM "zone_publication_source_state" source_state
          CROSS JOIN "config" config
          WHERE source_state."id" = 1
            AND config."id" = 1
          FOR SHARE OF source_state, config
        )${coverageCte}${publicationContextCte}${legacyPublicationContextCte},
        completed_snapshot AS (
          UPDATE "statistic_commune_snapshot" snapshot
          SET "status" = $3::varchar,
              "processedCommuneCount" = $4,
              "completedAt" = CASE
                WHEN $3::varchar = 'ready' THEN NULL
                ELSE now()
              END,
              "lastError" = NULL,
              "updatedAt" = now()
          FROM current_context, target_snapshot target
          WHERE snapshot."snapshotDate" = target."snapshotDate"
            AND snapshot."scope" = target."scope"
            AND target."status" = 'running'
            AND target."expectedCommuneCount" = $4
            AND target."sourceRevision" = $5::bigint
            AND current_context."sourceRevision" = $5::bigint
            AND (
              $6::bigint IS NULL
              OR current_context."historicComputeEpoch" = $6::bigint
            )${coveragePredicate}${publicationPredicate}${legacyPublicationPredicate}
          RETURNING 1
        )${publishedStateCte}${legacyRepairPublishedStateCte}
        SELECT ${resultProjection}
        ${requireNationalCoverage ? 'FROM national_coverage coverage' : ''}
      `
          : `
        WITH target_snapshot AS MATERIALIZED (
          SELECT
            snapshot."snapshotDate", snapshot."scope", snapshot."status",
            snapshot."expectedCommuneCount", snapshot."processedCommuneCount"
          FROM "statistic_commune_snapshot" snapshot
          WHERE snapshot."snapshotDate" = $1::date
            AND snapshot."scope" = $2
          FOR UPDATE OF snapshot
        ), completed_snapshot AS (
          UPDATE "statistic_commune_snapshot" snapshot
          SET "status" = $3::varchar,
              "processedCommuneCount" = $4,
              "completedAt" = CASE
                WHEN $3::varchar = 'ready' THEN NULL
                ELSE now()
              END,
              "lastError" = NULL,
              "updatedAt" = now()
          FROM target_snapshot target
          WHERE snapshot."snapshotDate" = target."snapshotDate"
            AND snapshot."scope" = target."scope"
            AND target."status" = 'running'
            AND target."expectedCommuneCount" = $4
          RETURNING 1
        )${legacyRepairPublishedStateCte}
        SELECT ${resultProjection}
      `,
        guardedCertification
          ? [
              snapshotDate,
              snapshotScope,
              completedStatus,
              processedCommuneCount,
              sourceRevision,
              historicComputeEpoch ?? null,
            ]
          : [
              snapshotDate,
              snapshotScope,
              completedStatus,
              processedCommuneCount,
            ],
      );
      if (Number(result?.affected ?? 0) !== 1) {
        if (guardedCertification) {
          if (Number(result?.contextCount ?? 0) !== 1) {
            throw new Error(
              `Contexte de certification du snapshot communal ${snapshotDate} indisponible`,
            );
          }
          if (String(result.actualSourceRevision) !== sourceRevision) {
            throw new Error(
              `Historic source revision changed (${sourceRevision} -> ${String(result.actualSourceRevision)})`,
            );
          }
          if (
            historicComputeEpoch !== undefined &&
            String(result.actualHistoricComputeEpoch) !== historicComputeEpoch
          ) {
            throw new Error(
              `Historic compute epoch changed (${historicComputeEpoch} -> ${String(result.actualHistoricComputeEpoch)})`,
            );
          }
        }
        if (Number(result?.snapshotCount ?? 0) !== 1) {
          throw new Error(
            `Le snapshot communal ${snapshotDate} (${snapshotScope}) est introuvable`,
          );
        }
        if (result.snapshotStatus !== 'running') {
          throw new Error(
            `Le snapshot communal ${snapshotDate} (${snapshotScope}) a le statut ${String(result.snapshotStatus)} au lieu de running`,
          );
        }
        if (
          Number(result.snapshotExpectedCommuneCount) !== processedCommuneCount
        ) {
          throw new Error(
            `Le snapshot communal ${snapshotDate} (${snapshotScope}) attend ${Number(result.snapshotExpectedCommuneCount)} communes au lieu de ${processedCommuneCount}`,
          );
        }
        if (
          guardedCertification &&
          String(result.snapshotSourceRevision) !== sourceRevision
        ) {
          throw new Error(
            `Le snapshot communal ${snapshotDate} (${snapshotScope}) utilise la revision source ${String(result.snapshotSourceRevision)} au lieu de ${sourceRevision}`,
          );
        }
        if (
          publishCurrentDate &&
          Number(result?.publicationContextCount ?? 0) !== 1
        ) {
          throw new Error(
            `La publication statistique courante ${snapshotDate} ferait regresser le filigrane actif`,
          );
        }
        if (
          bumpLegacyRevisionOnCompletion &&
          Number(result?.legacyPublicationContextCount ?? 0) !== 1
        ) {
          throw new Error(
            `Le contexte de publication legacy ${snapshotDate} est indisponible`,
          );
        }
        if (
          requireNationalCoverage &&
          (Number(result?.expectedDepartementCount ?? 0) !== 101 ||
            Number(result?.departementRestrictionCount ?? 0) !== 101 ||
            Number(result?.departementSituationCount ?? 0) !== 101 ||
            Number(result?.departementSituationKeyCount ?? 0) !== 101)
        ) {
          throw new Error(
            `Couverture statistique departementale incomplete pour ${snapshotDate}: ` +
              `${Number(result?.departementRestrictionCount ?? 0)}/101 restrictions, ` +
              `${Number(result?.departementSituationCount ?? 0)}/101 situations, ` +
              `${Number(result?.departementSituationKeyCount ?? 0)}/101 cles`,
          );
        }
        throw new Error(
          `Les preconditions de certification du snapshot communal ${snapshotDate} (${snapshotScope}) ont change`,
        );
      }
      if (
        requireNationalCoverage &&
        (Number(result?.expectedDepartementCount ?? 0) !== 101 ||
          Number(result?.departementRestrictionCount ?? 0) !== 101 ||
          Number(result?.departementSituationCount ?? 0) !== 101 ||
          Number(result?.departementSituationKeyCount ?? 0) !== 101)
      ) {
        throw new Error(
          `Couverture statistique departementale incomplete pour ${snapshotDate}: ` +
            `${Number(result?.departementRestrictionCount ?? 0)}/101 restrictions, ` +
            `${Number(result?.departementSituationCount ?? 0)}/101 situations, ` +
            `${Number(result?.departementSituationKeyCount ?? 0)}/101 cles`,
        );
      }
      if (
        publishCurrentDate &&
        Number(result?.publishedStateCount ?? 0) !== 1
      ) {
        throw new Error(
          `La publication statistique courante ${snapshotDate} n'a pas ete certifiee`,
        );
      }
      if (
        bumpLegacyRevisionOnCompletion &&
        Number(result?.legacyPublicationContextCount ?? 0) !== 1
      ) {
        throw new Error(
          `Le contexte de publication legacy ${snapshotDate} est indisponible`,
        );
      }
      if (
        bumpLegacyRevisionOnCompletion &&
        Number(result?.legacyRepairPublishedStateCount ?? 0) !== 1
      ) {
        throw new Error(
          `La reparation statistique legacy ${snapshotDate} n'a pas actualise le filigrane`,
        );
      }
      if (snapshotScope === 'national' && !deferCertificationUntilPublication) {
        await queryRunner.query(
          `
          UPDATE "statistic_commune_snapshot"
          SET "status" = 'completed',
              "completedAt" = now(),
              "lastError" = NULL,
              "updatedAt" = now()
          WHERE "snapshotDate" = $1
        `,
          [snapshotDate],
        );
        if (!preserveBootstrapBarrier) {
          await queryRunner.query(
            `
            DELETE FROM "statistic_commune_snapshot"
            WHERE "scope" = 'bootstrap'
          `,
          );
        }
      }
      if (ownsCertificationTransaction) {
        await queryRunner.commitTransaction();
        certificationTransactionStarted = false;
      }
    } catch (error) {
      if (certificationTransactionStarted) {
        try {
          await queryRunner.rollbackTransaction();
        } catch (rollbackError) {
          this.logger.error(
            'ERREUR LORS DU ROLLBACK DE LA CERTIFICATION DU SNAPSHOT COMMUNAL',
            rollbackError,
          );
        }
      }
      throw error;
    }
  }

  private async markSnapshotFailed(
    queryRunner: QueryRunner,
    snapshotDate: string,
    snapshotScope: string,
    processedCommuneCount: number,
    error: unknown,
  ): Promise<void> {
    const query = `
      UPDATE "statistic_commune_snapshot"
      SET "status" = 'failed',
          "processedCommuneCount" = $3,
          "completedAt" = NULL,
          "lastError" = $4,
          "updatedAt" = now()
      WHERE "snapshotDate" = $1
        AND "scope" = $2
    `;
    const parameters = [
      snapshotDate,
      snapshotScope,
      processedCommuneCount,
      error instanceof Error ? error.message : String(error),
    ];
    try {
      await queryRunner.query(query, parameters);
    } catch (snapshotError) {
      this.logger.error(
        "ERREUR LORS DE L'ENREGISTREMENT DE L'ECHEC DU SNAPSHOT COMMUNAL",
        snapshotError,
      );
      try {
        await this.dataSource.query(query, parameters);
      } catch (fallbackError) {
        this.logger.error(
          "ERREUR LORS DE L'ENREGISTREMENT DE SECOURS DU SNAPSHOT COMMUNAL",
          fallbackError,
        );
      }
    }
  }

  async computeByMonth(
    date?: Moment,
    departementCodes?: string[],
    options?: MonthlyStatisticComputationOptions,
  ) {
    this.logger.log('COMPUTE BY MONTH');

    const dateDebut = date
      ? moment.utc(date.format('YYYY-MM-DD'), 'YYYY-MM-DD').startOf('month')
      : moment.utc('2013-01-01', 'YYYY-MM-DD');
    const dateFin = options?.aggregateThrough
      ? moment.utc(options.aggregateThrough.format('YYYY-MM-DD'), 'YYYY-MM-DD')
      : moment.utc();
    if (!dateDebut.isValid() || !dateFin.isValid()) {
      throw new Error('Invalid monthly statistic date range');
    }

    for (
      let m = moment(dateDebut);
      m.isSameOrBefore(dateFin, 'month');
      m.add(1, 'month')
    ) {
      this.logger.log(`COMPUTE STAT BY MONTH ${m.format('YYYY-MM')}`);
      await this.computeCommuneStatisticsRestrictionsByMonth(
        m.toDate(),
        departementCodes,
        false,
        options?.aggregateThrough?.format('YYYY-MM-DD'),
        options?.allowedReadySnapshot,
      );
    }
  }

  async computeCommuneStatisticsRestrictionsByMonth(
    date: Date,
    departementCodes?: string[],
    allowCurrentSnapshot = false,
    aggregateThrough?: string,
    allowedReadySnapshot?: {
      date: string;
      sourceRevision: string;
    },
  ) {
    if (
      aggregateThrough &&
      !moment.utc(aggregateThrough, 'YYYY-MM-DD', true).isValid()
    ) {
      throw new Error(`Invalid monthly statistic bound: ${aggregateThrough}`);
    }
    if (
      allowedReadySnapshot &&
      (allowedReadySnapshot.date !== aggregateThrough ||
        !/^\d+$/.test(allowedReadySnapshot.sourceRevision))
    ) {
      throw new Error('Invalid allowed ready monthly snapshot');
    }
    const currentDate = date.toISOString().slice(0, 10);
    const dateMoment = moment.utc(currentDate, 'YYYY-MM-DD');
    const month = dateMoment.format('YYYY-MM');
    const monthStart = dateMoment.clone().startOf('month').format('YYYY-MM-DD');
    const monthEnd = dateMoment
      .clone()
      .add(1, 'month')
      .startOf('month')
      .format('YYYY-MM-DD');
    const snapshotScope = this.getSnapshotScope(departementCodes);
    const [result] = await this.dataSource.query(
      `
          WITH current_snapshot_ready AS MATERIALIZED (
            SELECT 1
            FROM "statistic_commune_snapshot" snapshot
            WHERE $5::boolean
              AND snapshot."snapshotDate" = $7::date
              AND snapshot."scope" = $6
              AND snapshot."status" = 'running'
              AND snapshot."processedCommuneCount" = snapshot."expectedCommuneCount"
            LIMIT 1
          ), allowed_ready_snapshot AS MATERIALIZED (
            SELECT 1
            FROM "statistic_commune_snapshot" snapshot
            WHERE $9::bigint IS NOT NULL
              AND $10::date IS NOT NULL
              AND snapshot."snapshotDate" = $10::date
              AND snapshot."scope" = 'national'
              AND snapshot."status" = 'ready'
              AND snapshot."sourceRevision" = $9::bigint
            LIMIT 1
          ), allowed_completed_snapshot AS MATERIALIZED (
            SELECT 1
            FROM "statistic_commune_snapshot" snapshot
            WHERE $9::bigint IS NOT NULL
              AND $10::date IS NOT NULL
              AND snapshot."snapshotDate" = $10::date
              AND snapshot."scope" = 'national'
              AND snapshot."status" = 'completed'
              AND snapshot."sourceRevision" = $9::bigint
              AND snapshot."expectedCommuneCount" > 0
              AND snapshot."processedCommuneCount" =
                  snapshot."expectedCommuneCount"
            LIMIT 1
          ), incomplete_snapshot AS MATERIALIZED (
            SELECT 1
            FROM "statistic_commune_snapshot" snapshot
            WHERE snapshot."status" <> 'completed'
              AND (
                snapshot."scope" = 'bootstrap'
                OR NOT EXISTS (
                  SELECT 1
                  FROM "statistic_commune_snapshot" failed_national_snapshot
                  WHERE failed_national_snapshot."snapshotDate" =
                        snapshot."snapshotDate"
                    AND failed_national_snapshot."scope" = 'national'
                    AND failed_national_snapshot."status" = 'failed'
                    AND failed_national_snapshot."sourceRevision" IS NOT NULL
                )
              )
              AND (
                snapshot."scope" = 'bootstrap'
                OR (
                snapshot."snapshotDate" >= $3::date
                AND snapshot."snapshotDate" < $4::date
                AND (
                  $8::date IS NULL
                  OR snapshot."snapshotDate" <= $8::date
                )
              )
              )
              AND NOT (
                EXISTS (SELECT 1 FROM current_snapshot_ready)
                AND (
                  snapshot."scope" = 'bootstrap'
                  OR (
                    snapshot."snapshotDate" = $7::date
                    AND (
                      $6 = 'national'
                      OR snapshot."scope" = $6
                    )
                  )
                )
              )
              AND NOT (
                EXISTS (SELECT 1 FROM allowed_ready_snapshot)
                AND (
                  snapshot."scope" = 'bootstrap'
                  OR (
                    snapshot."snapshotDate" = $10::date
                    AND snapshot."scope" = 'national'
                    AND snapshot."status" = 'ready'
                    AND snapshot."sourceRevision" = $9::bigint
                  )
                )
              )
            LIMIT 1
          ), publication_barrier AS MATERIALIZED (
            SELECT
              EXISTS(SELECT 1 FROM incomplete_snapshot)
              OR (
                $9::bigint IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM allowed_ready_snapshot)
                AND NOT EXISTS (SELECT 1 FROM allowed_completed_snapshot)
              ) AS blocked
          ), selected_statistics AS MATERIALIZED (
            SELECT statistic.id
            FROM "statistic_commune" statistic
            JOIN commune ON commune.id = statistic."communeId"
            JOIN departement ON departement.id = commune."departementId"
            WHERE ($1::text[] IS NULL OR departement.code = ANY($1::text[]))
              AND NOT (SELECT blocked FROM publication_barrier)
          ), monthly AS (
            SELECT
              statistic.id,
              COALESCE(
                SUM(
                  CASE GREATEST(
                    CASE daily.value ->> 'AEP'
                      WHEN 'vigilance' THEN 2
                      WHEN 'alerte' THEN 3
                      WHEN 'alerte_renforcee' THEN 4
                      WHEN 'crise' THEN 5
                      ELSE 1
                    END,
                    CASE daily.value ->> 'SOU'
                      WHEN 'vigilance' THEN 2
                      WHEN 'alerte' THEN 3
                      WHEN 'alerte_renforcee' THEN 4
                      WHEN 'crise' THEN 5
                      ELSE 1
                    END,
                    CASE daily.value ->> 'SUP'
                      WHEN 'vigilance' THEN 2
                      WHEN 'alerte' THEN 3
                      WHEN 'alerte_renforcee' THEN 4
                      WHEN 'crise' THEN 5
                      ELSE 1
                    END
                  )
                    WHEN 2 THEN 0.5
                    WHEN 3 THEN 2
                    WHEN 4 THEN 3
                    WHEN 5 THEN 4
                    ELSE 0
                  END
                ) FILTER (WHERE daily.value IS NOT NULL),
                0
              ) AS ponderation
            FROM "statistic_commune" statistic
            JOIN selected_statistics selected
              ON selected.id = statistic.id
            LEFT JOIN LATERAL jsonb_array_elements(
              COALESCE(statistic."restrictions", '[]'::jsonb)
            ) AS daily(value)
              ON daily.value ->> 'date' LIKE $2 || '-%'
             AND NOT EXISTS (
               SELECT 1
               FROM "statistic_commune_snapshot" failed_national_snapshot
               WHERE failed_national_snapshot."snapshotDate" =
                     (daily.value ->> 'date')::date
                 AND failed_national_snapshot."scope" = 'national'
                 AND failed_national_snapshot."status" = 'failed'
                 AND failed_national_snapshot."sourceRevision" IS NOT NULL
             )
             AND (
               $8::date IS NULL
               OR (daily.value ->> 'date')::date <= $8::date
             )
            GROUP BY statistic.id
          ), updated AS (
            UPDATE "statistic_commune" statistic
            SET "restrictionsByMonth" =
              (
                SELECT COALESCE(
                  jsonb_agg(
                    sorted.value
                    ORDER BY
                      CASE
                        WHEN sorted.value ->> 'date'
                          ~ '^[0-9]{4}-[0-9]{2}$' THEN 0
                        ELSE 1
                      END,
                      CASE
                        WHEN sorted.value ->> 'date'
                          ~ '^[0-9]{4}-[0-9]{2}$'
                          THEN sorted.value ->> 'date'
                        ELSE NULL
                      END,
                      sorted.ordinality
                  ),
                  '[]'::jsonb
                )
                FROM jsonb_array_elements(
                  COALESCE(
                    (
                      SELECT jsonb_agg(
                        CASE
                          WHEN item.value ->> 'date' = $2
                            THEN jsonb_build_object(
                              'date', $2::text,
                              'ponderation', monthly.ponderation
                            )
                          ELSE item.value
                        END
                        ORDER BY item.ordinality
                      )
                      FROM jsonb_array_elements(
                        COALESCE(
                          statistic."restrictionsByMonth",
                          '[]'::jsonb
                        )
                      ) WITH ORDINALITY AS item(value, ordinality)
                    ),
                    '[]'::jsonb
                  ) || CASE
                    WHEN NOT EXISTS (
                      SELECT 1
                      FROM jsonb_array_elements(
                        COALESCE(
                          statistic."restrictionsByMonth",
                          '[]'::jsonb
                        )
                      ) AS existing(value)
                      WHERE existing.value ->> 'date' = $2
                    )
                    THEN jsonb_build_array(
                      jsonb_build_object(
                        'date', $2::text,
                        'ponderation', monthly.ponderation
                      )
                    )
                    ELSE '[]'::jsonb
                  END
                ) WITH ORDINALITY AS sorted(value, ordinality)
              )
            FROM monthly
            WHERE statistic.id = monthly.id
            RETURNING statistic.id
          )
          SELECT
            (SELECT blocked FROM publication_barrier) AS blocked,
            (SELECT COUNT(*)::integer FROM selected_statistics) AS expected,
            (SELECT COUNT(*)::integer FROM updated) AS affected
      `,
      [
        departementCodes?.length ? [...new Set(departementCodes)] : null,
        month,
        monthStart,
        monthEnd,
        allowCurrentSnapshot,
        snapshotScope,
        currentDate,
        aggregateThrough ?? null,
        allowedReadySnapshot?.sourceRevision ?? null,
        allowedReadySnapshot?.date ?? null,
      ],
    );
    if (result?.blocked === true) {
      throw new Error(`Calcul mensuel communal bloque pour ${month}`);
    }
    if (Number(result?.affected ?? 0) !== Number(result?.expected ?? 0)) {
      throw new Error(
        `Calcul mensuel communal incomplet: ${Number(result?.affected ?? 0)}/${Number(result?.expected ?? 0)} statistiques mises a jour`,
      );
    }
  }

  async sortStatCommune(departementCodes?: string[]) {
    this.logger.log(`SORTING COMMUNE STATISTICS RESTRICTIONS`);
    const qb = this.statisticCommuneRepository
      .createQueryBuilder('statistic_commune')
      .update()
      .set({
        restrictions: () => `
          (
            SELECT jsonb_agg(
              item.value
              ORDER BY
                CASE
                  WHEN item.value ->> 'date'
                    ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN 0
                  ELSE 1
                END,
                CASE
                  WHEN item.value ->> 'date'
                    ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                    THEN item.value ->> 'date'
                  ELSE NULL
                END,
                item.ordinality
            )
            FROM jsonb_array_elements(restrictions)
              WITH ORDINALITY AS item(value, ordinality)
          )`,
      })
      .where(`"restrictions" is not null`);
    if (departementCodes?.length > 0) {
      qb.andWhere(
        `"communeId" IN (
          SELECT commune.id
          FROM commune
          JOIN departement ON departement.id = commune."departementId"
          WHERE departement.code IN (:...departementCodes)
        )`,
        { departementCodes },
      );
    }
    await qb.execute();

    const qbBis = this.statisticCommuneRepository
      .createQueryBuilder('statistic_commune')
      .update()
      .set({
        restrictionsByMonth: () => `
          (
            SELECT jsonb_agg(
              item.value
              ORDER BY
                CASE
                  WHEN item.value ->> 'date'
                    ~ '^[0-9]{4}-[0-9]{2}$' THEN 0
                  ELSE 1
                END,
                CASE
                  WHEN item.value ->> 'date'
                    ~ '^[0-9]{4}-[0-9]{2}$'
                    THEN item.value ->> 'date'
                  ELSE NULL
                END,
                item.ordinality
            )
            FROM jsonb_array_elements(restrictionsByMonth)
              WITH ORDINALITY AS item(value, ordinality)
          )`,
      })
      .where(`"restrictionsByMonth" is not null`);
    if (departementCodes?.length > 0) {
      qbBis.andWhere(
        `"communeId" IN (
          SELECT commune.id
          FROM commune
          JOIN departement ON departement.id = commune."departementId"
          WHERE departement.code IN (:...departementCodes)
        )`,
        { departementCodes },
      );
    }
    await qbBis.execute();
    return;
  }
}
