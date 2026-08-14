import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ExternalPublicationRegistryService } from '../datagouv/external-publication-registry.service';
import { ClockHeartbeatService } from '../core/scheduling/clock-heartbeat.service';
import { ZonePublicationHealthService } from './zone-publication-health.service';

@Module({
  controllers: [HealthController],
  providers: [
    ExternalPublicationRegistryService,
    ClockHeartbeatService,
    ZonePublicationHealthService,
  ],
})
export class HealthModule {}
