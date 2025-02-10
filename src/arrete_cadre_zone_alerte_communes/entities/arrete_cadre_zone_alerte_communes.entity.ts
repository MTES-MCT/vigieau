import { BaseEntity, Entity, JoinTable, ManyToMany, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { ZoneAlerte } from '../../zone_alerte/entities/zone_alerte.entity';
import { ArreteCadre } from '../../arrete_cadre/entities/arrete_cadre.entity';
import { Commune } from '../../commune/entities/commune.entity';

@Entity()
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