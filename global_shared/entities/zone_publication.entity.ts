import {
  BaseEntity,
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Generated,
  PrimaryColumn,
} from "typeorm";

export type ZonePublicationStatus =
  | "building"
  | "validated"
  | "candidate"
  | "active"
  | "retired"
  | "superseded"
  | "failed";

@Entity({ name: "zone_publication" })
@Check(
  `"status" IN ('building', 'validated', 'candidate', 'active', 'retired', 'superseded', 'failed')`,
)
export class ZonePublication extends BaseEntity {
  @PrimaryColumn({ type: "uuid" })
  id: string;

  @Column({ type: "bigint", unique: true })
  @Generated("increment")
  revision: string;

  @Column({ type: "bigint" })
  sourceRevision: string;

  @Column({ type: "integer", default: 1 })
  materializationVersion: number;

  @Column({ type: "varchar", length: 20 })
  status: ZonePublicationStatus;

  @Column({ type: "timestamp with time zone" })
  sourceComputedAt: Date;

  @Column({ type: "integer", default: 0 })
  zoneCount: number;

  @Column({ type: "integer", default: 0 })
  communeLinkCount: number;

  @Column({ type: "text", nullable: true })
  geojsonUrl: string | null;

  @Column({ type: "varchar", length: 64, nullable: true })
  geojsonChecksum: string | null;

  @Column({ type: "text", nullable: true })
  pmtilesUrl: string | null;

  @Column({ type: "varchar", length: 64, nullable: true })
  pmtilesChecksum: string | null;

  @Column({ type: "text", nullable: true })
  validationError: string | null;

  @CreateDateColumn({ type: "timestamp with time zone" })
  createdAt: Date;

  @Column({ type: "timestamp with time zone", nullable: true })
  validatedAt: Date | null;

  @Column({ type: "timestamp with time zone", nullable: true })
  candidateAt: Date | null;

  @Column({ type: "timestamp with time zone", nullable: true })
  activatedAt: Date | null;

  @Column({ type: "timestamp with time zone", nullable: true })
  failedAt: Date | null;

  @Column({ type: "timestamp with time zone", nullable: true })
  legacyPromotedAt: Date | null;

  @Column({ type: "timestamp with time zone", nullable: true })
  dataGouvPromotedAt: Date | null;

  @Column({ type: "timestamp with time zone", nullable: true })
  promotionLastAttemptAt: Date | null;

  @Column({ type: "text", nullable: true })
  promotionError: string | null;
}
