import {
  BaseEntity,
  Column,
  CreateDateColumn,
  Entity, Index, JoinTable, ManyToMany,
  ManyToOne,
  Polygon,
  PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';
import { BassinVersant } from '../../bassin_versant/entities/bassin_versant.entity';
import { Departement } from '../../departement/entities/departement.entity';
import { Restriction } from '../../restriction/entities/restriction.entity';
import { NiveauGravite } from '../../arrete_restriction/type/niveau_gravite.type';
import { Commune } from '../../commune/entities/commune.entity';

@Entity()
export class ZoneAlerteComputed extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ nullable: true })
  idSandre: number;

  @Column({ nullable: false, length: 200 })
  nom: string;

  @Column({ nullable: true, length: 32 })
  code: string;

  @Column({ nullable: false, length: 50 })
  type: 'SOU' | 'SUP' | 'AEP';

  @Column({ default: false, nullable: false })
  ressourceInfluencee: boolean;

  @Column({ default: false })
  enabled: boolean;

  @Column({
    type: 'geometry',
    nullable: false,
    select: false,
  })
  geom: Polygon;

  @Column('enum', {
    name: 'niveauGravite',
    enum: ['vigilance', 'alerte', 'alerte_renforcee', 'crise'],
    nullable: true,
  })
  niveauGravite: NiveauGravite;

  @ManyToOne(() => Departement, (departement) => departement.zoneAlerteComputed)
  @Index()
  departement: Departement;

  @ManyToOne(() => BassinVersant, (bassinVersant) => bassinVersant.zoneAlerteComputed)
  bassinVersant: BassinVersant;

  @ManyToOne(() => Restriction, (restriction) => restriction.zonesAlerteComputed, {
    onDelete: 'CASCADE',
  })
  restriction: Restriction;

  @ManyToMany(() => Commune, (commune) => commune.zonesAlerteComputed)
  @JoinTable({
    name: 'zone_alerte_computed_commune',
  })
  communes: Commune[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
