import { BaseEntity, Column, CreateDateColumn, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { ArreteRestriction } from '../../arrete_restriction/entities/arrete_restriction.entity';
import { FilterOperator, PaginateConfig } from 'nestjs-paginate';
import { ArreteCadre } from '../../arrete_cadre/entities/arrete_cadre.entity';

@Entity()
export class UsageFeedback extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => ArreteRestriction,
    (arreteRestriction) => arreteRestriction.usageFeedbacks,
    { nullable: false, onDelete: 'CASCADE' })
  arreteRestriction: ArreteRestriction;

  @Column({ nullable: true, length: 255 })
  usageNom: string;

  @Column({ nullable: true, length: 255 })
  usageThematique: string;

  @Column({ nullable: true, length: 3000 })
  usageDescription: string;

  @Column({ nullable: true, length: 255 })
  feedback: string;

  @Column({ nullable: false, default: false })
  archived: boolean;

  @CreateDateColumn()
  createdAt: Date;
}

export const usageFeedbackPaginateConfig: PaginateConfig<UsageFeedback> = {
  select: [
    'id',
    'usageNom',
    'usageThematique',
    'usageDescription',
    'feedback',
    'createdAt',
    'arreteRestriction.id',
    'arreteRestriction.numero',
    'arreteRestriction.statut',
  ],
  sortableColumns: ['createdAt'],
  defaultSortBy: [['createdAt', 'DESC']],
  nullSort: 'first',
  relations: [
    'arreteRestriction',
  ],
  filterableColumns: {
    archived: [FilterOperator.EQ],
  },
  where: {
    archived: false,
  }
};