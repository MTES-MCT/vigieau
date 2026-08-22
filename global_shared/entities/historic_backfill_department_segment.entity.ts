import {
  BaseEntity,
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from "typeorm";

@Entity({ name: "historic_backfill_department_segment" })
@Index("IDX_historic_backfill_department_segment_run_dates", [
  "runId",
  "validFrom",
  "validThrough",
])
@Check(
  "CHK_historic_backfill_department_segment_date_range",
  `"validFrom" <= "validThrough"`,
)
@Check(
  "CHK_historic_backfill_department_segment_generation",
  `"sourceGeneration" >= 0`,
)
@Check(
  "CHK_historic_backfill_department_segment_signature",
  `"inputSignature" ~ '^[0-9a-f]{64}$'`,
)
@Check(
  "CHK_historic_backfill_department_segment_payloads",
  `jsonb_typeof("restriction") = 'object' AND jsonb_typeof("situation") = 'object'`,
)
@Check(
  "CHK_historic_backfill_department_segment_artifact",
  `length("geojsonObjectKey") > 0 AND "geojsonChecksum" ~ '^[0-9a-f]{64}$' AND "featureCount" >= 0`,
)
export class HistoricBackfillDepartmentSegment extends BaseEntity {
  @PrimaryColumn({ type: "uuid" })
  runId: string;

  @PrimaryColumn({ type: "integer" })
  departementId: number;

  @PrimaryColumn({ type: "date" })
  validFrom: string;

  @Column({ type: "date" })
  validThrough: string;

  @Column({ type: "bigint" })
  sourceGeneration: string;

  @Column({ type: "varchar", length: 64 })
  inputSignature: string;

  @Column({ type: "jsonb" })
  restriction: Record<string, unknown>;

  @Column({ type: "jsonb" })
  situation: Record<string, unknown>;

  @Column({ type: "text" })
  geojsonObjectKey: string;

  @Column({ type: "varchar", length: 64 })
  geojsonChecksum: string;

  @Column({ type: "integer" })
  featureCount: number;

  @CreateDateColumn({ type: "timestamp with time zone" })
  createdAt: Date;
}
