import { Module } from '@nestjs/common';
import { StatisticCacheReadinessService } from './statistic_cache_readiness.service';

@Module({
  providers: [StatisticCacheReadinessService],
  exports: [StatisticCacheReadinessService],
})
export class StatisticCacheModule {}
