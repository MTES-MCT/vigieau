import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StatisticDepartement } from '@shared/entities/statistic_departement.entity';
import { DataController } from './data.controller';
import { DataService } from './data.service';
import { Departement } from '@shared/entities/departement.entity';
import { Region } from '@shared/entities/region.entity';
import { BassinVersant } from '@shared/entities/bassin_versant.entity';
import { StatisticCommune } from '@shared/entities/statistic_commune.entity';
import { Commune } from '@shared/entities/commune.entity';

@Module({
  imports: [TypeOrmModule.forFeature([
    StatisticDepartement,
    StatisticCommune,
    Commune,
    Departement,
    Region,
    BassinVersant,
  ])],
  controllers: [DataController],
  providers: [DataService],
  exports: [DataService]
})
export class DataModule {
}