import {
  BaseEntity,
  Check,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  Unique,
} from "typeorm";

export type StatisticCacheMode = "legacy-bootstrap" | "versioned";

export type StatisticCacheMaterializationStrategy =
  "full-clean" | "legacy-safe-boundary" | "daily-delta" | "current-replace";

export type StatisticCachePublicationStatus =
  "building" | "ready" | "active" | "retired" | "failed";

@Entity({ name: "statistic_cache_publication" })
@Unique("UQ_statistic_cache_publication_instance_identity", [
  "id",
  "statisticRevision",
  "currentPublishedDate",
  "contentFingerprint",
])
@Check(
  "CHK_statistic_cache_publication_mode",
  `"mode" IN ('legacy-bootstrap', 'versioned')`,
)
@Check(
  "CHK_statistic_cache_publication_status",
  `"status" IN ('building', 'ready', 'active', 'retired', 'failed')`,
)
@Check(
  "CHK_statistic_cache_publication_strategy",
  `
    "materializationStrategy" IN (
      'full-clean', 'legacy-safe-boundary', 'daily-delta', 'current-replace'
    )
  `,
)
@Check("CHK_statistic_cache_publication_revision", `"statisticRevision" >= 0`)
@Check("CHK_statistic_cache_publication_schema_version", `"schemaVersion" > 0`)
@Check(
  "CHK_statistic_cache_publication_date_range",
  `"firstDate" <= "latestDate" AND "latestDate" <= "currentPublishedDate"`,
)
@Check(
  "CHK_statistic_cache_publication_counts",
  `
    "dateCount" > 0
    AND "areaCount" >= 0
    AND "departmentCount" >= 0
    AND "communeCount" >= 0
    AND "compressedByteLength" >= 0
    AND "uncompressedByteLength" >= 0
  `,
)
@Check(
  "CHK_statistic_cache_publication_fingerprint",
  `
    "contentFingerprint" IS NULL
    OR "contentFingerprint" ~ '^[0-9a-f]{64}$'
  `,
)
@Check(
  "CHK_statistic_cache_publication_ready_content",
  `
    "status" IN ('building', 'failed')
    OR (
      "contentFingerprint" IS NOT NULL
      AND "latestDate" = "currentPublishedDate"
      AND "compressedByteLength" > 0
      AND "uncompressedByteLength" > 0
    )
  `,
)
@Check(
  "CHK_statistic_cache_publication_dirty_range",
  `
    (
      "historicDirtyFrom" IS NULL
      AND "historicDirtyThrough" IS NULL
    )
    OR (
      "historicDirtyFrom" IS NOT NULL
      AND "historicDirtyThrough" IS NOT NULL
      AND "historicDirtyFrom" <= "historicDirtyThrough"
    )
  `,
)
@Check(
  "CHK_statistic_cache_publication_cursor_pair",
  `
    (
      "historicMapCursor" IS NULL
      AND "historicStatsCursor" IS NULL
    )
    OR (
      "historicMapCursor" IS NOT NULL
      AND "historicStatsCursor" IS NOT NULL
    )
  `,
)
@Check(
  "CHK_statistic_cache_publication_source_context",
  `
    ("sourceRevision" IS NULL OR "sourceRevision" >= 0)
    AND ("historicComputeEpoch" IS NULL OR "historicComputeEpoch" >= 0)
  `,
)
@Check(
  "CHK_statistic_cache_publication_safe_boundary",
  `
    "materializationStrategy" <> 'legacy-safe-boundary'
    OR (
      "mode" = 'legacy-bootstrap'
      AND "historicDirtyFrom" IS NOT NULL
      AND "historicDirtyThrough" IS NOT NULL
      AND "historicMapCursor" IS NOT NULL
      AND "historicStatsCursor" IS NOT NULL
      AND "sourceRevision" IS NOT NULL
      AND "historicComputeEpoch" IS NOT NULL
    )
  `,
)
export class StatisticCachePublication extends BaseEntity {
  @PrimaryColumn({ type: "uuid" })
  id: string;

  @Column({ type: "bigint" })
  statisticRevision: string;

  @Column({ type: "date" })
  currentPublishedDate: string;

  @Column({ type: "integer", default: 1 })
  schemaVersion: number;

  @Column({ type: "varchar", length: 20 })
  mode: StatisticCacheMode;

  @Column({ type: "varchar", length: 30 })
  materializationStrategy: StatisticCacheMaterializationStrategy;

  @Column({ type: "varchar", length: 20 })
  status: StatisticCachePublicationStatus;

  @Column({ type: "date", nullable: true })
  historicDirtyFrom: string | null;

  @Column({ type: "date", nullable: true })
  historicDirtyThrough: string | null;

  @Column({ type: "date", nullable: true })
  historicMapCursor: string | null;

  @Column({ type: "date", nullable: true })
  historicStatsCursor: string | null;

  @Column({ type: "bigint", nullable: true })
  sourceRevision: string | null;

  @Column({ type: "bigint", nullable: true })
  historicComputeEpoch: string | null;

  @Column({ type: "date" })
  firstDate: string;

  @Column({ type: "date" })
  latestDate: string;

  @Column({ type: "integer" })
  dateCount: number;

  @Column({ type: "integer" })
  areaCount: number;

  @Column({ type: "integer" })
  departmentCount: number;

  @Column({ type: "integer" })
  communeCount: number;

  @Column({ type: "varchar", length: 64, nullable: true })
  contentFingerprint: string | null;

  @Column({ type: "bigint", default: 0 })
  compressedByteLength: string;

  @Column({ type: "bigint", default: 0 })
  uncompressedByteLength: string;

  @CreateDateColumn({ type: "timestamp with time zone" })
  createdAt: Date;

  @Column({ type: "timestamp with time zone", nullable: true })
  readyAt: Date | null;

  @Column({ type: "timestamp with time zone", nullable: true })
  activatedAt: Date | null;

  @Column({ type: "timestamp with time zone", nullable: true })
  retiredAt: Date | null;

  @Column({ type: "timestamp with time zone", nullable: true })
  failedAt: Date | null;

  @Column({ type: "text", nullable: true })
  lastError: string | null;
}
