import {
  BaseEntity,
  Column,
  Entity,
  JoinTable,
  ManyToMany,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { ZoneAlerte } from './zone_alerte.entity';
import { NiveauGravite } from '../types/niveau_gravite.type';
import { ArreteRestriction } from './arrete_restriction.entity';
import { Commune } from './commune.entity';
import { ArreteCadre } from './arrete_cadre.entity';
import { Usage } from './usage.entity';
import { ZoneAlerteComputed } from './zone_alerte_computed.entity';
import { ZoneAlerteComputedHistoric } from './zone_alerte_computed_historic.entity';

@Entity()
@Unique(['arreteRestriction', 'zoneAlerte'])
export class Restriction extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ nullable: true, length: 255 })
  nomGroupementAep: string;

  @ManyToOne(
    () => ArreteRestriction,
    (arreteRestriction) => arreteRestriction.restrictions,
    { nullable: false, persistence: false, onDelete: 'CASCADE' },
  )
  arreteRestriction: ArreteRestriction;

  @ManyToOne(() => ZoneAlerte, (zoneAlerte) => zoneAlerte.restrictions)
  zoneAlerte: ZoneAlerte;

  @OneToMany(() => ZoneAlerteComputed, (zoneAlerteComputed) => zoneAlerteComputed.restriction)
  zonesAlerteComputed: ZoneAlerteComputed[];

  @OneToMany(() => ZoneAlerteComputedHistoric, (zoneAlerteComputedHistoric) => zoneAlerteComputedHistoric.restriction)
  zonesAlerteComputedHistoric: ZoneAlerteComputedHistoric[];

  @ManyToOne(() => ArreteCadre, (arreteCadre) => arreteCadre.restrictions)
  arreteCadre: ArreteCadre;

  @Column('enum', {
    name: 'niveauGravite',
    enum: ['vigilance', 'alerte', 'alerte_renforcee', 'crise'],
    nullable: true,
  })
  niveauGravite: NiveauGravite;

  @OneToMany(
    () => Usage,
    (usages) => usages.restriction,
    { persistence: false },
  )
  usages: Usage[];

  @ManyToMany(() => Commune, (commune) => commune.restrictions)
  @JoinTable({
    name: 'restriction_commune',
  })
  communes: Commune[];
}
