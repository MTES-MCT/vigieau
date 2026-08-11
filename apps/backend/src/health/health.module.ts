import { Module } from '@nestjs/common';
import { DataModule } from '../data/data.module';
import { ZonesModule } from '../zones/zones.module';
import { HealthController } from './health.controller';

@Module({
  imports: [ZonesModule, DataModule],
  controllers: [HealthController],
})
export class HealthModule {}
