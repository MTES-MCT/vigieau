import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ExternalPublicationRegistryService } from '../datagouv/external-publication-registry.service';
import { ClockHeartbeatService } from '../core/scheduling/clock-heartbeat.service';
import { ZonePublicationHealthService } from './zone-publication-health.service';
import { HistoricExportReadinessService } from '../datagouv/historic-export-readiness.service';
import { ZonePublicationModule } from '../zone_publication/zone_publication.module';

@Module({
  imports: [ZonePublicationModule],
  controllers: [HealthController],
  providers: [
    ExternalPublicationRegistryService,
    HistoricExportReadinessService,
    ClockHeartbeatService,
    ZonePublicationHealthService,
  ],
})
export class HealthModule {}
