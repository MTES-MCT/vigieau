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
} from 'typeorm';
import { Departement } from './departement.entity';

@Entity('sandre_zone_sync_state')
@Unique('UQ_sandre_zone_sync_state_departement', ['departement'])
export class SandreZoneSyncState extends BaseEntity {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_sandre_zone_sync_state',
  })
  id: number;

  @ManyToOne(() => Departement, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'departementId',
    foreignKeyConstraintName: 'FK_sandre_zone_sync_state_departement',
  })
  departement: Departement;

  @Column({ type: 'date', nullable: true })
  sourceUpdatedAt: string;

  @Column({ nullable: true, length: 64 })
  snapshotHash: string;

  @Column({ nullable: true, length: 64 })
  latestFeaturesHash: string;

  @Column({ type: 'timestamptz', nullable: true })
  snapshotStartedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  lastFullSyncAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  lastSuccessAt: Date;

  @Column({ nullable: false, default: 0 })
  featureCount: number;

  @Column({ nullable: false, default: false })
  needsRecompute: boolean;

  @Column({ nullable: false, default: 0 })
  recomputeRevision: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
