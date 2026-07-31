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
} from 'typeorm';
import { Departement } from './departement.entity';
import { ZoneAlerte } from './zone_alerte.entity';

@Entity('sandre_zone_alias')
@Unique('UQ_sandre_zone_alias_identity', [
  'departement',
  'zoneType',
  'aliasType',
  'aliasValue',
])
export class SandreZoneAlias extends BaseEntity {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_sandre_zone_alias',
  })
  id: number;

  @ManyToOne(() => Departement, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'departementId',
    foreignKeyConstraintName: 'FK_sandre_zone_alias_departement',
  })
  @Index('IDX_sandre_zone_alias_departement')
  departement: Departement;

  @ManyToOne(() => ZoneAlerte, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'zoneAlerteId',
    foreignKeyConstraintName: 'FK_sandre_zone_alias_zone',
  })
  @Index('IDX_sandre_zone_alias_zone')
  zoneAlerte: ZoneAlerte;

  @Column({ nullable: false, length: 50 })
  zoneType: 'SOU' | 'SUP';

  @Column({ nullable: false, length: 30 })
  aliasType: 'cd_zas';

  @Column({ nullable: false, length: 64 })
  aliasValue: string;

  @Column({ nullable: false, length: 30 })
  source: 'sandre_genealogy' | 'manual_reconciliation';

  @CreateDateColumn()
  createdAt: Date;
}
