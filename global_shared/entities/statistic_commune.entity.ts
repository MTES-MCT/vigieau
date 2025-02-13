import { BaseEntity, Column, Entity, JoinColumn, ManyToOne, OneToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { Commune } from './commune.entity';

@Entity()
@Unique(['commune'])
export class StatisticCommune extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @OneToOne(() => Commune, (commune) => commune.statisticCommune)
  @JoinColumn()
  commune: Commune;

  @Column('jsonb',{ nullable: true })
  restrictions: any[];

  @Column('jsonb',{ nullable: true })
  restrictionsByMonth: any[];
}