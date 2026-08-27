import {
  BaseEntity,
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from "typeorm";

export type HistoricBackfillMapManifestOutboxStatus = "pending" | "published";

@Entity({ name: "historic_backfill_map_manifest_outbox" })
@Index("UQ_historic_backfill_map_manifest_outbox_pending", ["status"], {
  unique: true,
  where: `"status" = 'pending'`,
})
@Check(
  "CHK_historic_backfill_map_manifest_outbox_status",
  `
    ("status" = 'pending' AND "publishedAt" IS NULL)
    OR ("status" = 'published' AND "publishedAt" IS NOT NULL)
  `,
)
@Check(
  "CHK_historic_backfill_map_manifest_outbox_values",
  `
    "mapDateFrom" <= "dateThrough"
    AND "sourceRevision" >= 0
    AND "historicComputeEpoch" >= 0
    AND "mapGeneration" >= 0
    AND "statisticRevision" >= 0
    AND "artifactTaskCount" > 0
    AND "dayCount" > 0
    AND length("manifestObjectKey") > 0
    AND length("manifestBody") > 0
    AND "manifestChecksum" ~ '^[0-9a-f]{64}$'
  `,
)
export class HistoricBackfillMapManifestOutbox extends BaseEntity {
  @PrimaryColumn({ type: "uuid" })
  runId: string;

  @Column({ type: "varchar", length: 20, default: "pending" })
  status: HistoricBackfillMapManifestOutboxStatus;

  @Column({ type: "date" })
  mapDateFrom: string;

  @Column({ type: "date" })
  dateThrough: string;

  @Column({ type: "bigint" })
  sourceRevision: string;

  @Column({ type: "bigint" })
  historicComputeEpoch: string;

  @Column({ type: "bigint" })
  mapGeneration: string;

  @Column({ type: "bigint" })
  statisticRevision: string;

  @Column({ type: "integer" })
  artifactTaskCount: number;

  @Column({ type: "integer" })
  dayCount: number;

  @Column({ type: "text" })
  manifestObjectKey: string;

  @Column({ type: "text" })
  manifestBody: string;

  @Column({ type: "varchar", length: 64 })
  manifestChecksum: string;

  @Column({ type: "timestamp with time zone", nullable: true })
  publishedAt: Date | null;

  @Column({ type: "text", nullable: true })
  lastError: string | null;

  @CreateDateColumn({ type: "timestamp with time zone" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamp with time zone" })
  updatedAt: Date;
}
