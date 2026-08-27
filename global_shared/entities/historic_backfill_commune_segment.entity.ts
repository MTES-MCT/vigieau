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
} from "typeorm";
import { NiveauGravite } from "../types/niveau_gravite.type";
import { Commune } from "./commune.entity";
import { Departement } from "./departement.entity";
import { HistoricBackfillRun } from "./historic_backfill_run.entity";
import { HistoricBackfillTask } from "./historic_backfill_task.entity";

@Entity({ name: "historic_backfill_commune_segment" })
@Index("IDX_historic_backfill_commune_segment_run_department_dates", [
  "runId",
  "departementId",
  "validFrom",
  "validThrough",
])
@Check(
  "CHK_historic_backfill_commune_segment_date_range",
  `"validFrom" <= "validThrough"`,
)
@Check(
  "CHK_historic_backfill_commune_segment_levels",
  `
    ("SOU" IS NULL OR "SOU" IN ('vigilance', 'alerte', 'alerte_renforcee', 'crise'))
    AND ("SUP" IS NULL OR "SUP" IN ('vigilance', 'alerte', 'alerte_renforcee', 'crise'))
    AND ("AEP" IS NULL OR "AEP" IN ('vigilance', 'alerte', 'alerte_renforcee', 'crise'))
  `,
)
@Check(
  "CHK_historic_backfill_commune_segment_generation",
  `"sourceGeneration" >= 0`,
)
@Check(
  "CHK_historic_backfill_commune_segment_signature",
  `"inputSignature" ~ '^[0-9a-f]{64}$'`,
)
export class HistoricBackfillCommuneSegment extends BaseEntity {
  @PrimaryColumn({ type: "uuid" })
  runId: string;

  @ManyToOne(() => HistoricBackfillRun, {
    nullable: false,
    onDelete: "CASCADE",
  })
  @JoinColumn({
    name: "runId",
    foreignKeyConstraintName: "FK_historic_backfill_commune_segment_run",
  })
  run: HistoricBackfillRun;

  @Column({ type: "integer" })
  departementId: number;

  @ManyToOne(() => Departement, { nullable: false, onDelete: "RESTRICT" })
  @JoinColumn({
    name: "departementId",
    foreignKeyConstraintName:
      "FK_historic_backfill_commune_segment_departement",
  })
  departement: Departement;

  @ManyToOne(() => HistoricBackfillTask, {
    nullable: false,
    onDelete: "CASCADE",
  })
  @JoinColumn([
    {
      name: "runId",
      referencedColumnName: "runId",
      foreignKeyConstraintName: "FK_historic_backfill_commune_segment_task",
    },
    { name: "departementId", referencedColumnName: "departementId" },
  ])
  task: HistoricBackfillTask;

  @PrimaryColumn({ type: "integer" })
  communeId: number;

  @ManyToOne(() => Commune, { nullable: false, onDelete: "RESTRICT" })
  @JoinColumn({
    name: "communeId",
    foreignKeyConstraintName: "FK_historic_backfill_commune_segment_commune",
  })
  commune: Commune;

  @PrimaryColumn({ type: "date" })
  validFrom: string;

  @Column({ type: "date" })
  validThrough: string;

  @Column({ type: "varchar", length: 20, nullable: true })
  SOU: NiveauGravite | null;

  @Column({ type: "varchar", length: 20, nullable: true })
  SUP: NiveauGravite | null;

  @Column({ type: "varchar", length: 20, nullable: true })
  AEP: NiveauGravite | null;

  @Column({ type: "bigint" })
  sourceGeneration: string;

  @Column({ type: "varchar", length: 64 })
  inputSignature: string;

  @CreateDateColumn({ type: "timestamp with time zone" })
  createdAt: Date;
}
