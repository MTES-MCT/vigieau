import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { VigieauLogger } from '../logger/vigieau.logger';
import { statisticSourceRevisionSql } from './statistic-cache-config';

export const STATISTIC_CACHE_ARTIFACT_SCHEMA_VERSION = 1;
export const STATISTIC_CACHE_PROTOCOL_VERSION = 1;
export const STATISTIC_CACHE_ARTIFACT_KINDS = [
  'area',
  'departement',
  'commune',
] as const;

export type StatisticCacheArtifactKind =
  (typeof STATISTIC_CACHE_ARTIFACT_KINDS)[number];

export type StatisticCacheArtifactMode = 'legacy-bootstrap' | 'versioned';

export type StatisticCacheMaterializationStrategy =
  | 'full-clean'
  | 'legacy-safe-boundary'
  | 'daily-delta'
  | 'current-replace'
  | 'sparse-current'
  | 'certified-history-overlay';

export type StatisticCacheLatestCommuneWeight = [code: string, weight: number];

export interface StatisticCacheArtifactTarget {
  statisticRevision: string;
  currentPublishedDate: string;
}

export interface StatisticCacheMaterializationTarget extends StatisticCacheArtifactTarget {
  protocolVersion: number;
  historicDirtyFrom: string | null;
  historicDirtyThrough: string | null;
  historicMapCursor: string | null;
  historicStatsCursor: string | null;
  sourceRevision: string | null;
  historicComputeEpoch: string | null;
  certifiedHistoryRepairId: string | null;
}

export type StatisticCacheCandidateTarget = StatisticCacheMaterializationTarget;

export interface StatisticCacheCandidateStageOptions {
  replaceActivePublicationId?: string;
  requiredFirstDate?: string;
  minimumDateCount?: number;
}

export type StatisticCacheCandidateActivationResult =
  | {
      outcome: 'activated';
      publication: StatisticCacheArtifactIdentity;
      liveInstances: number;
      readyInstances: number;
    }
  | {
      outcome: 'awaiting-acknowledgements' | 'superseded' | 'retry';
      reason: string;
      liveInstances: number;
      readyInstances: number;
    };

export interface StatisticCacheRollbackGuard {
  activePublicationId: string;
  previousPublicationId: string;
}

export interface StatisticCacheArtifactIdentity extends StatisticCacheArtifactTarget {
  id: string;
  protocolVersion: number;
  mode: StatisticCacheArtifactMode;
  materializationStrategy: StatisticCacheMaterializationStrategy;
  historicDirtyFrom: string | null;
  historicDirtyThrough: string | null;
  historicMapCursor: string | null;
  historicStatsCursor: string | null;
  sourceRevision: string | null;
  historicComputeEpoch: string | null;
  certifiedHistoryRepairId: string | null;
  contentFingerprint: string;
  firstDate: string;
  latestDate: string;
  dateCount: number;
  areaCount: number;
  departmentCount: number;
  communeCount: number;
  readyAt: Date;
}

export interface StatisticCacheArtifactPayload {
  identity: StatisticCacheArtifactIdentity;
  dataArea: any[];
  dataDepartement: any[];
  dataCommune: any[];
  latestCommuneWeights: StatisticCacheLatestCommuneWeight[];
}

export interface StatisticCacheArtifactCandidate extends StatisticCacheArtifactTarget {
  mode: StatisticCacheArtifactMode;
  materializationStrategy: StatisticCacheMaterializationStrategy;
  historicDirtyFrom: string | null;
  historicDirtyThrough: string | null;
  historicMapCursor: string | null;
  historicStatsCursor: string | null;
  sourceRevision: string | null;
  historicComputeEpoch: string | null;
  certifiedHistoryRepairId: string | null;
  contentFingerprint: string;
  firstDate: string;
  latestDate: string;
  dateCount: number;
  departmentCount: number;
  communeCount: number;
  dataArea: any[];
  dataDepartement: any[];
  dataCommune: any[];
  latestCommuneWeights: StatisticCacheLatestCommuneWeight[];
}

type ArtifactRow = {
  id: string;
  statisticRevision: string | number;
  currentPublishedDate: string | Date;
  schemaVersion: string | number;
  protocolVersion: string | number;
  mode: StatisticCacheArtifactMode;
  materializationStrategy: StatisticCacheMaterializationStrategy;
  historicDirtyFrom: string | Date | null;
  historicDirtyThrough: string | Date | null;
  historicMapCursor: string | Date | null;
  historicStatsCursor: string | Date | null;
  sourceRevision: string | number | null;
  historicComputeEpoch: string | number | null;
  certifiedHistoryRepairId: string | null;
  contentFingerprint: string;
  firstDate: string | Date;
  latestDate: string | Date;
  dateCount: string | number;
  areaCount: string | number;
  departmentCount: string | number;
  communeCount: string | number;
  publicationCompressedByteLength: string | number;
  publicationUncompressedByteLength: string | number;
  readyAt: string | Date;
  kind: StatisticCacheArtifactKind;
  rowCount: string | number;
  artifactContentFingerprint: string;
  checksum: string;
  compressedByteLength: string | number;
  uncompressedByteLength: string | number;
  payload: Buffer;
};

type ArtifactEnvelope = {
  schemaVersion: number;
  kind: StatisticCacheArtifactKind;
  data: any[];
  latestCommuneWeights?: StatisticCacheLatestCommuneWeight[];
};

type EncodedArtifact = {
  kind: StatisticCacheArtifactKind;
  rowCount: number;
  contentFingerprint: string;
  checksum: string;
  compressedByteLength: number;
  uncompressedByteLength: number;
  payload: Buffer;
};

type StatisticCacheQueryable =
  | Pick<DataSource, 'query'>
  | Pick<EntityManager, 'query'>;

const MAX_COMPRESSED_ARTIFACT_BYTES = 48 * 1024 * 1024;
const MAX_TOTAL_COMPRESSED_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_UNCOMPRESSED_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MATERIALIZATION_WAIT_MS = 30 * 1000;
const MATERIALIZATION_POLL_MS = 1_000;
const MATERIALIZATION_LOCK = 'vigieau:statistic-cache:materialization';

function normalizeDate(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isPreparedLegacyBoundaryRequired(): boolean {
  const value =
    process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED?.trim().toLowerCase() ||
    'false';
  if (value !== 'true' && value !== 'false') {
    throw new Error(`Unsupported STATISTIC_CACHE_ARTIFACT_REQUIRED: ${value}`);
  }
  return value === 'true';
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid statistic cache ${label}`);
  }
  return parsed;
}

function isSerializationFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as {
    code?: unknown;
    driverError?: { code?: unknown };
    cause?: unknown;
  };
  return (
    candidate.code === '40001' ||
    candidate.driverError?.code === '40001' ||
    (candidate.cause !== error && isSerializationFailure(candidate.cause))
  );
}

function normalizeMaterializationError(error: unknown): unknown {
  if (!isSerializationFailure(error)) {
    return error;
  }
  const boundaryError = new Error(
    'Statistic materialization boundary changed before activation',
  ) as Error & { cause?: unknown };
  boundaryError.cause = error;
  return boundaryError;
}

function hasMaterializationTarget(
  payload: StatisticCacheArtifactPayload | null,
  target: StatisticCacheMaterializationTarget,
): payload is StatisticCacheArtifactPayload {
  return Boolean(
    payload && hasCandidateIdentityTarget(payload.identity, target),
  );
}

function hasCandidateIdentityTarget(
  identity: StatisticCacheArtifactIdentity | null,
  target: StatisticCacheMaterializationTarget,
): identity is StatisticCacheArtifactIdentity {
  return Boolean(
    identity &&
    identity.statisticRevision === target.statisticRevision &&
    identity.currentPublishedDate === target.currentPublishedDate &&
    identity.protocolVersion === target.protocolVersion &&
    identity.historicDirtyFrom === target.historicDirtyFrom &&
    identity.historicDirtyThrough === target.historicDirtyThrough &&
    identity.historicMapCursor === target.historicMapCursor &&
    identity.historicStatsCursor === target.historicStatsCursor &&
    identity.sourceRevision === target.sourceRevision &&
    identity.historicComputeEpoch === target.historicComputeEpoch &&
    identity.certifiedHistoryRepairId === target.certifiedHistoryRepairId,
  );
}

function hasReusableCandidateIdentity(
  identity: StatisticCacheArtifactIdentity | null,
  target: StatisticCacheMaterializationTarget,
  options: StatisticCacheCandidateStageOptions,
): identity is StatisticCacheArtifactIdentity {
  return Boolean(
    hasCandidateIdentityTarget(identity, target) &&
    identity.id !== (options.replaceActivePublicationId ?? null) &&
    hasRequiredCandidateCoverage(identity, options),
  );
}

function hasRequiredCandidateCoverage(
  candidate: Pick<StatisticCacheArtifactCandidate, 'firstDate' | 'dateCount'>,
  options: StatisticCacheCandidateStageOptions,
): boolean {
  return Boolean(
    (!options.requiredFirstDate ||
      candidate.firstDate === options.requiredFirstDate) &&
    (options.minimumDateCount === undefined ||
      candidate.dateCount >= options.minimumDateCount),
  );
}

function candidateMatchesTarget(
  candidate: StatisticCacheArtifactCandidate,
  target: StatisticCacheMaterializationTarget,
): boolean {
  return (
    candidate.statisticRevision === target.statisticRevision &&
    candidate.currentPublishedDate === target.currentPublishedDate &&
    target.protocolVersion === STATISTIC_CACHE_PROTOCOL_VERSION &&
    candidate.historicDirtyFrom === target.historicDirtyFrom &&
    candidate.historicDirtyThrough === target.historicDirtyThrough &&
    candidate.historicMapCursor === target.historicMapCursor &&
    candidate.historicStatsCursor === target.historicStatsCursor &&
    candidate.sourceRevision === target.sourceRevision &&
    candidate.historicComputeEpoch === target.historicComputeEpoch &&
    candidate.certifiedHistoryRepairId === target.certifiedHistoryRepairId
  );
}

@Injectable()
export class StatisticCacheArtifactService {
  private readonly logger = new VigieauLogger('StatisticCacheArtifactService');

  constructor(private readonly dataSource: DataSource) {}

  async loadActive(
    queryable: StatisticCacheQueryable = this.dataSource,
  ): Promise<StatisticCacheArtifactPayload | null> {
    return this.loadStatePublication(
      'activePublicationId',
      'active',
      null,
      queryable,
    );
  }

  async loadCandidate(
    queryable: StatisticCacheQueryable = this.dataSource,
  ): Promise<StatisticCacheArtifactPayload | null> {
    return this.loadStatePublication(
      'candidatePublicationId',
      'ready',
      null,
      queryable,
    );
  }

  async loadActiveIdentity(
    queryable: StatisticCacheQueryable = this.dataSource,
  ): Promise<StatisticCacheArtifactIdentity | null> {
    return this.loadStatePublicationIdentity(
      'activePublicationId',
      'active',
      queryable,
    );
  }

  async loadCandidateIdentity(
    queryable: StatisticCacheQueryable = this.dataSource,
  ): Promise<StatisticCacheArtifactIdentity | null> {
    return this.loadStatePublicationIdentity(
      'candidatePublicationId',
      'ready',
      queryable,
    );
  }

  private async loadStatePublicationIdentity(
    stateColumn: 'activePublicationId' | 'candidatePublicationId',
    status: 'active' | 'ready',
    queryable: StatisticCacheQueryable,
  ): Promise<StatisticCacheArtifactIdentity | null> {
    const [row] = await queryable.query(
      `
        SELECT
          publication."id", publication."statisticRevision",
          publication."currentPublishedDate"::text AS "currentPublishedDate",
          publication."protocolVersion", publication."mode",
          publication."materializationStrategy",
          publication."historicDirtyFrom"::text AS "historicDirtyFrom",
          publication."historicDirtyThrough"::text AS "historicDirtyThrough",
          publication."historicMapCursor"::text AS "historicMapCursor",
          publication."historicStatsCursor"::text AS "historicStatsCursor",
          publication."sourceRevision", publication."historicComputeEpoch",
          publication."certifiedHistoryRepairId"::text
            AS "certifiedHistoryRepairId",
          publication."contentFingerprint",
          publication."firstDate"::text AS "firstDate",
          publication."latestDate"::text AS "latestDate",
          publication."dateCount", publication."areaCount",
          publication."departmentCount", publication."communeCount",
          publication."readyAt"
        FROM "statistic_cache_state" state
        JOIN "statistic_cache_publication" publication
          ON publication."id" = state."${stateColumn}"
        WHERE state."id" = 1
          AND publication."status" = $1::varchar
      `,
      [status],
    );
    if (!row) return null;
    const identity: StatisticCacheArtifactIdentity = {
      id: String(row.id),
      statisticRevision: String(row.statisticRevision),
      currentPublishedDate: normalizeDate(row.currentPublishedDate)!,
      protocolVersion: positiveInteger(row.protocolVersion, 'protocol version'),
      mode: row.mode,
      materializationStrategy: row.materializationStrategy,
      historicDirtyFrom: normalizeDate(row.historicDirtyFrom),
      historicDirtyThrough: normalizeDate(row.historicDirtyThrough),
      historicMapCursor: normalizeDate(row.historicMapCursor),
      historicStatsCursor: normalizeDate(row.historicStatsCursor),
      sourceRevision:
        row.sourceRevision === null ? null : String(row.sourceRevision),
      historicComputeEpoch:
        row.historicComputeEpoch === null
          ? null
          : String(row.historicComputeEpoch),
      certifiedHistoryRepairId:
        row.certifiedHistoryRepairId === null
          ? null
          : String(row.certifiedHistoryRepairId),
      contentFingerprint: String(row.contentFingerprint),
      firstDate: normalizeDate(row.firstDate)!,
      latestDate: normalizeDate(row.latestDate)!,
      dateCount: positiveInteger(row.dateCount, 'date count'),
      areaCount: positiveInteger(row.areaCount, 'area count'),
      departmentCount: positiveInteger(row.departmentCount, 'department count'),
      communeCount: positiveInteger(row.communeCount, 'commune count'),
      readyAt:
        row.readyAt instanceof Date
          ? row.readyAt
          : new Date(String(row.readyAt)),
    };
    if (
      !/^\d+$/.test(identity.statisticRevision) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(identity.currentPublishedDate) ||
      identity.protocolVersion !== STATISTIC_CACHE_PROTOCOL_VERSION ||
      !/^[a-f0-9]{64}$/.test(identity.contentFingerprint) ||
      Number.isNaN(identity.readyAt.getTime())
    ) {
      throw new Error('Statistic cache publication identity is invalid');
    }
    return identity;
  }

  async loadPublication(
    publicationId: string | null,
    queryable: StatisticCacheQueryable = this.dataSource,
  ): Promise<StatisticCacheArtifactPayload | null> {
    return this.loadStatePublication(
      'activePublicationId',
      'active',
      publicationId,
      queryable,
    );
  }

  private async loadStatePublication(
    stateColumn: 'activePublicationId' | 'candidatePublicationId',
    status: 'active' | 'ready',
    publicationId: string | null,
    queryable: StatisticCacheQueryable,
  ): Promise<StatisticCacheArtifactPayload | null> {
    const rows = (await queryable.query(
      `
        SELECT
          publication."id", publication."statisticRevision",
          publication."currentPublishedDate"::text AS "currentPublishedDate",
          publication."schemaVersion", publication."protocolVersion",
          publication."mode", publication."materializationStrategy",
          publication."historicDirtyFrom"::text AS "historicDirtyFrom",
          publication."historicDirtyThrough"::text AS "historicDirtyThrough",
          publication."historicMapCursor"::text AS "historicMapCursor",
          publication."historicStatsCursor"::text AS "historicStatsCursor",
          publication."sourceRevision", publication."historicComputeEpoch",
          publication."certifiedHistoryRepairId"::text
            AS "certifiedHistoryRepairId",
          publication."contentFingerprint",
          publication."firstDate"::text AS "firstDate",
          publication."latestDate"::text AS "latestDate",
          publication."dateCount", publication."areaCount",
          publication."departmentCount", publication."communeCount",
          publication."compressedByteLength"
            AS "publicationCompressedByteLength",
          publication."uncompressedByteLength"
            AS "publicationUncompressedByteLength",
          publication."readyAt", artifact."kind", artifact."rowCount",
          artifact."contentFingerprint" AS "artifactContentFingerprint",
          artifact."checksum", artifact."compressedByteLength",
          artifact."uncompressedByteLength", artifact."payload"
        FROM "statistic_cache_state" state
        JOIN "statistic_cache_publication" publication
          ON publication."id" = COALESCE($1::uuid, state."${stateColumn}")
        JOIN "statistic_cache_artifact" artifact
          ON artifact."publicationId" = publication."id"
        WHERE state."id" = 1
          AND publication."status" = $2::varchar
          AND publication."id" = state."${stateColumn}"
        ORDER BY artifact."kind"
      `,
      [publicationId, status],
    )) as ArtifactRow[];
    if (rows.length === 0) {
      return null;
    }
    if (
      rows.length !== STATISTIC_CACHE_ARTIFACT_KINDS.length ||
      new Set(rows.map(({ kind }) => kind)).size !==
        STATISTIC_CACHE_ARTIFACT_KINDS.length
    ) {
      throw new Error('Statistic cache publication has incomplete artifacts');
    }

    const first = rows[0];
    if (
      positiveInteger(first.schemaVersion, 'schema version') !==
      STATISTIC_CACHE_ARTIFACT_SCHEMA_VERSION
    ) {
      throw new Error('Unsupported statistic cache artifact schema version');
    }
    const identity: StatisticCacheArtifactIdentity = {
      id: String(first.id),
      statisticRevision: String(first.statisticRevision),
      currentPublishedDate: normalizeDate(first.currentPublishedDate)!,
      protocolVersion: positiveInteger(
        first.protocolVersion,
        'protocol version',
      ),
      mode: first.mode,
      materializationStrategy: first.materializationStrategy,
      historicDirtyFrom: normalizeDate(first.historicDirtyFrom),
      historicDirtyThrough: normalizeDate(first.historicDirtyThrough),
      historicMapCursor: normalizeDate(first.historicMapCursor),
      historicStatsCursor: normalizeDate(first.historicStatsCursor),
      sourceRevision:
        first.sourceRevision === null ? null : String(first.sourceRevision),
      historicComputeEpoch:
        first.historicComputeEpoch === null
          ? null
          : String(first.historicComputeEpoch),
      certifiedHistoryRepairId:
        first.certifiedHistoryRepairId === null
          ? null
          : String(first.certifiedHistoryRepairId),
      contentFingerprint: String(first.contentFingerprint),
      firstDate: normalizeDate(first.firstDate)!,
      latestDate: normalizeDate(first.latestDate)!,
      dateCount: positiveInteger(first.dateCount, 'date count'),
      areaCount: positiveInteger(first.areaCount, 'area count'),
      departmentCount: positiveInteger(
        first.departmentCount,
        'department count',
      ),
      communeCount: positiveInteger(first.communeCount, 'commune count'),
      readyAt:
        first.readyAt instanceof Date
          ? first.readyAt
          : new Date(String(first.readyAt)),
    };
    if (
      !/^\d+$/.test(identity.statisticRevision) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(identity.currentPublishedDate) ||
      identity.protocolVersion !== STATISTIC_CACHE_PROTOCOL_VERSION ||
      !/^[a-f0-9]{64}$/.test(identity.contentFingerprint) ||
      Number.isNaN(identity.readyAt.getTime())
    ) {
      throw new Error('Statistic cache publication identity is invalid');
    }

    const collections = new Map<StatisticCacheArtifactKind, ArtifactEnvelope>();
    const declaredTotalCompressedByteLength = rows.reduce(
      (total, row) =>
        total +
        positiveInteger(
          row.compressedByteLength,
          `${row.kind} compressed size`,
        ),
      0,
    );
    const declaredTotalUncompressedByteLength = rows.reduce(
      (total, row) =>
        total +
        positiveInteger(
          row.uncompressedByteLength,
          `${row.kind} uncompressed size`,
        ),
      0,
    );
    if (
      declaredTotalCompressedByteLength > MAX_TOTAL_COMPRESSED_ARTIFACT_BYTES ||
      declaredTotalUncompressedByteLength >
        MAX_TOTAL_UNCOMPRESSED_ARTIFACT_BYTES ||
      declaredTotalCompressedByteLength !==
        positiveInteger(
          first.publicationCompressedByteLength,
          'publication compressed size',
        ) ||
      declaredTotalUncompressedByteLength !==
        positiveInteger(
          first.publicationUncompressedByteLength,
          'publication uncompressed size',
        )
    ) {
      throw new Error('Statistic cache publication sizes are invalid');
    }
    let totalCompressedByteLength = 0;
    let totalUncompressedByteLength = 0;
    for (const row of rows) {
      if (!STATISTIC_CACHE_ARTIFACT_KINDS.includes(row.kind)) {
        throw new Error(`Unsupported statistic cache artifact ${row.kind}`);
      }
      const compressed = Buffer.from(row.payload);
      const compressedByteLength = positiveInteger(
        row.compressedByteLength,
        `${row.kind} compressed size`,
      );
      const uncompressedByteLength = positiveInteger(
        row.uncompressedByteLength,
        `${row.kind} uncompressed size`,
      );
      totalCompressedByteLength += compressedByteLength;
      totalUncompressedByteLength += uncompressedByteLength;
      if (
        compressed.length !== compressedByteLength ||
        compressed.length > MAX_COMPRESSED_ARTIFACT_BYTES ||
        uncompressedByteLength > MAX_UNCOMPRESSED_ARTIFACT_BYTES ||
        sha256(compressed) !== row.checksum
      ) {
        throw new Error(`Statistic cache artifact ${row.kind} is invalid`);
      }
      const uncompressed = gunzipSync(compressed, {
        maxOutputLength: Math.max(1, uncompressedByteLength),
      });
      if (
        uncompressed.length !== uncompressedByteLength ||
        sha256(uncompressed) !== row.artifactContentFingerprint
      ) {
        throw new Error(
          `Statistic cache artifact ${row.kind} has invalid decoded content`,
        );
      }
      const decoded = JSON.parse(
        uncompressed.toString('utf8'),
      ) as ArtifactEnvelope;
      if (
        decoded?.schemaVersion !== STATISTIC_CACHE_ARTIFACT_SCHEMA_VERSION ||
        decoded.kind !== row.kind ||
        !Array.isArray(decoded.data) ||
        decoded.data.length !==
          positiveInteger(row.rowCount, `${row.kind} rows`)
      ) {
        throw new Error(
          `Statistic cache artifact ${row.kind} has an invalid envelope`,
        );
      }
      collections.set(row.kind, decoded);
    }
    if (
      totalCompressedByteLength > MAX_TOTAL_COMPRESSED_ARTIFACT_BYTES ||
      totalUncompressedByteLength > MAX_TOTAL_UNCOMPRESSED_ARTIFACT_BYTES ||
      totalCompressedByteLength !==
        positiveInteger(
          first.publicationCompressedByteLength,
          'publication compressed size',
        ) ||
      totalUncompressedByteLength !==
        positiveInteger(
          first.publicationUncompressedByteLength,
          'publication uncompressed size',
        )
    ) {
      throw new Error('Statistic cache publication sizes are invalid');
    }

    const area = collections.get('area')!;
    const departement = collections.get('departement')!;
    const commune = collections.get('commune')!;
    const latestCommuneWeights = commune.latestCommuneWeights;
    if (
      area.data.length !== identity.areaCount ||
      departement.data.length !== identity.dateCount ||
      commune.data.length !== identity.communeCount ||
      !Array.isArray(latestCommuneWeights) ||
      latestCommuneWeights.length !== identity.communeCount ||
      latestCommuneWeights.some(
        (entry) =>
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== 'string' ||
          typeof entry[1] !== 'number' ||
          !Number.isFinite(entry[1]),
      )
    ) {
      throw new Error('Statistic cache publication counts are invalid');
    }
    return {
      identity,
      dataArea: area.data,
      dataDepartement: departement.data,
      dataCommune: commune.data,
      latestCommuneWeights,
    };
  }

  async materialize(
    target: StatisticCacheMaterializationTarget,
    candidateFactory: (
      manager: EntityManager,
    ) => Promise<StatisticCacheArtifactCandidate>,
  ): Promise<StatisticCacheArtifactPayload> {
    const activeBeforeLock = await this.loadActive();
    if (hasMaterializationTarget(activeBeforeLock, target)) {
      await this.garbageCollectPublications(this.dataSource);
      return activeBeforeLock;
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    let locked = false;
    let transactionStarted = false;
    let primaryError: unknown = null;
    try {
      const [lock] = await queryRunner.query(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [MATERIALIZATION_LOCK],
      );
      locked = lock?.locked === true;
      if (!locked) {
        const published = await this.waitForActivePublication(target);
        await this.garbageCollectPublications(queryRunner.manager);
        return published;
      }

      const activeAfterLock = await this.loadActive(queryRunner.manager);
      if (hasMaterializationTarget(activeAfterLock, target)) {
        await this.garbageCollectPublications(queryRunner.manager);
        return activeAfterLock;
      }
      await queryRunner.startTransaction('REPEATABLE READ');
      transactionStarted = true;
      const candidate = await candidateFactory(queryRunner.manager);
      if (!candidateMatchesTarget(candidate, target)) {
        throw new Error('Statistic cache candidate does not match its target');
      }
      const publicationId = randomUUID();
      const artifacts = this.encodeArtifacts(candidate);
      await this.persistPublication(
        queryRunner.manager,
        publicationId,
        candidate,
        artifacts,
      );
      await queryRunner.commitTransaction();
      transactionStarted = false;
      await this.garbageCollectPublications(queryRunner.manager);
      const published = await this.loadPublication(publicationId);
      if (!published) {
        throw new Error(
          `Statistic cache publication ${publicationId} was not persisted`,
        );
      }
      return published;
    } catch (error) {
      const normalizedError = normalizeMaterializationError(error);
      primaryError = normalizedError;
      throw normalizedError;
    } finally {
      await this.cleanupMaterializationSession(
        queryRunner,
        transactionStarted,
        [
          ...(locked
            ? [
                {
                  sql: 'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked',
                  parameters: [MATERIALIZATION_LOCK],
                },
              ]
            : []),
        ],
        primaryError,
      );
    }
  }

  async stageCandidate(
    target: StatisticCacheCandidateTarget,
    candidateFactory: (
      manager: EntityManager,
    ) => Promise<StatisticCacheArtifactCandidate>,
    options: StatisticCacheCandidateStageOptions = {},
  ): Promise<StatisticCacheArtifactIdentity> {
    const activeBeforeLock = await this.loadActiveIdentity();
    if (hasReusableCandidateIdentity(activeBeforeLock, target, options)) {
      await this.garbageCollectPublications(this.dataSource);
      return activeBeforeLock;
    }
    const candidateBeforeLock = await this.loadCandidateIdentity();
    if (hasReusableCandidateIdentity(candidateBeforeLock, target, options)) {
      await this.garbageCollectPublications(this.dataSource);
      return candidateBeforeLock;
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    let locked = false;
    let transactionStarted = false;
    let primaryError: unknown = null;
    try {
      const [lock] = await queryRunner.query(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [MATERIALIZATION_LOCK],
      );
      locked = lock?.locked === true;
      if (!locked) {
        const staged = await this.waitForCandidateIdentity(target, options);
        await this.garbageCollectPublications(queryRunner.manager);
        return staged;
      }

      const activeAfterLock = await this.loadActiveIdentity(
        queryRunner.manager,
      );
      if (hasReusableCandidateIdentity(activeAfterLock, target, options)) {
        await this.garbageCollectPublications(queryRunner.manager);
        return activeAfterLock;
      }
      const candidateAfterLock = await this.loadCandidateIdentity(
        queryRunner.manager,
      );
      if (hasReusableCandidateIdentity(candidateAfterLock, target, options)) {
        await this.garbageCollectPublications(queryRunner.manager);
        return candidateAfterLock;
      }

      await queryRunner.startTransaction('REPEATABLE READ');
      transactionStarted = true;
      const candidate = await candidateFactory(queryRunner.manager);
      if (!candidateMatchesTarget(candidate, target)) {
        throw new Error('Statistic cache candidate does not match its target');
      }
      if (!hasRequiredCandidateCoverage(candidate, options)) {
        throw new Error(
          'Statistic cache candidate does not preserve required history',
        );
      }
      const publicationId = randomUUID();
      const artifacts = this.encodeArtifacts(candidate);
      await this.persistPublication(
        queryRunner.manager,
        publicationId,
        candidate,
        artifacts,
        'candidate',
      );
      await queryRunner.commitTransaction();
      transactionStarted = false;
      await this.garbageCollectPublications(queryRunner.manager);
      const staged = await this.loadCandidateIdentity();
      if (!staged || staged.id !== publicationId) {
        throw new Error(
          `Statistic cache candidate ${publicationId} was not persisted`,
        );
      }
      return staged;
    } catch (error) {
      const normalizedError = normalizeMaterializationError(error);
      primaryError = normalizedError;
      throw normalizedError;
    } finally {
      await this.cleanupMaterializationSession(
        queryRunner,
        transactionStarted,
        [
          ...(locked
            ? [
                {
                  sql: 'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked',
                  parameters: [MATERIALIZATION_LOCK],
                },
              ]
            : []),
        ],
        primaryError,
      );
    }
  }

  async activateCandidate(
    target: StatisticCacheCandidateTarget,
    requiredAcknowledgements: number,
    instanceLeaseSeconds: number,
  ): Promise<StatisticCacheCandidateActivationResult> {
    const sourceRevisionSql = statisticSourceRevisionSql('source_state');
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    let locked = false;
    let transactionStarted = false;
    let primaryError: unknown = null;
    let liveInstances = 0;
    let readyInstances = 0;
    try {
      const [lock] = await queryRunner.query(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [MATERIALIZATION_LOCK],
      );
      locked = lock?.locked === true;
      if (!locked) {
        await this.garbageCollectPublications(queryRunner.manager);
        return {
          outcome: 'retry',
          reason: 'materialization-lock-busy',
          liveInstances,
          readyInstances,
        };
      }
      await queryRunner.startTransaction('SERIALIZABLE');
      transactionStarted = true;
      const [state] = await queryRunner.query(
        `
          SELECT
            cache_state."activePublicationId",
            cache_state."candidatePublicationId",
            publication."status", publication."statisticRevision"::text,
            publication."currentPublishedDate"::text,
            publication."protocolVersion",
            publication."historicDirtyFrom"::text,
            publication."historicDirtyThrough"::text,
            publication."historicMapCursor"::text,
            publication."historicStatsCursor"::text,
            publication."sourceRevision"::text,
            publication."historicComputeEpoch"::text,
            publication."certifiedHistoryRepairId"::text,
            statistic_state."revision"::text AS "availableRevision",
            statistic_state."currentPublishedDate"::text
              AS "availablePublishedDate",
            statistic_state."historicDirtyFrom"::text
              AS "availableHistoricDirtyFrom",
            statistic_state."historicDirtyThrough"::text
              AS "availableHistoricDirtyThrough",
            config."computeMapDate"::text AS "availableHistoricMapCursor",
            config."computeStatsDate"::text AS "availableHistoricStatsCursor",
            config."historicComputeEpoch"::text
              AS "availableHistoricComputeEpoch",
            ${sourceRevisionSql}::text AS "availableSourceRevision",
            (SELECT COUNT(*)::integer FROM "current_zone_recompute_request")
              AS "pendingCurrentQueueCount",
            EXISTS (
              SELECT 1
              FROM "statistic_commune_snapshot" snapshot
              WHERE snapshot."snapshotDate" =
                  statistic_state."currentPublishedDate"
                AND snapshot."scope" = 'national'
                AND snapshot."status" = 'completed'
                AND snapshot."processedCommuneCount" =
                  snapshot."expectedCommuneCount"
                AND snapshot."sourceRevision" IS NOT DISTINCT FROM
                  ${sourceRevisionSql}
            ) AS "currentSnapshotCertified",
            (
              (
                publication."materializationStrategy" <>
                    'certified-history-overlay'
                AND publication."certifiedHistoryRepairId" IS NULL
              ) OR (
                publication."materializationStrategy" =
                    'certified-history-overlay'
                AND publication."certifiedHistoryRepairId" IS NOT NULL
                AND EXISTS (
                SELECT 1
                FROM "active_certified_history_repair" repair
                WHERE repair.id = publication."certifiedHistoryRepairId"
                  AND repair."activationKind" = 'statistics-only'
                  AND repair."dateFrom" =
                      statistic_state."historicDirtyFrom"
                  AND repair."dateThrough" =
                      statistic_state."historicDirtyThrough"
                  AND repair."publicationRevisionAfter" <=
                      statistic_state.revision
                  AND NOT EXISTS (
                    SELECT 1
                    FROM generate_series(
                      repair."dateFrom", repair."dateThrough",
                      '1 day'::interval
                    ) repaired_day(value)
                    WHERE NOT EXISTS (
                      SELECT 1
                      FROM "statistic_commune_snapshot" certified_snapshot
                      WHERE certified_snapshot."snapshotDate" =
                            repaired_day.value::date
                        AND certified_snapshot.scope = 'national'
                        AND certified_snapshot.status = 'completed'
                        AND certified_snapshot."expectedCommuneCount" =
                            repair."communeCount"
                        AND certified_snapshot."processedCommuneCount" =
                            repair."communeCount"
                        AND certified_snapshot."sourceRevision" IS NULL
                        AND certified_snapshot."certifiedHistoryRepairId" =
                            repair.id
                    )
                  )
                )
              )
            ) AS "certifiedRepairCoverageValid",
            (
              SELECT COUNT(*)::integer
              FROM "statistic_commune_snapshot" snapshot
              WHERE snapshot."scope" = 'bootstrap'
                 OR (
                   snapshot."scope" <> 'bootstrap'
                   AND snapshot."snapshotDate" BETWEEN
                     CASE
                       WHEN publication."materializationStrategy" =
                            'certified-history-overlay'
                         THEN publication."firstDate"
                       ELSE statistic_state."currentPublishedDate"
                     END
                     AND statistic_state."currentPublishedDate"
                   AND (
                     snapshot."status" <> 'completed'
                     OR snapshot."processedCommuneCount" <>
                        snapshot."expectedCommuneCount"
                     OR (
                       snapshot."snapshotDate" =
                           statistic_state."currentPublishedDate"
                       AND snapshot."sourceRevision" IS DISTINCT FROM
                           ${sourceRevisionSql}
                     )
                   )
                )
            ) AS "invalidSnapshotCount"
          FROM "statistic_cache_state" cache_state
          JOIN "statistic_cache_publication" publication
            ON publication."id" = cache_state."candidatePublicationId"
          CROSS JOIN "statistic_publication_state" statistic_state
          CROSS JOIN "config" config
          CROSS JOIN "zone_publication_source_state" source_state
          WHERE cache_state."id" = 1
            AND statistic_state."id" = 1
            AND config."id" = 1
            AND source_state."id" = 1
          FOR UPDATE OF cache_state, publication, statistic_state, config,
            source_state
        `,
      );
      const candidateId = state?.candidatePublicationId
        ? String(state.candidatePublicationId)
        : null;
      if (!candidateId || state?.status !== 'ready') {
        await queryRunner.commitTransaction();
        transactionStarted = false;
        await this.garbageCollectPublications(queryRunner.manager);
        return {
          outcome: 'superseded',
          reason: 'candidate-is-no-longer-ready',
          liveInstances,
          readyInstances,
        };
      }
      const boundaryMatches =
        String(state.statisticRevision) === target.statisticRevision &&
        normalizeDate(state.currentPublishedDate) ===
          target.currentPublishedDate &&
        Number(state.protocolVersion) === target.protocolVersion &&
        normalizeDate(state.historicDirtyFrom) === target.historicDirtyFrom &&
        normalizeDate(state.historicDirtyThrough) ===
          target.historicDirtyThrough &&
        normalizeDate(state.historicMapCursor) === target.historicMapCursor &&
        normalizeDate(state.historicStatsCursor) ===
          target.historicStatsCursor &&
        String(state.sourceRevision ?? '') ===
          String(target.sourceRevision ?? '') &&
        String(state.historicComputeEpoch ?? '') ===
          String(target.historicComputeEpoch ?? '') &&
        String(state.certifiedHistoryRepairId ?? '') ===
          String(target.certifiedHistoryRepairId ?? '') &&
        String(state.availableRevision) === target.statisticRevision &&
        normalizeDate(state.availablePublishedDate) ===
          target.currentPublishedDate &&
        normalizeDate(state.availableHistoricDirtyFrom) ===
          target.historicDirtyFrom &&
        normalizeDate(state.availableHistoricDirtyThrough) ===
          target.historicDirtyThrough &&
        normalizeDate(state.availableHistoricMapCursor) ===
          target.historicMapCursor &&
        normalizeDate(state.availableHistoricStatsCursor) ===
          target.historicStatsCursor &&
        String(state.availableSourceRevision ?? '') ===
          String(target.sourceRevision ?? '') &&
        String(state.availableHistoricComputeEpoch ?? '') ===
          String(target.historicComputeEpoch ?? '') &&
        Number(state.pendingCurrentQueueCount) === 0 &&
        state.currentSnapshotCertified === true &&
        state.certifiedRepairCoverageValid === true &&
        Number(state.invalidSnapshotCount) === 0;
      if (!boundaryMatches) {
        await this.discardCandidate(queryRunner.manager, candidateId);
        await queryRunner.commitTransaction();
        transactionStarted = false;
        await this.garbageCollectPublications(queryRunner.manager);
        return {
          outcome: 'superseded',
          reason: 'publication-boundary-changed',
          liveInstances,
          readyInstances,
        };
      }

      const [acknowledgements] = await queryRunner.query(
        `
          SELECT
            COUNT(*)::integer AS "liveInstances",
            COUNT(*) FILTER (
              WHERE instance."candidateStatisticCachePublicationId" = $1::uuid
                AND instance."candidateStatisticRevision" = $2::bigint
                AND instance."candidateStatisticPublishedDate" = $3::date
                AND instance."candidateStatisticSourceRevision"
                  IS NOT DISTINCT FROM $4::bigint
                AND instance."candidateStatisticFingerprint" =
                  publication."contentFingerprint"
                AND instance."candidateStatisticProtocolVersion" = $5::integer
                AND instance."candidateStatisticLastError" IS NULL
            )::integer AS "readyInstances"
          FROM "zone_publication_instance" instance
          CROSS JOIN "statistic_cache_publication" publication
          WHERE instance."heartbeatAt" >=
            now() - ($6::integer * interval '1 second')
            AND publication."id" = $1::uuid
        `,
        [
          candidateId,
          target.statisticRevision,
          target.currentPublishedDate,
          target.sourceRevision,
          target.protocolVersion,
          instanceLeaseSeconds,
        ],
      );
      liveInstances = positiveInteger(
        acknowledgements?.liveInstances,
        'live instance count',
      );
      readyInstances = positiveInteger(
        acknowledgements?.readyInstances,
        'ready instance count',
      );
      if (readyInstances < requiredAcknowledgements) {
        await queryRunner.commitTransaction();
        transactionStarted = false;
        await this.garbageCollectPublications(queryRunner.manager);
        return {
          outcome: 'awaiting-acknowledgements',
          reason: `${readyInstances}/${requiredAcknowledgements}-acknowledgements`,
          liveInstances,
          readyInstances,
        };
      }

      const previousActiveId = state.activePublicationId
        ? String(state.activePublicationId)
        : null;
      if (previousActiveId && previousActiveId !== candidateId) {
        await queryRunner.query(
          `
            UPDATE "statistic_cache_publication"
            SET "status" = 'retired', "retiredAt" = now()
            WHERE "id" = $1::uuid AND "status" = 'active'
          `,
          [previousActiveId],
        );
      }
      await queryRunner.query(
        `
          UPDATE "statistic_cache_publication"
          SET "status" = 'active', "activatedAt" = now()
          WHERE "id" = $1::uuid AND "status" = 'ready'
        `,
        [candidateId],
      );
      await queryRunner.query(
        `
          UPDATE "statistic_cache_state"
          SET "activePublicationId" = $1::uuid,
              "previousPublicationId" = $2::uuid,
              "candidatePublicationId" = NULL,
              "updatedAt" = now()
          WHERE "id" = 1 AND "candidatePublicationId" = $1::uuid
        `,
        [candidateId, previousActiveId],
      );
      await queryRunner.commitTransaction();
      transactionStarted = false;
      await this.garbageCollectPublications(queryRunner.manager);
      const publication = await this.loadActiveIdentity();
      if (!publication || publication.id !== candidateId) {
        throw new Error(
          `Activated statistic cache ${candidateId} cannot be loaded`,
        );
      }
      return {
        outcome: 'activated',
        publication,
        liveInstances,
        readyInstances,
      };
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await this.cleanupMaterializationSession(
        queryRunner,
        transactionStarted,
        locked
          ? [
              {
                sql: 'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked',
                parameters: [MATERIALIZATION_LOCK],
              },
            ]
          : [],
        primaryError,
      );
    }
  }

  async rollbackToPrevious(
    guard: StatisticCacheRollbackGuard,
  ): Promise<StatisticCacheArtifactPayload> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    let locked = false;
    let transactionStarted = false;
    let primaryError: unknown = null;
    try {
      locked = await this.waitForLock(
        queryRunner,
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [MATERIALIZATION_LOCK],
      );
      await queryRunner.startTransaction('SERIALIZABLE');
      transactionStarted = true;
      const [state] = await queryRunner.query(
        `
          SELECT
            state."activePublicationId", state."previousPublicationId",
            active."status" AS "activeStatus",
            previous."status" AS "previousStatus"
          FROM "statistic_cache_state" state
          JOIN "statistic_cache_publication" active
            ON active."id" = state."activePublicationId"
          JOIN "statistic_cache_publication" previous
            ON previous."id" = state."previousPublicationId"
          WHERE state."id" = 1
          FOR UPDATE OF state, active, previous
        `,
      );
      const alreadyRolledBack =
        String(state?.activePublicationId ?? '') ===
          guard.previousPublicationId &&
        String(state?.previousPublicationId ?? '') ===
          guard.activePublicationId &&
        state?.activeStatus === 'active' &&
        state?.previousStatus === 'retired';
      if (alreadyRolledBack) {
        await queryRunner.commitTransaction();
        transactionStarted = false;
        const restored = await this.loadPublication(
          guard.previousPublicationId,
        );
        if (!restored) {
          throw new Error(
            `Rolled back statistic cache publication ${guard.previousPublicationId} cannot be loaded`,
          );
        }
        return restored;
      }
      if (
        String(state?.activePublicationId ?? '') !==
          guard.activePublicationId ||
        String(state?.previousPublicationId ?? '') !==
          guard.previousPublicationId ||
        state?.activeStatus !== 'active' ||
        state?.previousStatus !== 'retired'
      ) {
        throw new Error(
          'Statistic cache rollback guard no longer matches active/previous state',
        );
      }

      await queryRunner.query(
        `
          UPDATE "statistic_cache_publication"
          SET "status" = 'retired', "retiredAt" = now()
          WHERE "id" = $1::uuid AND "status" = 'active'
        `,
        [guard.activePublicationId],
      );
      await queryRunner.query(
        `
          UPDATE "statistic_cache_publication"
          SET "status" = 'active', "activatedAt" = now(), "retiredAt" = NULL
          WHERE "id" = $1::uuid AND "status" = 'retired'
        `,
        [guard.previousPublicationId],
      );
      await queryRunner.query(
        `
          UPDATE "statistic_cache_state"
          SET "activePublicationId" = $1::uuid,
              "previousPublicationId" = $2::uuid,
              "updatedAt" = now()
          WHERE "id" = 1
        `,
        [guard.previousPublicationId, guard.activePublicationId],
      );
      await queryRunner.commitTransaction();
      transactionStarted = false;
      const restored = await this.loadPublication(guard.previousPublicationId);
      if (!restored) {
        throw new Error(
          `Rolled back statistic cache publication ${guard.previousPublicationId} cannot be loaded`,
        );
      }
      return restored;
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await this.cleanupMaterializationSession(
        queryRunner,
        transactionStarted,
        locked
          ? [
              {
                sql: 'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked',
                parameters: [MATERIALIZATION_LOCK],
              },
            ]
          : [],
        primaryError,
      );
    }
  }

  private async cleanupMaterializationSession(
    queryRunner: QueryRunner,
    transactionStarted: boolean,
    unlocks: Array<{ sql: string; parameters: any[] }>,
    primaryError: unknown,
  ): Promise<void> {
    const cleanupErrors: unknown[] = [];
    if (transactionStarted) {
      try {
        await queryRunner.rollbackTransaction();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    let advisoryCleanupFailed = false;
    for (const unlock of unlocks) {
      try {
        const [result] = await queryRunner.query(unlock.sql, unlock.parameters);
        if (result?.unlocked !== true) {
          throw new Error('PostgreSQL advisory lock was not released');
        }
      } catch (error) {
        advisoryCleanupFailed = true;
        cleanupErrors.push(error);
      }
    }
    if (advisoryCleanupFailed) {
      try {
        await queryRunner.query('SELECT pg_advisory_unlock_all()');
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await queryRunner.release();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0 && primaryError === null) {
      throw new AggregateError(
        cleanupErrors,
        'Failed to clean up statistic cache materialization session',
      );
    }
  }

  private async waitForLock(
    queryRunner: { query: (sql: string, parameters?: any[]) => Promise<any[]> },
    sql: string,
    parameters: any[] = [],
  ): Promise<boolean> {
    const deadline = Date.now() + MATERIALIZATION_WAIT_MS;
    while (Date.now() < deadline) {
      const [result] = await queryRunner.query(sql, parameters);
      if (result?.locked === true) {
        return true;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, MATERIALIZATION_POLL_MS),
      );
    }
    throw new Error('Timed out waiting for a safe statistic cache boundary');
  }

  private encodeArtifacts(
    candidate: StatisticCacheArtifactCandidate,
  ): EncodedArtifact[] {
    const envelopes: Record<StatisticCacheArtifactKind, ArtifactEnvelope> = {
      area: {
        schemaVersion: STATISTIC_CACHE_ARTIFACT_SCHEMA_VERSION,
        kind: 'area',
        data: candidate.dataArea,
      },
      departement: {
        schemaVersion: STATISTIC_CACHE_ARTIFACT_SCHEMA_VERSION,
        kind: 'departement',
        data: candidate.dataDepartement,
      },
      commune: {
        schemaVersion: STATISTIC_CACHE_ARTIFACT_SCHEMA_VERSION,
        kind: 'commune',
        data: candidate.dataCommune,
        latestCommuneWeights: candidate.latestCommuneWeights,
      },
    };
    let totalCompressedByteLength = 0;
    let totalUncompressedByteLength = 0;
    const artifacts = STATISTIC_CACHE_ARTIFACT_KINDS.map((kind) => {
      const uncompressed = Buffer.from(JSON.stringify(envelopes[kind]));
      const payload = gzipSync(uncompressed, { level: 9 });
      totalCompressedByteLength += payload.length;
      totalUncompressedByteLength += uncompressed.length;
      if (
        payload.length > MAX_COMPRESSED_ARTIFACT_BYTES ||
        uncompressed.length > MAX_UNCOMPRESSED_ARTIFACT_BYTES
      ) {
        throw new Error(`Statistic cache artifact ${kind} exceeds size limits`);
      }
      return {
        kind,
        rowCount: envelopes[kind].data.length,
        contentFingerprint: sha256(uncompressed),
        checksum: sha256(payload),
        compressedByteLength: payload.length,
        uncompressedByteLength: uncompressed.length,
        payload,
      };
    });
    if (
      totalCompressedByteLength > MAX_TOTAL_COMPRESSED_ARTIFACT_BYTES ||
      totalUncompressedByteLength > MAX_TOTAL_UNCOMPRESSED_ARTIFACT_BYTES
    ) {
      throw new Error('Statistic cache publication exceeds size limits');
    }
    return artifacts;
  }

  private async persistPublication(
    manager: EntityManager,
    publicationId: string,
    candidate: StatisticCacheArtifactCandidate,
    artifacts: EncodedArtifact[],
    activationMode: 'immediate' | 'candidate' = 'immediate',
  ): Promise<void> {
    const sourceRevisionSql = statisticSourceRevisionSql('source_state');
    const [publicationState] = await manager.query(
      `
        WITH source_guard AS MATERIALIZED (
          SELECT ${sourceRevisionSql}::text AS "sourceRevision"
          FROM "zone_publication_source_state" source_state
          WHERE source_state."id" = 1
          FOR UPDATE OF source_state
        ), config_guard AS MATERIALIZED (
          SELECT
            config."computeMapDate"::text AS "historicMapCursor",
            config."computeStatsDate"::text AS "historicStatsCursor",
            config."historicComputeEpoch"::text AS "historicComputeEpoch"
          FROM "config" config
          CROSS JOIN source_guard
          WHERE config."id" = 1
          FOR UPDATE OF config
        ), publication_guard AS MATERIALIZED (
          SELECT
            statistic_state."revision"::text AS "revision",
            statistic_state."currentPublishedDate"::text
              AS "currentPublishedDate",
            statistic_state."historicDirtyFrom"::text AS "historicDirtyFrom",
            statistic_state."historicDirtyThrough"::text AS "historicDirtyThrough",
            statistic_state."historicPublishedThrough"::text
              AS "historicPublishedThrough",
            config_guard."historicMapCursor",
            config_guard."historicStatsCursor",
            config_guard."historicComputeEpoch",
            source_guard."sourceRevision",
            (
              NOT $6::boolean
              OR $5::varchar <> 'legacy-bootstrap'
              OR (
                statistic_state."historicDirtyFrom" IS NOT NULL
                AND statistic_state."historicDirtyThrough" >=
                    ($2::date - interval '1 day')::date
              )
              OR (
                statistic_state."historicDirtyFrom" IS NULL
                AND statistic_state."historicDirtyThrough" IS NULL
                AND statistic_state."historicPublishedThrough" >=
                    ($2::date - interval '1 day')::date
                AND config_guard."historicMapCursor"::date >=
                    ($2::date - interval '1 day')::date
                AND config_guard."historicStatsCursor"::date >=
                    ($2::date - interval '1 day')::date
              )
            ) AS "legacyBoundaryEligible",
            (SELECT COUNT(*)::integer FROM "current_zone_recompute_request")
              AS "pendingCurrentQueueCount",
            EXISTS (
              SELECT 1
              FROM "statistic_commune_snapshot" snapshot
              WHERE snapshot."snapshotDate" =
                  statistic_state."currentPublishedDate"
                AND snapshot."scope" = 'national'
                AND snapshot."status" = 'completed'
                AND snapshot."processedCommuneCount" =
                  snapshot."expectedCommuneCount"
                AND snapshot."sourceRevision" IS NOT DISTINCT FROM
                  source_guard."sourceRevision"::bigint
            ) AS "currentSnapshotCertified",
            (
              (
                $4::varchar <> 'certified-history-overlay'
                AND $7::uuid IS NULL
              ) OR (
                $4::varchar = 'certified-history-overlay'
                AND $7::uuid IS NOT NULL
                AND EXISTS (
                SELECT 1
                FROM "active_certified_history_repair" repair
                WHERE repair.id = $7::uuid
                  AND repair."activationKind" = 'statistics-only'
                  AND repair."dateFrom" =
                      statistic_state."historicDirtyFrom"
                  AND repair."dateThrough" =
                      statistic_state."historicDirtyThrough"
                  AND repair."publicationRevisionAfter" <=
                      statistic_state.revision
                  AND NOT EXISTS (
                    SELECT 1
                    FROM generate_series(
                      repair."dateFrom", repair."dateThrough",
                      '1 day'::interval
                    ) repaired_day(value)
                    WHERE NOT EXISTS (
                      SELECT 1
                      FROM "statistic_commune_snapshot" certified_snapshot
                      WHERE certified_snapshot."snapshotDate" =
                            repaired_day.value::date
                        AND certified_snapshot.scope = 'national'
                        AND certified_snapshot.status = 'completed'
                        AND certified_snapshot."expectedCommuneCount" =
                            repair."communeCount"
                        AND certified_snapshot."processedCommuneCount" =
                            repair."communeCount"
                        AND certified_snapshot."sourceRevision" IS NULL
                        AND certified_snapshot."certifiedHistoryRepairId" =
                            repair.id
                    )
                  )
                )
              )
            ) AS "certifiedRepairCoverageValid",
            (
              SELECT COUNT(*)::integer
              FROM "statistic_commune_snapshot" snapshot
              WHERE snapshot."scope" = 'bootstrap'
                 OR (
                   snapshot."scope" <> 'bootstrap'
                   AND
                   snapshot."snapshotDate" BETWEEN
                     CASE
                       WHEN $4::varchar IN (
                         'daily-delta', 'current-replace', 'sparse-current'
                       )
                         THEN $2::date
                       ELSE $3::date
                     END
                     AND $2::date
                   AND (
                     snapshot."status" <> 'completed'
                     OR snapshot."processedCommuneCount" <>
                        snapshot."expectedCommuneCount"
                   )
                 )
            ) AS "invalidSnapshotCount"
          FROM "statistic_publication_state" statistic_state
          CROSS JOIN config_guard
          CROSS JOIN source_guard
          WHERE statistic_state."id" = 1
            AND statistic_state."revision" = $1::bigint
          FOR UPDATE OF statistic_state
        )
        SELECT * FROM publication_guard
        `,
      [
        candidate.statisticRevision,
        candidate.currentPublishedDate,
        candidate.firstDate,
        candidate.materializationStrategy,
        candidate.mode,
        isPreparedLegacyBoundaryRequired(),
        candidate.certifiedHistoryRepairId,
      ],
    );
    if (
      String(publicationState?.revision) !== candidate.statisticRevision ||
      normalizeDate(publicationState?.currentPublishedDate) !==
        candidate.currentPublishedDate
    ) {
      throw new Error(
        'Statistic publication state changed during cache materialization',
      );
    }
    const auditMatches =
      normalizeDate(publicationState?.historicDirtyFrom) ===
        candidate.historicDirtyFrom &&
      normalizeDate(publicationState?.historicDirtyThrough) ===
        candidate.historicDirtyThrough &&
      normalizeDate(publicationState?.historicMapCursor) ===
        candidate.historicMapCursor &&
      normalizeDate(publicationState?.historicStatsCursor) ===
        candidate.historicStatsCursor &&
      String(publicationState?.sourceRevision ?? '') ===
        String(candidate.sourceRevision ?? '') &&
      String(publicationState?.historicComputeEpoch ?? '') ===
        String(candidate.historicComputeEpoch ?? '');
    if (
      !auditMatches ||
      publicationState?.legacyBoundaryEligible !== true ||
      Number(publicationState?.pendingCurrentQueueCount ?? -1) !== 0 ||
      publicationState?.currentSnapshotCertified !== true ||
      publicationState?.certifiedRepairCoverageValid !== true ||
      Number(publicationState?.invalidSnapshotCount ?? -1) !== 0
    ) {
      throw new Error(
        'Statistic materialization boundary changed before activation',
      );
    }
    const [cacheState] = await manager.query(
      `
          SELECT "activePublicationId", "candidatePublicationId",
            "historicRecoveryMonthlyFrom"
          FROM "statistic_cache_state"
          WHERE "id" = 1
          FOR UPDATE
        `,
    );
    if (cacheState?.historicRecoveryMonthlyFrom) {
      throw new Error(
        `Statistic monthly recovery is pending from ${normalizeDate(cacheState.historicRecoveryMonthlyFrom)}`,
      );
    }
    const totalCompressedByteLength = artifacts.reduce(
      (total, artifact) => total + artifact.compressedByteLength,
      0,
    );
    const totalUncompressedByteLength = artifacts.reduce(
      (total, artifact) => total + artifact.uncompressedByteLength,
      0,
    );
    await manager.query(
      `
          DELETE FROM "statistic_cache_publication"
          WHERE "statisticRevision" = $1::bigint
            AND "currentPublishedDate" = $2::date
            AND "status" IN ('building', 'failed')
        `,
      [candidate.statisticRevision, candidate.currentPublishedDate],
    );
    await manager.query(
      `
          INSERT INTO "statistic_cache_publication" (
            "id", "statisticRevision", "currentPublishedDate", "mode",
            "materializationStrategy", "historicDirtyFrom",
            "historicDirtyThrough", "historicMapCursor", "historicStatsCursor",
            "sourceRevision", "historicComputeEpoch", "schemaVersion",
            "protocolVersion", "status",
            "contentFingerprint", "firstDate", "latestDate", "dateCount",
            "areaCount", "departmentCount", "communeCount",
            "compressedByteLength", "uncompressedByteLength",
            "certifiedHistoryRepairId"
          ) VALUES (
            $1::uuid, $2::bigint, $3::date, $4, $5, $6::date, $7::date,
            $8::date, $9::date, $10::bigint, $11::bigint, $12, $13, 'building',
            $14, $15::date, $16::date, $17, $18, $19, $20, $21, $22,
            $23::uuid
          )
        `,
      [
        publicationId,
        candidate.statisticRevision,
        candidate.currentPublishedDate,
        candidate.mode,
        candidate.materializationStrategy,
        candidate.historicDirtyFrom,
        candidate.historicDirtyThrough,
        candidate.historicMapCursor,
        candidate.historicStatsCursor,
        candidate.sourceRevision,
        candidate.historicComputeEpoch,
        STATISTIC_CACHE_ARTIFACT_SCHEMA_VERSION,
        STATISTIC_CACHE_PROTOCOL_VERSION,
        candidate.contentFingerprint,
        candidate.firstDate,
        candidate.latestDate,
        candidate.dateCount,
        candidate.dataArea.length,
        candidate.departmentCount,
        candidate.communeCount,
        totalCompressedByteLength,
        totalUncompressedByteLength,
        candidate.certifiedHistoryRepairId,
      ],
    );
    for (const artifact of artifacts) {
      await manager.query(
        `
            INSERT INTO "statistic_cache_artifact" (
              "publicationId", "kind", "rowCount", "contentFingerprint",
              "checksum", "compressedByteLength", "uncompressedByteLength",
              "payload"
            ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::bytea)
          `,
        [
          publicationId,
          artifact.kind,
          artifact.rowCount,
          artifact.contentFingerprint,
          artifact.checksum,
          artifact.compressedByteLength,
          artifact.uncompressedByteLength,
          artifact.payload,
        ],
      );
    }
    await manager.query(
      `
          UPDATE "statistic_cache_publication"
          SET "status" = 'ready', "readyAt" = now()
          WHERE "id" = $1::uuid AND "status" = 'building'
        `,
      [publicationId],
    );
    if (activationMode === 'candidate') {
      await manager.query(
        `
          UPDATE "statistic_cache_state"
          SET "candidatePublicationId" = $1::uuid, "updatedAt" = now()
          WHERE "id" = 1
        `,
        [publicationId],
      );
      return;
    }
    const previousActiveId = cacheState?.activePublicationId
      ? String(cacheState.activePublicationId)
      : null;
    if (previousActiveId && previousActiveId !== publicationId) {
      await manager.query(
        `
            UPDATE "statistic_cache_publication"
            SET "status" = 'retired', "retiredAt" = now()
            WHERE "id" = $1::uuid AND "status" = 'active'
          `,
        [previousActiveId],
      );
    }
    await manager.query(
      `
          UPDATE "statistic_cache_publication"
          SET "status" = 'active', "activatedAt" = now()
          WHERE "id" = $1::uuid AND "status" = 'ready'
        `,
      [publicationId],
    );
    await manager.query(
      `
        UPDATE "statistic_cache_state"
          SET "previousPublicationId" = $2::uuid,
              "activePublicationId" = $1::uuid,
              "candidatePublicationId" = NULL,
              "updatedAt" = now()
          WHERE "id" = 1
      `,
      [publicationId, previousActiveId],
    );
  }

  private async discardCandidate(
    manager: EntityManager,
    candidateId: string,
  ): Promise<void> {
    await manager.query(
      `
        UPDATE "statistic_cache_state"
        SET "candidatePublicationId" = NULL, "updatedAt" = now()
        WHERE "id" = 1 AND "candidatePublicationId" = $1::uuid
      `,
      [candidateId],
    );
  }

  private async garbageCollectPublications(
    manager: StatisticCacheQueryable,
  ): Promise<void> {
    try {
      await manager.query(
        `
          UPDATE "zone_publication_instance" instance
          SET "candidateStatisticCachePublicationId" = NULL,
              "candidateStatisticRevision" = NULL,
              "candidateStatisticPublishedDate" = NULL,
              "candidateStatisticSourceRevision" = NULL,
              "candidateStatisticFingerprint" = NULL,
              "candidateStatisticProtocolVersion" = NULL,
              "candidateStatisticLastError" = NULL
          FROM "statistic_cache_state" state
          WHERE state."id" = 1
            AND instance."candidateStatisticCachePublicationId" IS NOT NULL
            AND instance."candidateStatisticCachePublicationId"
              IS DISTINCT FROM state."candidatePublicationId"
        `,
      );
      await manager.query(
        `
          UPDATE "zone_publication_instance" instance
          SET "statisticCachePublicationId" = NULL,
              "statisticRevision" = NULL,
              "statisticPublishedDate" = NULL,
              "statisticSourceRevision" = NULL,
              "statisticFingerprint" = NULL,
              "statisticProtocolVersion" = NULL,
              "statisticLastError" = NULL
          FROM "statistic_cache_publication" publication,
               "statistic_cache_state" state
          WHERE state."id" = 1
            AND publication."status" IN ('ready', 'retired')
            AND publication."id" IS DISTINCT FROM state."activePublicationId"
            AND publication."id" IS DISTINCT FROM state."previousPublicationId"
            AND publication."id" IS DISTINCT FROM state."candidatePublicationId"
            AND instance."statisticCachePublicationId" = publication."id"
        `,
      );
      await manager.query(
        `
          DELETE FROM "statistic_cache_publication" publication
          USING "statistic_cache_state" state
          WHERE state."id" = 1
            AND publication."status" IN ('ready', 'retired')
            AND publication."id" IS DISTINCT FROM state."activePublicationId"
            AND publication."id" IS DISTINCT FROM state."previousPublicationId"
            AND publication."id" IS DISTINCT FROM state."candidatePublicationId"
            AND NOT EXISTS (
              SELECT 1
              FROM "zone_publication_instance" instance
              WHERE instance."candidateStatisticCachePublicationId" =
                publication."id"
                 OR instance."statisticCachePublicationId" = publication."id"
            )
        `,
      );
    } catch (error) {
      // Detached publications are safe to retain and will be retried later.
      this.logger.warn(
        `STATISTIC CACHE GARBAGE COLLECTION DEFERRED: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async waitForActivePublication(
    target: StatisticCacheMaterializationTarget,
  ): Promise<StatisticCacheArtifactPayload> {
    const deadline = Date.now() + MATERIALIZATION_WAIT_MS;
    while (Date.now() < deadline) {
      const active = await this.loadActive();
      if (hasMaterializationTarget(active, target)) {
        return active;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, MATERIALIZATION_POLL_MS),
      );
    }
    throw new Error(
      `Timed out waiting for statistic cache ${target.statisticRevision}/${target.currentPublishedDate}`,
    );
  }

  private async waitForCandidateIdentity(
    target: StatisticCacheCandidateTarget,
    options: StatisticCacheCandidateStageOptions = {},
  ): Promise<StatisticCacheArtifactIdentity> {
    const deadline = Date.now() + MATERIALIZATION_WAIT_MS;
    while (Date.now() < deadline) {
      const active = await this.loadActiveIdentity();
      if (hasReusableCandidateIdentity(active, target, options)) {
        return active;
      }
      const candidate = await this.loadCandidateIdentity();
      if (hasReusableCandidateIdentity(candidate, target, options)) {
        return candidate;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, MATERIALIZATION_POLL_MS),
      );
    }
    throw new Error(
      `Timed out waiting for statistic cache candidate ${target.statisticRevision}/${target.currentPublishedDate}`,
    );
  }
}
