import {
  BaseEntity,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from "typeorm";
import { Departement } from "./departement.entity";
import { SandreZoneSyncBatch } from "./sandre_zone_sync_batch.entity";
import { ZoneAlerte } from "./zone_alerte.entity";

@Entity("sandre_zone_sync_decision")
@Unique("UQ_sandre_zone_sync_decision_key", ["batch", "decisionKey"])
export class SandreZoneSyncDecision extends BaseEntity {
  @PrimaryGeneratedColumn({
    type: "bigint",
    primaryKeyConstraintName: "PK_sandre_zone_sync_decision",
  })
  id: string;

  @ManyToOne(() => SandreZoneSyncBatch, {
    nullable: false,
    onDelete: "CASCADE",
  })
  @JoinColumn({
    name: "batchId",
    foreignKeyConstraintName: "FK_sandre_zone_sync_decision_batch",
  })
  @Index("IDX_sandre_zone_sync_decision_batch")
  batch: SandreZoneSyncBatch;

  @ManyToOne(() => Departement, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({
    name: "departementId",
    foreignKeyConstraintName: "FK_sandre_zone_sync_decision_departement",
  })
  @Index("IDX_sandre_zone_sync_decision_departement")
  departement: Departement;

  @ManyToOne(() => ZoneAlerte, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({
    name: "zoneAlerteId",
    foreignKeyConstraintName: "FK_sandre_zone_sync_decision_zone",
  })
  zoneAlerte: ZoneAlerte | null;

  @ManyToOne(() => ZoneAlerte, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({
    name: "candidateZoneAlerteId",
    foreignKeyConstraintName: "FK_sandre_zone_sync_decision_candidate_zone",
  })
  candidateZoneAlerte: ZoneAlerte | null;

  @Column({ nullable: false, length: 128 })
  decisionKey: string;

  @Column({ nullable: false, length: 30 })
  zoneType: "SOU" | "SUP";

  @Column({ nullable: true, length: 64 })
  sourceCode: string | null;

  @Column({ nullable: true, length: 64 })
  targetCode: string | null;

  @Column({ nullable: false, length: 50 })
  action: string;

  @Column({ nullable: false, length: 30 })
  outcome: "observed" | "applied" | "blocked" | "deferred";

  @Column({ nullable: false, length: 100 })
  reason: string;

  @Column({ type: "jsonb", nullable: true })
  evidence: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt: Date;
}
