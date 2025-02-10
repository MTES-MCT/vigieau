import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StatisticDepartement } from './entities/statistic_departement.entity';
import { StatisticDepartementService } from './statistic_departement.service';
import { Statistic } from '../statistic/entities/statistic.entity';
import { DepartementModule } from '../departement/departement.module';
import { StatisticDepartementController } from './statistic_departement.controller';
import { ZoneAlerteComputedModule } from '../zone_alerte_computed/zone_alerte_computed.module';
import { ZoneAlerteModule } from '../zone_alerte/zone_alerte.module';
import { AbonnementMailModule } from '../abonnement_mail/abonnement_mail.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([StatisticDepartement, Statistic]),
    DepartementModule,
    forwardRef(() => ZoneAlerteComputedModule),
    ZoneAlerteModule,
    AbonnementMailModule,
  ],
  providers: [StatisticDepartementService],
  exports: [StatisticDepartementService],
  controllers: [StatisticDepartementController],
})
export class StatisticDepartementModule {
}
