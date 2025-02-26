import { Module } from '@nestjs/common';
import { DepartementsService } from './departements.service';
import { DepartementsController } from './departements.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Departement } from '@shared/entities/departement.entity';
import { Statistic } from '@shared/entities/statistic.entity';
import { Region } from '@shared/entities/region.entity';
import { BassinVersant } from '@shared/entities/bassin_versant.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Departement, Statistic, Region, BassinVersant]),
  ],
  controllers: [DepartementsController],
  providers: [DepartementsService],
  exports: [DepartementsService],
})
export class DepartementsModule {}
