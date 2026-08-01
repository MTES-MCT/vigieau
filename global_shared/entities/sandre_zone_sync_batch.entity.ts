import {
  BaseEntity,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { Departement } from "./departement.entity";

@Entity("sandre_zone_sync_batch")
export class SandreZoneSyncBatch extends BaseEntity {
  @PrimaryGeneratedColumn({
    type: "bigint",
    primaryKeyConstraintName: "PK_sandre_zone_sync_batch",
  })
  id: string;

  @ManyToOne(() => Departement, { nullable: true, onDelete: "CASCADE" })
  @JoinColumn({
    name: "departementId",
    foreignKeyConstraintName: "FK_sandre_zone_sync_batch_departement",
  })
  @Index("IDX_sandre_zone_sync_batch_departement")
  departement: Departement | null;

  @Column({ nullable: false, length: 30 })
  kind: "snapshot" | "reconciliation";

  @Column({ nullable: false, length: 20 })
  mode: "audit" | "safe";

  @Column({ nullable: false, length: 30 })
  status: "started" | "observed" | "applied" | "blocked" | "failed";

  @Column({ nullable: true, length: 64 })
  snapshotHash: string | null;

  @Column({ type: "date", nullable: true })
  sourceUpdatedAt: string | null;

  @Column({ type: "integer", nullable: true })
  featureCount: number | null;

  @Column({ nullable: true, length: 64 })
  reportFingerprint: string | null;

  @Column({ type: "text", nullable: true })
  failureReason: string | null;

  @Column({ type: "jsonb", nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ type: "timestamptz", nullable: false })
  startedAt: Date;

  @Column({ type: "timestamptz", nullable: true })
  finishedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
