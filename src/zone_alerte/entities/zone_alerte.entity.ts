import {
  BaseEntity,
  Column,
  CreateDateColumn,
  Entity,
  ManyToMany,
  ManyToOne,
  OneToMany,
  Polygon,
  PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';
import { ArreteCadre } from '../../arrete_cadre/entities/arrete_cadre.entity';
import { BassinVersant } from '../../bassin_versant/entities/bassin_versant.entity';
import { Departement } from '../../departement/entities/departement.entity';
import { Restriction } from '../../restriction/entities/restriction.entity';
import { ArreteCadreZoneAlerteCommunes } from '../../arrete_cadre_zone_alerte_communes/entities/arrete_cadre_zone_alerte_communes.entity';

@Entity()
export class ZoneAlerte extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ nullable: true })
  idSandre: number;

  @Column({ nullable: false, length: 200 })
  nom: string;

  @Column({ nullable: false, length: 32 })
  code: string;

  @Column({ nullable: false, length: 50 })
  type: 'SOU' | 'SUP';

  @Column({ default: false, nullable: false })
  ressourceInfluencee: boolean;

  @Column({ nullable: true })
  numeroVersion: number;

  @Column({ nullable: true })
  numeroVersionSandre: number;

  @Column({
    type: 'geometry',
    nullable: false,
    select: false,
  })
  geom: Polygon;

  @Column({ nullable: false, default: false })
  disabled: boolean;

  @ManyToOne(() => Departement, (departement) => departement.zonesAlerte)
  departement: Departement;

  @ManyToOne(() => BassinVersant, (bassinVersant) => bassinVersant.zonesAlerte)
  bassinVersant: BassinVersant;

  @ManyToMany(() => ArreteCadre, (arreteCadre) => arreteCadre.zonesAlerte)
  arretesCadre: ArreteCadre[];

  @OneToMany(() => Restriction, (restriction) => restriction.zoneAlerte)
  restrictions: Restriction[];

  @OneToMany(() => ArreteCadreZoneAlerteCommunes, (arreteCadreZoneAlerteCommunes) => arreteCadreZoneAlerteCommunes.zoneAlerte)
  arreteCadreZoneAlerteCommunes: ArreteCadreZoneAlerteCommunes[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
