import {
  BaseEntity,
  Column,
  Entity, JoinTable, ManyToMany,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ZoneAlerte } from '../../zone_alerte/entities/zone_alerte.entity';
import { ZoneAlerteComputed } from '../../zone_alerte_computed/entities/zone_alerte_computed.entity';
import { ZoneAlerteComputedHistoric } from '../../zone_alerte_computed/entities/zone_alerte_computed_historic.entity';
import { Departement } from '../../departement/entities/departement.entity';

@Entity()
export class BassinVersant extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ nullable: false })
  code: number;

  @Column({ nullable: false, length: 60 })
  nom: string;

  @OneToMany(() => ZoneAlerte, (zoneAlerte) => zoneAlerte.bassinVersant)
  zonesAlerte: ZoneAlerte[];

  @OneToMany(() => ZoneAlerteComputed, (zoneAlerteComputed) => zoneAlerteComputed.bassinVersant)
  zoneAlerteComputed: ZoneAlerteComputed[];

  @OneToMany(() => ZoneAlerteComputedHistoric, (zoneAlerteComputedHistoric) => zoneAlerteComputedHistoric.bassinVersant)
  zoneAlerteComputedHistoric: ZoneAlerteComputedHistoric[];

  @ManyToMany(() => Departement, (departement) => departement.bassinsVersants)
  @JoinTable({
    name: 'bassin_versant_departement',
  })
  departements: Departement[];
}
