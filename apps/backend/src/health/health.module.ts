import { Module } from '@nestjs/common';
import { ZonesModule } from '../zones/zones.module';
import { HealthController } from './health.controller';

@Module({
  imports: [ZonesModule],
  controllers: [HealthController],
})
export class HealthModule {}
