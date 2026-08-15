import { BaseEntity, Check, Column, Entity, PrimaryColumn } from "typeorm";

@Entity({ name: "statistic_cache_state" })
@Check("CHK_statistic_cache_state_singleton", `"id" = 1`)
@Check(
  "CHK_statistic_cache_state_distinct_publications",
  `
    "activePublicationId" IS NULL
    OR "previousPublicationId" IS NULL
    OR "activePublicationId" <> "previousPublicationId"
  `,
)
export class StatisticCacheState extends BaseEntity {
  @PrimaryColumn({ type: "integer", default: 1 })
  id: number;

  @Column({ type: "uuid", nullable: true })
  activePublicationId: string | null;

  @Column({ type: "uuid", nullable: true })
  previousPublicationId: string | null;

  @Column({ type: "date", nullable: true })
  historicRecoveryMonthlyFrom: string | null;

  @Column({ type: "timestamp with time zone", default: () => "now()" })
  updatedAt: Date;
}
