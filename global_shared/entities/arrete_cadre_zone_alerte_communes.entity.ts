import { BaseEntity, Entity, JoinTable, ManyToMany, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { ZoneAlerte } from './zone_alerte.entity';
import { ArreteCadre } from './arrete_cadre.entity';
import { Commune } from './commune.entity';

@Entity()
@Unique('UQ_ac_za_communes_arrete_cadre_zone', ['arreteCadre', 'zoneAlerte'])
export class ArreteCadreZoneAlerteCommunes extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => ZoneAlerte, (zoneAlerte) => zoneAlerte.arreteCadreZoneAlerteCommunes, { nullable: false })
  zoneAlerte: ZoneAlerte;

  @ManyToOne(() => ArreteCadre, (arreteCadre) => arreteCadre.arreteCadreZoneAlerteCommunes,
    { nullable: false, onDelete: 'CASCADE' })
  arreteCadre: ArreteCadre;

  @ManyToMany(() => Commune, (commune) => commune.arreteCadreZoneAlerteCommunes)
  @JoinTable({
    name: 'ac_za_communes'
  })
  communes: Commune[];
}
