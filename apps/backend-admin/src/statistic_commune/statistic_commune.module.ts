import { forwardRef, Module } from '@nestjs/common';
import { StatisticCommuneService } from './statistic_commune.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StatisticCommune } from './entities/statistic_commune.entity';
import { CommuneModule } from '../commune/commune.module';
import { ZoneAlerteComputedModule } from '../zone_alerte_computed/zone_alerte_computed.module';
import { ZoneAlerteModule } from '../zone_alerte/zone_alerte.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([StatisticCommune]),
    CommuneModule,
    forwardRef(() => ZoneAlerteComputedModule),
    ZoneAlerteModule,
  ],
  providers: [StatisticCommuneService],
  exports: [StatisticCommuneService],
})
export class StatisticCommuneModule {
}
