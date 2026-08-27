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

export type HistoricBackfillArtifactTaskStatus =
  | "pending"
  | "leased"
  | "completed"
  | "failed";

@Entity({ name: "historic_backfill_artifact_task" })
@Index(
  "IDX_historic_backfill_artifact_task_claim",
  ["runId", "nextAttemptAt", "validFrom"],
  { where: `"status" = 'pending'` },
)
@Index(
  "IDX_historic_backfill_artifact_task_expired_lease",
  ["leaseExpiresAt"],
  { where: `"status" = 'leased'` },
)
@Check(
  "CHK_historic_backfill_artifact_task_range",
  `"validFrom" <= "validThrough"`,
)
@Check(
  "CHK_historic_backfill_artifact_task_status",
  `"status" IN ('pending', 'leased', 'completed', 'failed')`,
)
@Check(
  "CHK_historic_backfill_artifact_task_attempts",
  `"attemptCount" >= 0 AND "featureCount" >= 0`,
)
@Check(
  "CHK_historic_backfill_artifact_task_lease",
  `(
    "status" = 'leased'
    AND "leaseOwner" IS NOT NULL
    AND "leaseToken" IS NOT NULL
    AND "leaseExpiresAt" IS NOT NULL
  ) OR (
    "status" <> 'leased'
    AND "leaseOwner" IS NULL
    AND "leaseToken" IS NULL
    AND "leaseExpiresAt" IS NULL
  )`,
)
@Check(
  "CHK_historic_backfill_artifact_task_output",
  `"status" <> 'completed' OR (
    length("geojsonObjectKey") > 0
    AND "geojsonChecksum" ~ '^[0-9a-f]{64}$'
    AND length("pmtilesObjectKey") > 0
    AND "pmtilesChecksum" ~ '^[0-9a-f]{64}$'
  )`,
)
export class HistoricBackfillArtifactTask extends BaseEntity {
  @PrimaryColumn({ type: "uuid" })
  runId: string;

  @PrimaryColumn({ type: "date" })
  validFrom: string;

  @Column({ type: "date" })
  validThrough: string;

  @Column({ type: "bigint" })
  sourceRevision: string;

  @Column({ type: "bigint" })
  historicComputeEpoch: string;

  @Column({ type: "varchar", length: 20, default: "pending" })
  status: HistoricBackfillArtifactTaskStatus;

  @Column({ type: "integer", default: 0 })
  attemptCount: number;

  @Column({ type: "varchar", length: 200, nullable: true })
  leaseOwner: string | null;

  @Column({ type: "uuid", nullable: true })
  leaseToken: string | null;

  @Column({ type: "timestamp with time zone", nullable: true })
  leaseExpiresAt: Date | null;

  @Column({ type: "timestamp with time zone", nullable: true })
  heartbeatAt: Date | null;

  @Column({ type: "timestamp with time zone", default: () => "now()" })
  nextAttemptAt: Date;

  @Column({ type: "text", nullable: true })
  geojsonObjectKey: string | null;

  @Column({ type: "varchar", length: 64, nullable: true })
  geojsonChecksum: string | null;

  @Column({ type: "text", nullable: true })
  pmtilesObjectKey: string | null;

  @Column({ type: "varchar", length: 64, nullable: true })
  pmtilesChecksum: string | null;

  @Column({ type: "integer", default: 0 })
  featureCount: number;

  @Column({ type: "timestamp with time zone", nullable: true })
  startedAt: Date | null;

  @Column({ type: "timestamp with time zone", nullable: true })
  completedAt: Date | null;

  @Column({ type: "text", nullable: true })
  lastError: string | null;

  @CreateDateColumn({ type: "timestamp with time zone" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamp with time zone" })
  updatedAt: Date;
}
