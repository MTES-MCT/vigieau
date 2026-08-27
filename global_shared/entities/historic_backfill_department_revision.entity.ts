import {
  BaseEntity,
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from "typeorm";
import { Departement } from "./departement.entity";

@Entity({ name: "historic_backfill_department_revision" })
@Index("IDX_historic_backfill_department_revision_generation", [
  "generation",
  "lastPublicRevision",
])
@Check(
  "CHK_historic_backfill_department_revision_values",
  `"generation" >= 0 AND "lastPublicRevision" >= 0`,
)
export class HistoricBackfillDepartmentRevision extends BaseEntity {
  @PrimaryColumn({ type: "integer" })
  departementId: number;

  @ManyToOne(() => Departement, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({
    name: "departementId",
    foreignKeyConstraintName:
      "FK_historic_backfill_department_revision_departement",
  })
  departement: Departement;

  @Column({ type: "bigint", default: 0 })
  generation: string;

  @Column({ type: "bigint", default: 0 })
  lastPublicRevision: string;

  @UpdateDateColumn({ type: "timestamp with time zone" })
  updatedAt: Date;
}
