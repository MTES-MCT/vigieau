import {
  BaseEntity,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn, JoinTable,
  ManyToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { StatutArreteMunicipal } from '../types/arrete_municipal.type';
import { Fichier } from './fichier.entity';
import { Commune } from './commune.entity';

@Entity()
export class ArreteMunicipal extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'date', nullable: false })
  dateDebut: string;

  @Column({ type: 'date', nullable: false })
  dateFin: string;

  @OneToOne(() => Fichier, (fichier) => fichier.arreteMunicipal)
  @JoinColumn()
  fichier: Fichier;

  @Column('enum', {
    name: 'statut',
    enum: ['a_valider', 'a_venir', 'publie', 'abroge'],
    default: 'a_valider',
    nullable: false,
  })
  statut: StatutArreteMunicipal;

  @ManyToMany(
    () => Commune,
    (commune) => commune.arretesMunicipaux,
    { onDelete: 'CASCADE' },
  )
  @JoinTable({
    name: 'arrete_municipal_commune',
  })
  communes: Commune[];

  @Column({ nullable: false, length: 50 })
  userFirstName: string;

  @Column({ nullable: false, length: 50 })
  userLastName: string;

  @Column({ nullable: false, length: 200 })
  userEmail: string;

  @Column({ nullable: false, length: 50 })
  userPhone: string;

  @CreateDateColumn({ select: false, type: 'timestamp' })
  created_at: number;

  @UpdateDateColumn({ select: false, type: 'timestamp' })
  updated_at: number;
}
