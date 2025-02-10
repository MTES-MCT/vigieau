import { Module } from '@nestjs/common';
import { StatisticService } from './statistic.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Statistic } from './entities/statistic.entity';
import { DepartementModule } from '../departement/departement.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Statistic]),
    DepartementModule
  ],
  controllers: [],
  providers: [StatisticService],
  exports: [StatisticService],
})
export class StatisticModule {
}
