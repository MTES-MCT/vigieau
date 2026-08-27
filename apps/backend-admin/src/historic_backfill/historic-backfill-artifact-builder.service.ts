import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RegleauLogger } from '../logger/regleau.logger';
import { S3Service } from '../shared/services/s3.service';
import { generateEmptyPmtiles } from '../zone_alerte_computed/empty-pmtiles';
import { LEGACY_HISTORIC_EMPTY_GEOMETRY_ZONE_IDS } from '../zone_alerte_computed/legacy-historic-empty-geometries';
import {
  assertTippecanoeExecutables,
  collectComputedHistoricPmtilesFeatureIds,
  collectLegacyHistoricBackfillPmtilesFeatureIds,
  COMPUTED_HISTORIC_PMTILES_MAX_ZOOM,
  generatePmtiles,
} from '../zone_alerte_computed/pmtiles-generation';
import {
  HistoricBackfillArtifactLease,
  HistoricBackfillArtifactOutput,
  HistoricBackfillArtifactQueueService,
} from './historic-backfill-artifact-queue.service';
import { HISTORIC_BACKFILL_EXPECTED_DEPARTMENT_COUNT } from './historic-backfill-queue.service';
import { readHistoricBackfillArtifactAcl } from './historic-backfill.config';
import { COMPUTED_HISTORIC_START_DATE } from './historic-backfill-task-handler';

interface GeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    geometry: unknown;
    properties?: { id?: unknown };
  }>;
}

interface HistoricDepartmentArtifactSegment {
  departementId: number;
  geojsonObjectKey: string;
  geojsonChecksum: string;
  featureCount: number;
}

const HISTORIC_BACKFILL_ARTIFACT_CACHE_MAX_BYTES_DEFAULT = 256 * 1024 * 1024;
const HISTORIC_BACKFILL_ARTIFACT_CACHE_MAX_BYTES_LIMIT = 1024 * 1024 * 1024;

export class HistoricBackfillArtifactYieldError extends Error {}

function checksum(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseFeatureCollection(
  value: Buffer,
  objectKey: string,
): GeoJsonFeatureCollection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.toString('utf8'));
  } catch (error) {
    throw new Error(
      `Invalid GeoJSON ${objectKey}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const collection = parsed as Partial<GeoJsonFeatureCollection>;
  if (
    collection.type !== 'FeatureCollection' ||
    !Array.isArray(collection.features)
  ) {
    throw new Error(`Invalid GeoJSON feature collection ${objectKey}`);
  }
  return collection as GeoJsonFeatureCollection;
}

@Injectable()
export class HistoricBackfillArtifactBuilderService {
  private readonly logger = new RegleauLogger(
    'HistoricBackfillArtifactBuilderService',
  );
  private readonly departmentArtifactCache = new Map<string, Buffer>();
  private departmentArtifactCacheBytes = 0;
  private readonly artifactAcl = readHistoricBackfillArtifactAcl();

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly queue: HistoricBackfillArtifactQueueService,
    private readonly s3Service: S3Service,
    private readonly configService: ConfigService,
  ) {}

  async build(
    lease: HistoricBackfillArtifactLease,
    signal: AbortSignal,
  ): Promise<HistoricBackfillArtifactOutput> {
    await this.assertCurrentPriorityClear();
    const tippecanoeBinDirectory = resolve(
      process.cwd(),
      this.configService.get<string>('TIPPECANOE_BIN_DIRECTORY')?.trim() ||
        'tippecanoe_program/bin',
    );
    await assertTippecanoeExecutables(tippecanoeBinDirectory, [
      'tippecanoe',
      'tippecanoe-decode',
      'tile-join',
    ]);
    const segments = await this.queue.getOutputSegments(
      this.dataSource.manager,
      lease,
    );
    if (segments.length !== HISTORIC_BACKFILL_EXPECTED_DEPARTMENT_COUNT) {
      throw new Error(
        `Historic artifact requires ${HISTORIC_BACKFILL_EXPECTED_DEPARTMENT_COUNT} department segments, got ${segments.length}`,
      );
    }

    const features: GeoJsonFeatureCollection['features'] = [];
    const concurrency = this.readDownloadConcurrency();
    const cacheMaxBytes = this.readCacheMaxBytes();
    this.trimCache(cacheMaxBytes);
    for (let offset = 0; offset < segments.length; offset += concurrency) {
      if (signal.aborted) {
        throw signal.reason ?? new Error('Historic artifact build aborted');
      }
      await this.assertCurrentPriorityClear();
      const batch = segments.slice(offset, offset + concurrency);
      const collections = await Promise.all(
        batch.map((segment) =>
          this.loadDepartmentArtifact(segment, signal, cacheMaxBytes),
        ),
      );
      for (const collection of collections) {
        features.push(...collection.features);
      }
    }
    await this.assertCurrentPriorityClear();

    const geojson: GeoJsonFeatureCollection = {
      type: 'FeatureCollection',
      features,
    };
    let expectedFeatureIds: string[];
    let optionalFeatureIds: string[] = [];
    if (lease.validFrom < COMPUTED_HISTORIC_START_DATE) {
      const legacyFeatureIds = collectLegacyHistoricBackfillPmtilesFeatureIds(
        features,
        LEGACY_HISTORIC_EMPTY_GEOMETRY_ZONE_IDS,
      );
      expectedFeatureIds = legacyFeatureIds.expectedFeatureIds;
      if (legacyFeatureIds.excludedEmptyGeometryIds.length > 0) {
        this.logger.warn(
          JSON.stringify({
            type: 'historic_backfill_pmtiles_empty_geometries_excluded',
            runId: lease.runId,
            validFrom: lease.validFrom,
            zoneIds: legacyFeatureIds.excludedEmptyGeometryIds,
          }),
        );
      }
    } else {
      const computedFeatureIds =
        collectComputedHistoricPmtilesFeatureIds(features);
      expectedFeatureIds = computedFeatureIds.expectedFeatureIds;
      optionalFeatureIds = computedFeatureIds.excludedNonRenderableGeometryIds;
      if (computedFeatureIds.excludedNonRenderableGeometryIds.length > 0) {
        this.logger.warn(
          JSON.stringify({
            type: 'historic_backfill_pmtiles_non_renderable_geometries_excluded',
            runId: lease.runId,
            validFrom: lease.validFrom,
            zoneIds: computedFeatureIds.excludedNonRenderableGeometryIds,
          }),
        );
      }
    }
    const temporaryRoot =
      this.configService.get<string>('PATH_TO_WRITE_FILE') || '/tmp';
    const workingDirectory = await mkdtemp(
      join(temporaryRoot, 'historic-backfill-'),
    );
    const geojsonPath = join(workingDirectory, `${lease.validFrom}.geojson`);
    const pmtilesPath = join(workingDirectory, `${lease.validFrom}.pmtiles`);

    try {
      await writeFile(geojsonPath, JSON.stringify(geojson));
      if (expectedFeatureIds.length === 0) {
        await generateEmptyPmtiles({
          workingDirectory,
          tippecanoeBinDirectory,
          outputPath: pmtilesPath,
        });
      } else {
        await generatePmtiles({
          workingDirectory,
          tippecanoeBinDirectory,
          inputPath: geojsonPath,
          outputPath: pmtilesPath,
          expectedFeatureIds,
          optionalFeatureIds,
          maximumZoom:
            lease.validFrom >= COMPUTED_HISTORIC_START_DATE
              ? COMPUTED_HISTORIC_PMTILES_MAX_ZOOM
              : undefined,
        });
      }
      if (signal.aborted) {
        throw signal.reason ?? new Error('Historic artifact build aborted');
      }
      await this.assertCurrentPriorityClear();

      const geojsonBody = await readFile(geojsonPath);
      const pmtilesBody = await readFile(pmtilesPath);
      const geojsonChecksum = checksum(geojsonBody);
      const pmtilesChecksum = checksum(pmtilesBody);
      const prefix =
        `historic-backfill/${lease.runId}/national/` +
        `revision-${lease.sourceRevision}/epoch-${lease.historicComputeEpoch}/`;
      const geojsonObjectKey = `${prefix}${lease.validFrom}-${geojsonChecksum}.geojson`;
      const pmtilesObjectKey = `${prefix}${lease.validFrom}-${pmtilesChecksum}.pmtiles`;
      await this.s3Service.uploadFile(
        {
          originalname: geojsonObjectKey,
          mimetype: 'application/geo+json',
          buffer: geojsonBody,
        } as Express.Multer.File,
        '',
        { abortSignal: signal, acl: this.artifactAcl },
      );
      await this.s3Service.uploadFile(
        {
          originalname: pmtilesObjectKey,
          mimetype: 'application/vnd.pmtiles',
          buffer: pmtilesBody,
        } as Express.Multer.File,
        '',
        { abortSignal: signal, acl: this.artifactAcl },
      );
      return {
        geojsonObjectKey,
        geojsonChecksum,
        pmtilesObjectKey,
        pmtilesChecksum,
        featureCount: features.length,
      };
    } finally {
      await rm(workingDirectory, { force: true, recursive: true });
    }
  }

  private readDownloadConcurrency(): number {
    const raw =
      process.env.HISTORIC_BACKFILL_ARTIFACT_DOWNLOAD_CONCURRENCY?.trim();
    const parsed = raw ? Number(raw) : 8;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 32) {
      throw new Error(
        'HISTORIC_BACKFILL_ARTIFACT_DOWNLOAD_CONCURRENCY must be between 1 and 32',
      );
    }
    return parsed;
  }

  private readCacheMaxBytes(): number {
    const raw = process.env.HISTORIC_BACKFILL_ARTIFACT_CACHE_MAX_BYTES?.trim();
    const parsed = raw
      ? Number(raw)
      : HISTORIC_BACKFILL_ARTIFACT_CACHE_MAX_BYTES_DEFAULT;
    if (
      !Number.isSafeInteger(parsed) ||
      parsed < 0 ||
      parsed > HISTORIC_BACKFILL_ARTIFACT_CACHE_MAX_BYTES_LIMIT
    ) {
      throw new Error(
        'HISTORIC_BACKFILL_ARTIFACT_CACHE_MAX_BYTES must be an integer between 0 and 1073741824',
      );
    }
    return parsed;
  }

  private async loadDepartmentArtifact(
    segment: HistoricDepartmentArtifactSegment,
    signal: AbortSignal,
    cacheMaxBytes: number,
  ): Promise<GeoJsonFeatureCollection> {
    const cacheKey = JSON.stringify([
      segment.geojsonObjectKey,
      segment.geojsonChecksum,
    ]);
    let body = this.takeCachedBody(cacheKey, cacheMaxBytes);
    const cacheHit = body !== undefined;

    if (!body) {
      body = await this.s3Service.downloadFile(segment.geojsonObjectKey, '', {
        abortSignal: signal,
      });
    }
    this.throwIfAborted(signal);

    try {
      if (checksum(body) !== segment.geojsonChecksum) {
        throw new Error(
          `Historic department artifact checksum mismatch for ${segment.departementId}`,
        );
      }
      const collection = parseFeatureCollection(body, segment.geojsonObjectKey);
      if (collection.features.length !== Number(segment.featureCount)) {
        throw new Error(
          `Historic department artifact feature count mismatch for ${segment.departementId}`,
        );
      }
      this.throwIfAborted(signal);
      if (!cacheHit) {
        this.cacheBody(cacheKey, body, cacheMaxBytes);
      }
      return collection;
    } catch (error) {
      if (cacheHit) {
        this.deleteCachedBody(cacheKey);
      }
      throw error;
    }
  }

  private takeCachedBody(
    cacheKey: string,
    cacheMaxBytes: number,
  ): Buffer | undefined {
    if (cacheMaxBytes === 0) {
      return undefined;
    }
    const body = this.departmentArtifactCache.get(cacheKey);
    if (!body) {
      return undefined;
    }
    this.departmentArtifactCache.delete(cacheKey);
    this.departmentArtifactCache.set(cacheKey, body);
    return body;
  }

  private cacheBody(
    cacheKey: string,
    body: Buffer,
    cacheMaxBytes: number,
  ): void {
    if (cacheMaxBytes === 0 || body.byteLength > cacheMaxBytes) {
      return;
    }
    this.deleteCachedBody(cacheKey);
    while (
      this.departmentArtifactCacheBytes + body.byteLength >
      cacheMaxBytes
    ) {
      const oldestKey = this.departmentArtifactCache.keys().next().value as
        | string
        | undefined;
      if (oldestKey === undefined) {
        break;
      }
      this.deleteCachedBody(oldestKey);
    }
    this.departmentArtifactCache.set(cacheKey, body);
    this.departmentArtifactCacheBytes += body.byteLength;
  }

  private trimCache(cacheMaxBytes: number): void {
    while (this.departmentArtifactCacheBytes > cacheMaxBytes) {
      const oldestKey = this.departmentArtifactCache.keys().next().value as
        | string
        | undefined;
      if (oldestKey === undefined) {
        this.departmentArtifactCacheBytes = 0;
        return;
      }
      this.deleteCachedBody(oldestKey);
    }
  }

  private deleteCachedBody(cacheKey: string): void {
    const body = this.departmentArtifactCache.get(cacheKey);
    if (!body) {
      return;
    }
    this.departmentArtifactCache.delete(cacheKey);
    this.departmentArtifactCacheBytes -= body.byteLength;
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw signal.reason ?? new Error('Historic artifact build aborted');
    }
  }

  private async assertCurrentPriorityClear(): Promise<void> {
    const [row] = (await this.dataSource.query(`
      SELECT
        EXISTS (
          SELECT 1
          FROM "current_zone_recompute_request" request
          WHERE request."currentPending"
            OR EXISTS (
              SELECT 1
              FROM unnest(request."pendingScheduledDates")
                AS pending_dates(pending_date)
              WHERE pending_date <=
                (now() AT TIME ZONE 'Europe/Paris')::date
            )
        ) AS "queued",
        EXISTS (
          SELECT 1 FROM "statistic_commune_snapshot" WHERE "status" = 'running'
        ) AS "snapshotRunning",
        EXISTS (
          SELECT 1
          FROM "external_publication_run" daily_run
          WHERE daily_run."jobKey" = 'compute:national-daily'
            AND daily_run."status" = 'running'
        ) AS "dailyRunRunning"
    `)) as Array<{
      queued: boolean;
      snapshotRunning: boolean;
      dailyRunRunning: boolean;
    }>;
    if (row?.queued || row?.snapshotRunning || row?.dailyRunRunning) {
      throw new HistoricBackfillArtifactYieldError(
        'Current computation has priority over historic artifacts',
      );
    }
  }
}
