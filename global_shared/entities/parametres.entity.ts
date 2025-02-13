import {
  BaseEntity,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Departement } from './departement.entity';
import { SuperpositionCommune } from 'vigieau_admin_backend/src/parametres/type/parameters.type';

@Entity()
export class Parametres extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Departement, (departement) => departement.parametres)
  @JoinColumn()
  departement: Departement;

  @Column('enum', {
    name: 'superpositionCommune',
    enum: [
      'no',
      'no_all',
      'yes_distinct',
      'yes_all',
      'yes_except_aep',
      'yes_only_aep',
    ],
    nullable: false,
  })
  superpositionCommune: SuperpositionCommune;

  @Column({ type: 'date', nullable: false, default: '2024-04-29' })
  dateDebut: string;

  @Column({ type: 'date', nullable: true })
  dateFin: string;

  @Column({ nullable: false, default: false })
  disabled: boolean;
}
