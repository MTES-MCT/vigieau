import { BaseEntity, Check, Column, Entity, PrimaryColumn } from "typeorm";

@Entity({ name: "zone_publication_instance" })
@Check(
  "CHK_zone_publication_instance_statistic_identity",
  `
    (
      "statisticCachePublicationId" IS NULL
      AND "statisticRevision" IS NULL
      AND "statisticPublishedDate" IS NULL
      AND "statisticSourceRevision" IS NULL
      AND "statisticFingerprint" IS NULL
      AND "statisticProtocolVersion" IS NULL
    )
    OR (
      "statisticCachePublicationId" IS NOT NULL
      AND "statisticRevision" IS NOT NULL
      AND "statisticRevision" >= 0
      AND "statisticPublishedDate" IS NOT NULL
      AND ("statisticSourceRevision" IS NULL OR "statisticSourceRevision" >= 0)
      AND "statisticFingerprint" IS NOT NULL
      AND "statisticFingerprint" ~ '^[0-9a-f]{64}$'
      AND "statisticProtocolVersion" IS NOT NULL
      AND "statisticProtocolVersion" > 0
    )
  `,
)
@Check(
  "CHK_zone_publication_instance_statistic_candidate_identity",
  `
    (
      "candidateStatisticCachePublicationId" IS NULL
      AND "candidateStatisticRevision" IS NULL
      AND "candidateStatisticPublishedDate" IS NULL
      AND "candidateStatisticSourceRevision" IS NULL
      AND "candidateStatisticFingerprint" IS NULL
      AND "candidateStatisticProtocolVersion" IS NULL
      AND "candidateStatisticLastError" IS NULL
    )
    OR (
      "candidateStatisticCachePublicationId" IS NOT NULL
      AND "candidateStatisticRevision" IS NULL
      AND "candidateStatisticPublishedDate" IS NULL
      AND "candidateStatisticSourceRevision" IS NULL
      AND "candidateStatisticFingerprint" IS NULL
      AND "candidateStatisticProtocolVersion" IS NULL
      AND "candidateStatisticLastError" IS NOT NULL
    )
    OR (
      "candidateStatisticCachePublicationId" IS NOT NULL
      AND "candidateStatisticRevision" IS NOT NULL
      AND "candidateStatisticRevision" >= 0
      AND "candidateStatisticPublishedDate" IS NOT NULL
      AND (
        "candidateStatisticSourceRevision" IS NULL
        OR "candidateStatisticSourceRevision" >= 0
      )
      AND "candidateStatisticFingerprint" IS NOT NULL
      AND "candidateStatisticFingerprint" ~ '^[0-9a-f]{64}$'
      AND "candidateStatisticProtocolVersion" IS NOT NULL
      AND "candidateStatisticProtocolVersion" > 0
    )
  `,
)
export class ZonePublicationInstance extends BaseEntity {
  @PrimaryColumn({ type: "varchar", length: 200 })
  instanceId: string;

  @Column({ type: "uuid", nullable: true })
  activePublicationId: string | null;

  @Column({ type: "uuid", nullable: true })
  candidatePublicationId: string | null;

  @Column({ type: "integer", nullable: true })
  zoneCount: number | null;

  @Column({ type: "integer", nullable: true })
  communeLinkCount: number | null;

  @Column({ type: "varchar", length: 64, nullable: true })
  contentFingerprint: string | null;

  @Column({ type: "uuid", nullable: true })
  statisticCachePublicationId: string | null;

  @Column({ type: "bigint", nullable: true })
  statisticRevision: string | null;

  @Column({ type: "date", nullable: true })
  statisticPublishedDate: string | null;

  @Column({ type: "varchar", length: 64, nullable: true })
  statisticFingerprint: string | null;

  @Column({ type: "bigint", nullable: true })
  statisticSourceRevision: string | null;

  @Column({ type: "integer", nullable: true, default: 1 })
  statisticProtocolVersion: number | null;

  @Column({ type: "text", nullable: true })
  statisticLastError: string | null;

  @Column({ type: "uuid", nullable: true })
  candidateStatisticCachePublicationId: string | null;

  @Column({ type: "bigint", nullable: true })
  candidateStatisticRevision: string | null;

  @Column({ type: "date", nullable: true })
  candidateStatisticPublishedDate: string | null;

  @Column({ type: "bigint", nullable: true })
  candidateStatisticSourceRevision: string | null;

  @Column({ type: "varchar", length: 64, nullable: true })
  candidateStatisticFingerprint: string | null;

  @Column({ type: "integer", nullable: true })
  candidateStatisticProtocolVersion: number | null;

  @Column({ type: "text", nullable: true })
  candidateStatisticLastError: string | null;

  @Column({ type: "text", nullable: true })
  lastError: string | null;

  @Column({ type: "timestamp with time zone", default: () => "now()" })
  heartbeatAt: Date;
}
