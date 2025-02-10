import {
  BaseEntity,
  Column,
  Entity,
  ManyToMany,
  ManyToOne,
  OneToMany,
  Polygon,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ZoneAlerte } from '../../zone_alerte/entities/zone_alerte.entity';
import { ArreteCadre } from '../../arrete_cadre/entities/arrete_cadre.entity';
import { Region } from '../../core/entities/region.entity';
import { ArreteRestriction } from '../../arrete_restriction/entities/arrete_restriction.entity';
import { Commune } from '../../commune/entities/commune.entity';
import { Parametres } from '../../parametres/entities/parametres.entity';
import { ZoneAlerteComputed } from '../../zone_alerte_computed/entities/zone_alerte_computed.entity';
import { StatisticDepartement } from '../../statistic_departement/entities/statistic_departement.entity';
import { ZoneAlerteComputedHistoric } from '../../zone_alerte_computed/entities/zone_alerte_computed_historic.entity';
import { BassinVersant } from '../../bassin_versant/entities/bassin_versant.entity';

@Entity()
export class Departement extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true, nullable: false, length: 3 })
  code: string;

  @Column({ nullable: false, length: 60 })
  nom: string;

  @Column({
    type: 'geometry',
    nullable: true,
    select: false,
  })
  geom: Polygon;

  @ManyToOne(() => Region, (region) => region.departements)
  region: Region;

  @ManyToMany(() => BassinVersant, (bassinVersant) => bassinVersant.departements)
  bassinsVersants: BassinVersant[];

  @OneToMany(() => Commune, (communes) => communes.departement)
  communes: Commune[];

  @OneToMany(() => ZoneAlerte, (zoneAlerte) => zoneAlerte.departement)
  zonesAlerte: ZoneAlerte[];

  @OneToMany(() => ZoneAlerteComputed, (zoneAlerteComputed) => zoneAlerteComputed.departement)
  zoneAlerteComputed: ZoneAlerteComputed[];

  @OneToMany(() => ZoneAlerteComputedHistoric, (zoneAlerteComputedHistoric) => zoneAlerteComputedHistoric.departement)
  zoneAlerteComputedHistoric: ZoneAlerteComputedHistoric[];

  @ManyToMany(() => ArreteCadre, (arreteCadre) => arreteCadre.departements)
  arretesCadre: ArreteCadre[];

  @OneToMany(() => ArreteCadre, (arreteCadre) => arreteCadre.departementPilote)
  arretesCadrePilote: ArreteCadre[];

  @OneToMany(
    () => ArreteRestriction,
    (arreteRestriction) => arreteRestriction.departement,
  )
  arretesRestriction: ArreteRestriction[];

  @OneToMany(() => Parametres, (parametres) => parametres.departement)
  parametres: Parametres[];

  @OneToMany(() => StatisticDepartement, (statisticDepartement) => statisticDepartement.departement)
  statisticDepartement: StatisticDepartement[];
}
