import { BaseEntity, Check, Column, Entity, PrimaryColumn } from "typeorm";

@Entity()
@Check(`id = 1`)
export class Config extends BaseEntity {
  @PrimaryColumn({ type: "int", default: () => `1`, nullable: false })
  id: number;

  @Column({ type: "date", nullable: true })
  computeMapDate: string;

  @Column({ type: "bigint", default: 0 })
  computeMapGeneration: string;

  @Column({ type: "timestamptz", nullable: true })
  computeMapUpdatedAt: Date;

  @Column({ type: "date", nullable: true })
  computeStatsDate: string;

  @Column({ type: "bigint", default: 0 })
  computeStatsGeneration: string;

  @Column({ type: "bigint", default: 0 })
  historicComputeEpoch: string;

  @Column({ type: "bigint", default: 0 })
  historicBackfillGlobalEpoch: string;

  @Column({ type: "timestamptz", nullable: true })
  computeStatsUpdatedAt: Date;

  @Column({ type: "timestamp", nullable: true })
  computeZoneAlerteComputedDate: Date;
}
