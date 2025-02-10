import {
  BaseEntity,
  Column,
  CreateDateColumn,
  Entity,
  ManyToMany,
  ManyToOne,
  OneToOne,
  Polygon,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Departement } from '../../departement/entities/departement.entity';
import { Restriction } from '../../restriction/entities/restriction.entity';
import { ZoneAlerteComputed } from '../../zone_alerte_computed/entities/zone_alerte_computed.entity';
import { ZoneAlerteComputedHistoric } from '../../zone_alerte_computed/entities/zone_alerte_computed_historic.entity';
import { StatisticCommune } from '../../statistic_commune/entities/statistic_commune.entity';
import { ArreteMunicipal } from '../../arrete_municipal/entities/arrete_municipal.entity';
import { ArreteCadreZoneAlerteCommunes } from '../../arrete_cadre_zone_alerte_communes/entities/arrete_cadre_zone_alerte_communes.entity';

@Entity()
export class Commune extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true, nullable: false, length: 6 })
  code: string;

  @Column({ nullable: false })
  nom: string;

  @Column({ nullable: true })
  population: number;

  @Column({ nullable: true })
  siren: string;

  @Column({
    type: 'geometry',
    nullable: true,
    select: false,
  })
  geom: Polygon;

  @ManyToOne(() => Departement, (departement) => departement.communes)
  departement: Departement;

  @ManyToMany(() => Restriction, (restriction) => restriction.communes, {
    persistence: false,
  })
  restrictions: Restriction[];

  @ManyToMany(() => ZoneAlerteComputed, (zoneAlerteComputed) => zoneAlerteComputed.communes, {
    persistence: false,
  })
  zonesAlerteComputed: ZoneAlerteComputed[];

  @ManyToMany(() => ZoneAlerteComputedHistoric, (zoneAlerteComputedHistoric) => zoneAlerteComputedHistoric.communes, {
    persistence: false,
  })
  zonesAlerteComputedHistoric: ZoneAlerteComputedHistoric[];

  @OneToOne(() => StatisticCommune, (statisticCommune) => statisticCommune.commune)
  statisticCommune: StatisticCommune;

  @ManyToMany(() => ArreteMunicipal, (arreteMunicipal) => arreteMunicipal.communes, {
    persistence: false,
  })
  arretesMunicipaux: ArreteMunicipal[];

  @ManyToMany(() => ArreteCadreZoneAlerteCommunes, (arreteCadreZoneAlerteCommunes) => arreteCadreZoneAlerteCommunes.communes, {
    persistence: false,
  })
  arreteCadreZoneAlerteCommunes: ArreteCadreZoneAlerteCommunes[];

  @Column({ nullable: false, default: false })
  disabled: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
