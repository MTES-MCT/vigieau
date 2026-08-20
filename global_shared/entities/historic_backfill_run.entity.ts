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

export type HistoricBackfillRunStatus =
  | "preparing"
  | "running"
  | "paused"
  | "completed"
  | "failed";

@Entity({ name: "historic_backfill_run" })
@Index("IDX_historic_backfill_run_status", ["status", "updatedAt"])
@Index("IDX_historic_backfill_run_context", [
  "sourceRevision",
  "historicComputeEpoch",
  "historicBackfillGlobalEpoch",
])
@Check(
  "CHK_historic_backfill_run_status",
  `"status" IN ('preparing', 'running', 'paused', 'completed', 'failed')`,
)
@Check(
  "CHK_historic_backfill_run_date_range",
  `
    "mapDateFrom" <= "dateThrough"
    AND "statisticDateFrom" <= "dateThrough"
  `,
)
@Check(
  "CHK_historic_backfill_run_revisions",
  `
    "sourceRevision" >= 0
    AND "historicComputeEpoch" >= 0
    AND "historicBackfillGlobalEpoch" >= 0
    AND "baseStatisticRevision" >= 0
  `,
)
export class HistoricBackfillRun extends BaseEntity {
  @PrimaryColumn({ type: "uuid" })
  id: string;

  @Column({ type: "varchar", length: 20 })
  status: HistoricBackfillRunStatus;

  @Column({ type: "date" })
  mapDateFrom: string;

  @Column({ type: "date" })
  statisticDateFrom: string;

  @Column({ type: "date" })
  dateThrough: string;

  @Column({ type: "bigint" })
  sourceRevision: string;

  @Column({ type: "bigint" })
  historicComputeEpoch: string;

  @Column({ type: "bigint" })
  historicBackfillGlobalEpoch: string;

  @Column({ type: "bigint" })
  baseStatisticRevision: string;

  @CreateDateColumn({ type: "timestamp with time zone" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamp with time zone" })
  updatedAt: Date;

  @Column({ type: "timestamp with time zone", nullable: true })
  startedAt: Date | null;

  @Column({ type: "timestamp with time zone", nullable: true })
  pausedAt: Date | null;

  @Column({ type: "timestamp with time zone", nullable: true })
  completedAt: Date | null;

  @Column({ type: "timestamp with time zone", nullable: true })
  statisticsPromotedAt: Date | null;

  @Column({ type: "text", nullable: true })
  lastError: string | null;
}
