import { forwardRef, Module } from '@nestjs/common';
import { StatisticsService } from './statistics.service';
import { StatisticsController } from './statistics.controller';
import { HttpModule } from '@nestjs/axios';
import { DepartementsModule } from '../departements/departements.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Statistic } from '@shared/entities/statistic.entity';
import { MatomoStatisticsClient } from './matomo-statistics.client';
import { MatomoStatisticsRunService } from './matomo-statistics-run.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Statistic]),
    HttpModule,
    DepartementsModule,
    forwardRef(() => SubscriptionsModule),
  ],
  controllers: [StatisticsController],
  providers: [
    StatisticsService,
    MatomoStatisticsClient,
    MatomoStatisticsRunService,
  ],
  exports: [StatisticsService],
})
export class StatisticsModule {}
