import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ExternalPublicationRegistryService } from '../datagouv/external-publication-registry.service';
import { ClockHeartbeatService } from '../core/scheduling/clock-heartbeat.service';

@Module({
  controllers: [HealthController],
  providers: [ExternalPublicationRegistryService, ClockHeartbeatService],
})
export class HealthModule {}
