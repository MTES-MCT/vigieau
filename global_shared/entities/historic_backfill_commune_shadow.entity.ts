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

@Entity({ name: "historic_backfill_commune_shadow" })
@Index("IDX_historic_backfill_commune_shadow_run_department", [
  "runId",
  "departementId",
])
@Check(
  "CHK_historic_backfill_commune_shadow_generation",
  `"sourceGeneration" >= 0`,
)
@Check(
  "CHK_historic_backfill_commune_shadow_arrays",
  `jsonb_typeof("restrictions") = 'array' AND jsonb_typeof("restrictionsByMonth") = 'array'`,
)
export class HistoricBackfillCommuneShadow extends BaseEntity {
  @PrimaryColumn({ type: "uuid" })
  runId: string;

  @PrimaryColumn({ type: "integer" })
  communeId: number;

  @Column({ type: "integer" })
  departementId: number;

  @Column({ type: "bigint" })
  sourceGeneration: string;

  @Column({ type: "jsonb" })
  restrictions: unknown[];

  @Column({ type: "jsonb" })
  restrictionsByMonth: unknown[];

  @CreateDateColumn({ type: "timestamp with time zone" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamp with time zone" })
  updatedAt: Date;
}
