import {
  BaseEntity,
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from "typeorm";
import { Departement } from "./departement.entity";
import { HistoricBackfillRun } from "./historic_backfill_run.entity";

export type HistoricBackfillTaskStatus =
  | "pending"
  | "leased"
  | "completed"
  | "failed";

@Entity({ name: "historic_backfill_task" })
@Index(
  "IDX_historic_backfill_task_claim",
  ["runId", "nextAttemptAt", "createdAt"],
  { where: `"status" = 'pending'` },
)
@Index("IDX_historic_backfill_task_expired_lease", ["leaseExpiresAt"], {
  where: `"status" = 'leased'`,
})
@Index("IDX_historic_backfill_task_department_generation", [
  "departementId",
  "departmentGeneration",
])
@Check(
  "CHK_historic_backfill_task_status",
  `"status" IN ('pending', 'leased', 'completed', 'failed')`,
)
@Check(
  "CHK_historic_backfill_task_counts",
  `
    "attemptCount" >= 0
    AND "departmentGeneration" >= 0
    AND "segmentCount" >= 0
    AND "communeCount" >= 0
  `,
)
@Check(
  "CHK_historic_backfill_task_lease",
  `
    (
      "status" = 'leased'
      AND "leaseOwner" IS NOT NULL
      AND "leaseToken" IS NOT NULL
      AND "leaseExpiresAt" IS NOT NULL
    )
    OR (
      "status" <> 'leased'
      AND "leaseOwner" IS NULL
      AND "leaseToken" IS NULL
      AND "leaseExpiresAt" IS NULL
    )
  `,
)
@Check(
  "CHK_historic_backfill_task_output_signature",
  `"outputSignature" IS NULL OR "outputSignature" ~ '^[0-9a-f]{64}$'`,
)
export class HistoricBackfillTask extends BaseEntity {
  @PrimaryColumn({ type: "uuid" })
  runId: string;

  @ManyToOne(() => HistoricBackfillRun, {
    nullable: false,
    onDelete: "CASCADE",
  })
  @JoinColumn({
    name: "runId",
    foreignKeyConstraintName: "FK_historic_backfill_task_run",
  })
  run: HistoricBackfillRun;

  @PrimaryColumn({ type: "integer" })
  departementId: number;

  @ManyToOne(() => Departement, { nullable: false, onDelete: "RESTRICT" })
  @JoinColumn({
    name: "departementId",
    foreignKeyConstraintName: "FK_historic_backfill_task_departement",
  })
  departement: Departement;

  @Column({ type: "varchar", length: 20, default: "pending" })
  status: HistoricBackfillTaskStatus;

  @Column({ type: "bigint" })
  departmentGeneration: string;

  @Column({ type: "date", nullable: true })
  progressDate: string | null;

  @Column({ type: "integer", default: 0 })
  segmentCount: number;

  @Column({ type: "integer", default: 0 })
  communeCount: number;

  @Column({ type: "varchar", length: 64, nullable: true })
  outputSignature: string | null;

  @Column({ type: "text", nullable: true })
  artifactPrefix: string | null;

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
