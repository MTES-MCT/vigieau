import {
  BaseEntity,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToMany,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { RessourceEapCommunique, StatutArreteRestriction } from 'vigieau_admin_backend/src/arrete_restriction/type/statut_arrete_restriction.type';
import { ArreteCadre } from './arrete_cadre.entity';
import { Departement } from './departement.entity';
import { Restriction } from './restriction.entity';
import { Fichier } from './fichier.entity';
import { UsageFeedback } from './usage_feedback.entity';

@Entity()
export class ArreteRestriction extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ nullable: true, length: 50 })
  numero: string;

  @Column({ type: 'date', nullable: true })
  dateSignature: string;

  @Column({ type: 'date', nullable: true })
  dateDebut: string;

  @Column({ type: 'date', nullable: true })
  dateFin: string;

  @OneToOne(() => Fichier, (fichier) => fichier.arreteRestriction)
  @JoinColumn()
  fichier: Fichier;

  @Column('enum', {
    name: 'statut',
    enum: ['a_valider', 'a_venir', 'publie', 'abroge'],
    default: 'a_valider',
    nullable: false,
  })
  statut: StatutArreteRestriction;

  @Column({ nullable: true })
  niveauGraviteSpecifiqueEap: boolean;

  @Column('enum', {
    name: 'ressourceEapCommunique',
    enum: ['esu', 'eso', 'max'],
    nullable: true,
  })
  ressourceEapCommunique: RessourceEapCommunique;

  @ManyToOne(() => Departement, (departement) => departement.arretesRestriction)
  departement: Departement;

  @ManyToMany(
    () => ArreteCadre,
    (arreteCadre) => arreteCadre.arretesRestriction,
    { onDelete: 'CASCADE' },
  )
  arretesCadre: ArreteCadre[];

  @OneToMany(
    () => Restriction,
    (restriction) => restriction.arreteRestriction,
    { persistence: false },
  )
  restrictions: Restriction[];

  @ManyToOne(
    () => ArreteRestriction,
    (arreteRestriction) => arreteRestriction.arretesRestriction,
  )
  arreteRestrictionAbroge: ArreteRestriction;

  @OneToMany(
    () => ArreteRestriction,
    (arreteRestriction) => arreteRestriction.arreteRestrictionAbroge,
  )
  arretesRestriction: ArreteRestriction[];

  @OneToMany(
    () => UsageFeedback,
    (usageFeedback) => usageFeedback.arreteRestriction,
  )
  usageFeedbacks: UsageFeedback[];

  @CreateDateColumn({ select: false, type: 'timestamp' })
  created_at: number;

  @UpdateDateColumn({ select: false, type: 'timestamp' })
  updated_at: number;

  @Column({ select: false, type: 'timestamp', nullable: true })
  updatedByHuman: Date;
}
