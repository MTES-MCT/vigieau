import {
  BaseEntity,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from "typeorm";
import { Departement } from "./departement.entity";

@Entity("sandre_zone_sync_state")
@Unique("UQ_sandre_zone_sync_state_departement", ["departement"])
export class SandreZoneSyncState extends BaseEntity {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: "PK_sandre_zone_sync_state",
  })
  id: number;

  @ManyToOne(() => Departement, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({
    name: "departementId",
    foreignKeyConstraintName: "FK_sandre_zone_sync_state_departement",
  })
  departement: Departement;

  @Column({ type: "date", nullable: true })
  sourceUpdatedAt: string;

  @Column({ nullable: true, length: 64 })
  snapshotHash: string;

  @Column({ nullable: true, length: 64 })
  latestFeaturesHash: string;

  @Column({ type: "date", nullable: true })
  observedSourceUpdatedAt: string | null;

  @Column({ nullable: true, length: 64 })
  observedSnapshotHash: string | null;

  @Column({ nullable: true, length: 64 })
  observedLatestFeaturesHash: string | null;

  @Column({ nullable: false, default: 0 })
  observedFeatureCount: number;

  @Column({ type: "timestamptz", nullable: true })
  lastObservedAt: Date | null;

  @Column({ type: "date", nullable: true })
  appliedSourceUpdatedAt: string | null;

  @Column({ nullable: true, length: 64 })
  appliedSnapshotHash: string | null;

  @Column({ nullable: false, default: 0 })
  appliedFeatureCount: number;

  @Column({ type: "timestamptz", nullable: true })
  lastAppliedAt: Date | null;

  @Column({ type: "timestamptz", nullable: true })
  snapshotStartedAt: Date;

  @Column({ type: "timestamptz", nullable: true })
  lastFullSyncAt: Date;

  @Column({ type: "timestamptz", nullable: true })
  lastSuccessAt: Date;

  @Column({ nullable: false, default: 0 })
  featureCount: number;

  @Column({ nullable: false, default: false })
  needsRecompute: boolean;

  @Column({ nullable: false, default: 0 })
  recomputeRevision: number;

  @Column({ type: "timestamptz", nullable: true })
  blockedAt: Date | null;

  @Column({ type: "text", nullable: true })
  blockedReason: string | null;

  @Column({ nullable: true, length: 64 })
  blockedSnapshotHash: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
