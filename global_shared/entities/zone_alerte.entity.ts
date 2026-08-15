import {
  BaseEntity,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToMany,
  ManyToOne,
  OneToMany,
  Polygon,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { ArreteCadre } from "./arrete_cadre.entity";
import { BassinVersant } from "./bassin_versant.entity";
import { Departement } from "./departement.entity";
import { Restriction } from "./restriction.entity";
import { ArreteCadreZoneAlerteCommunes } from "./arrete_cadre_zone_alerte_communes.entity";

@Entity()
@Index("IDX_zone_alerte_code_sandre_unique", ["codeSandre"], {
  unique: true,
  where: '"codeSandre" IS NOT NULL',
})
export class ZoneAlerte extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ nullable: true })
  idSandre: number;

  @Column({ nullable: true, length: 32, select: false })
  codeSandre: string;

  @Column({ nullable: true, length: 20, select: false })
  statutSandre: string;

  @Column({ type: "date", nullable: true, select: false })
  dateMajSandre: string;

  @Column({ type: "jsonb", nullable: true, select: false })
  codesAlternatifs: string[];

  @Column({ nullable: true, length: 64, select: false })
  sandrePayloadHash: string;

  @Column({
    type: "varchar",
    length: 30,
    nullable: false,
    default: "legacy_unverified",
    select: false,
  })
  sandreProvenance: "official" | "legacy_unverified" | "local_preserved";

  @Column({ nullable: false, length: 200 })
  nom: string;

  @Column({ nullable: false, length: 32 })
  code: string;

  @Column({ nullable: false, length: 50 })
  type: "SOU" | "SUP";

  @Column({ default: false, nullable: false })
  ressourceInfluencee: boolean;

  @Column({ nullable: true })
  numeroVersion: number;

  @Column({ nullable: true })
  numeroVersionSandre: number;

  @Column({
    type: "geometry",
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

  @OneToMany(
    () => ArreteCadreZoneAlerteCommunes,
    (arreteCadreZoneAlerteCommunes) => arreteCadreZoneAlerteCommunes.zoneAlerte,
  )
  arreteCadreZoneAlerteCommunes: ArreteCadreZoneAlerteCommunes[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
