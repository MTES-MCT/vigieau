import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';

export const STATISTIC_CACHE_ARTIFACT_SCHEMA_VERSION = 1;
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
  | 'current-replace';

export type StatisticCacheLatestCommuneWeight = [code: string, weight: number];

export interface StatisticCacheArtifactTarget {
  statisticRevision: string;
  currentPublishedDate: string;
}

export interface StatisticCacheRollbackGuard {
  activePublicationId: string;
  previousPublicationId: string;
}

export interface StatisticCacheArtifactIdentity extends StatisticCacheArtifactTarget {
  id: string;
  mode: StatisticCacheArtifactMode;
  materializationStrategy: StatisticCacheMaterializationStrategy;
  historicDirtyFrom: string | null;
  historicDirtyThrough: string | null;
  historicMapCursor: string | null;
  historicStatsCursor: string | null;
  sourceRevision: string | null;
  historicComputeEpoch: string | null;
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
  mode: StatisticCacheArtifactMode;
  materializationStrategy: StatisticCacheMaterializationStrategy;
  historicDirtyFrom: string | Date | null;
  historicDirtyThrough: string | Date | null;
  historicMapCursor: string | Date | null;
  historicStatsCursor: string | Date | null;
  sourceRevision: string | number | null;
  historicComputeEpoch: string | number | null;
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
const STATISTIC_COMMUNE_SNAPSHOT_LOCK =
  'vigieau:statistic-commune:snapshot-computation';

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

function hasTarget(
  payload: StatisticCacheArtifactPayload | null,
  target: StatisticCacheArtifactTarget,
): payload is StatisticCacheArtifactPayload {
  return Boolean(
    payload &&
    payload.identity.statisticRevision === target.statisticRevision &&
    payload.identity.currentPublishedDate === target.currentPublishedDate,
  );
}

@Injectable()
export class StatisticCacheArtifactService {
  constructor(private readonly dataSource: DataSource) {}

  async loadActive(
    queryable: StatisticCacheQueryable = this.dataSource,
  ): Promise<StatisticCacheArtifactPayload | null> {
    return this.loadPublication(null, queryable);
  }

  async loadPublication(
    publicationId: string | null,
    queryable: StatisticCacheQueryable = this.dataSource,
  ): Promise<StatisticCacheArtifactPayload | null> {
    const rows = (await queryable.query(
      `
        SELECT
          publication."id", publication."statisticRevision",
          publication."currentPublishedDate"::text AS "currentPublishedDate",
          publication."schemaVersion",
          publication."mode", publication."materializationStrategy",
          publication."historicDirtyFrom"::text AS "historicDirtyFrom",
          publication."historicDirtyThrough"::text AS "historicDirtyThrough",
          publication."historicMapCursor"::text AS "historicMapCursor",
          publication."historicStatsCursor"::text AS "historicStatsCursor",
          publication."sourceRevision", publication."historicComputeEpoch",
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
          ON publication."id" = COALESCE($1::uuid, state."activePublicationId")
        JOIN "statistic_cache_artifact" artifact
          ON artifact."publicationId" = publication."id"
        WHERE state."id" = 1
          AND publication."status" = 'active'
          AND publication."id" = state."activePublicationId"
        ORDER BY artifact."kind"
      `,
      [publicationId],
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
    target: StatisticCacheArtifactTarget,
    candidateFactory: (
      manager: EntityManager,
    ) => Promise<StatisticCacheArtifactCandidate>,
  ): Promise<StatisticCacheArtifactPayload> {
    const activeBeforeLock = await this.loadActive();
    if (hasTarget(activeBeforeLock, target)) {
      return activeBeforeLock;
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    let locked = false;
    let globalComputeLocked = false;
    let communeSnapshotLocked = false;
    let transactionStarted = false;
    let primaryError: unknown = null;
    try {
      const [lock] = await queryRunner.query(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [MATERIALIZATION_LOCK],
      );
      locked = lock?.locked === true;
      if (!locked) {
        return this.waitForActivePublication(target);
      }

      globalComputeLocked = await this.waitForLock(
        queryRunner,
        "SELECT pg_try_advisory_lock(hashtext('vigieau'), hashtext('zone-compute-global')) AS locked",
      );
      communeSnapshotLocked = await this.waitForLock(
        queryRunner,
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [STATISTIC_COMMUNE_SNAPSHOT_LOCK],
      );

      const activeAfterLock = await this.loadActive(queryRunner.manager);
      if (hasTarget(activeAfterLock, target)) {
        return activeAfterLock;
      }
      await queryRunner.startTransaction('REPEATABLE READ');
      transactionStarted = true;
      await queryRunner.query(
        'LOCK TABLE "current_zone_recompute_request" IN SHARE MODE',
      );
      const candidate = await candidateFactory(queryRunner.manager);
      if (
        candidate.statisticRevision !== target.statisticRevision ||
        candidate.currentPublishedDate !== target.currentPublishedDate
      ) {
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
      const published = await this.loadPublication(publicationId);
      if (!published) {
        throw new Error(
          `Statistic cache publication ${publicationId} was not persisted`,
        );
      }
      return published;
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await this.cleanupMaterializationSession(
        queryRunner,
        transactionStarted,
        [
          ...(communeSnapshotLocked
            ? [
                {
                  sql: 'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked',
                  parameters: [STATISTIC_COMMUNE_SNAPSHOT_LOCK],
                },
              ]
            : []),
          ...(globalComputeLocked
            ? [
                {
                  sql: "SELECT pg_advisory_unlock(hashtext('vigieau'), hashtext('zone-compute-global')) AS unlocked",
                  parameters: [],
                },
              ]
            : []),
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
  ): Promise<void> {
    const [publicationState] = await manager.query(
      `
        WITH source_guard AS MATERIALIZED (
          SELECT source_state."revision"::text AS "sourceRevision"
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
            (
              SELECT COUNT(*)::integer
              FROM "statistic_commune_snapshot" snapshot
              WHERE snapshot."scope" = 'bootstrap'
                 OR (
                   snapshot."scope" <> 'bootstrap'
                   AND
                   snapshot."snapshotDate" BETWEEN
                     CASE
                       WHEN $4::varchar IN ('daily-delta', 'current-replace')
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
      Number(publicationState?.invalidSnapshotCount ?? -1) !== 0
    ) {
      throw new Error(
        'Statistic materialization boundary changed before activation',
      );
    }
    const [cacheState] = await manager.query(
      `
          SELECT "activePublicationId", "historicRecoveryMonthlyFrom"
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
            "sourceRevision", "historicComputeEpoch", "schemaVersion", "status",
            "contentFingerprint", "firstDate", "latestDate", "dateCount",
            "areaCount", "departmentCount", "communeCount",
            "compressedByteLength", "uncompressedByteLength"
          ) VALUES (
            $1::uuid, $2::bigint, $3::date, $4, $5, $6::date, $7::date,
            $8::date, $9::date, $10::bigint, $11::bigint, $12, 'building',
            $13, $14::date, $15::date, $16, $17, $18, $19, $20, $21
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
        candidate.contentFingerprint,
        candidate.firstDate,
        candidate.latestDate,
        candidate.dateCount,
        candidate.dataArea.length,
        candidate.departmentCount,
        candidate.communeCount,
        totalCompressedByteLength,
        totalUncompressedByteLength,
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
              "updatedAt" = now()
          WHERE "id" = 1
      `,
      [publicationId, previousActiveId],
    );
    await manager.query(
      `
        DELETE FROM "statistic_cache_publication" publication
        USING "statistic_cache_state" state
        WHERE state."id" = 1
          AND publication."status" = 'retired'
          AND publication."id" IS DISTINCT FROM state."activePublicationId"
          AND publication."id" IS DISTINCT FROM state."previousPublicationId"
      `,
    );
  }

  private async waitForActivePublication(
    target: StatisticCacheArtifactTarget,
  ): Promise<StatisticCacheArtifactPayload> {
    const deadline = Date.now() + MATERIALIZATION_WAIT_MS;
    while (Date.now() < deadline) {
      const active = await this.loadActive();
      if (hasTarget(active, target)) {
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
}
