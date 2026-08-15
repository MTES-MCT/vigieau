import {
  BaseEntity,
  Check,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
} from "typeorm";

export type StatisticCacheArtifactKind = "area" | "departement" | "commune";

@Entity({ name: "statistic_cache_artifact" })
@Check(
  "CHK_statistic_cache_artifact_kind",
  `"kind" IN ('area', 'departement', 'commune')`,
)
@Check(
  "CHK_statistic_cache_artifact_encoding",
  `"contentEncoding" = 'gzip' AND "contentType" = 'application/json'`,
)
@Check(
  "CHK_statistic_cache_artifact_fingerprints",
  `
    "contentFingerprint" ~ '^[0-9a-f]{64}$'
    AND "checksum" ~ '^[0-9a-f]{64}$'
  `,
)
@Check(
  "CHK_statistic_cache_artifact_lengths",
  `
    "rowCount" >= 0
    AND "compressedByteLength" > 0
    AND "uncompressedByteLength" > 0
    AND "compressedByteLength" = octet_length("payload")
  `,
)
export class StatisticCacheArtifact extends BaseEntity {
  @PrimaryColumn({ type: "uuid" })
  publicationId: string;

  @PrimaryColumn({ type: "varchar", length: 20 })
  kind: StatisticCacheArtifactKind;

  @Column({ type: "varchar", length: 20, default: "gzip" })
  contentEncoding: "gzip";

  @Column({ type: "varchar", length: 50, default: "application/json" })
  contentType: "application/json";

  @Column({ type: "integer" })
  rowCount: number;

  @Column({ type: "varchar", length: 64 })
  contentFingerprint: string;

  @Column({ type: "varchar", length: 64 })
  checksum: string;

  @Column({ type: "bigint" })
  compressedByteLength: string;

  @Column({ type: "bigint" })
  uncompressedByteLength: string;

  @Column({ type: "bytea" })
  payload: Buffer;

  @CreateDateColumn({ type: "timestamp with time zone" })
  createdAt: Date;
}
