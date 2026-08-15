import { BaseEntity, Check, Column, Entity, PrimaryColumn } from "typeorm";

@Entity({ name: "zone_publication_instance" })
@Check(
  "CHK_zone_publication_instance_statistic_identity",
  `
    (
      "statisticCachePublicationId" IS NULL
      AND "statisticRevision" IS NULL
      AND "statisticPublishedDate" IS NULL
      AND "statisticFingerprint" IS NULL
    )
    OR (
      "statisticCachePublicationId" IS NOT NULL
      AND "statisticRevision" IS NOT NULL
      AND "statisticRevision" >= 0
      AND "statisticPublishedDate" IS NOT NULL
      AND "statisticFingerprint" ~ '^[0-9a-f]{64}$'
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

  @Column({ type: "text", nullable: true })
  statisticLastError: string | null;

  @Column({ type: "text", nullable: true })
  lastError: string | null;

  @Column({ type: "timestamp with time zone", default: () => "now()" })
  heartbeatAt: Date;
}
