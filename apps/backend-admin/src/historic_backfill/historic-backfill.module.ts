import { Module } from '@nestjs/common';
import { DepartementModule } from '../departement/departement.module';
import { SharedModule } from '../shared/shared.module';
import { StatisticCommuneModule } from '../statistic_commune/statistic_commune.module';
import { StatisticDepartementModule } from '../statistic_departement/statistic_departement.module';
import { ZoneAlerteComputedModule } from '../zone_alerte_computed/zone_alerte_computed.module';
import { HistoricBackfillArtifactBuilderService } from './historic-backfill-artifact-builder.service';
import { HistoricBackfillArtifactQueueService } from './historic-backfill-artifact-queue.service';
import { HistoricBackfillArtifactWorkerLoop } from './historic-backfill-artifact-worker-loop';
import { HistoricBackfillController } from './historic-backfill.controller';
import { HistoricBackfillFinalizerService } from './historic-backfill-finalizer.service';
import { HistoricBackfillMapFinalizerService } from './historic-backfill-map-finalizer.service';
import { HistoricBackfillQueueService } from './historic-backfill-queue.service';
import {
  HISTORIC_BACKFILL_CURRENT_PRIORITY,
  HISTORIC_BACKFILL_DEPARTMENT_PAYLOAD_BUILDER,
  HISTORIC_BACKFILL_LEGACY_ZONE_PROVIDER,
  HISTORIC_BACKFILL_MAP_ARTIFACT_BUILDER,
  HistoricBackfillTaskHandlerService,
  SqlHistoricBackfillCurrentPriority,
} from './historic-backfill-task-handler';
import {
  HistoricBackfillDepartmentPayloadBuilderService,
  HistoricBackfillLegacyZoneProviderService,
  HistoricBackfillMapArtifactBuilderService,
} from './historic-backfill-task-providers.service';
import { HistoricBackfillWorkerLoop } from './historic-backfill-worker-loop';

@Module({
  imports: [
    DepartementModule,
    SharedModule,
    StatisticCommuneModule,
    StatisticDepartementModule,
    ZoneAlerteComputedModule,
  ],
  controllers: [HistoricBackfillController],
  providers: [
    HistoricBackfillQueueService,
    HistoricBackfillWorkerLoop,
    HistoricBackfillTaskHandlerService,
    HistoricBackfillArtifactQueueService,
    HistoricBackfillArtifactBuilderService,
    HistoricBackfillArtifactWorkerLoop,
    HistoricBackfillFinalizerService,
    HistoricBackfillMapFinalizerService,
    HistoricBackfillLegacyZoneProviderService,
    HistoricBackfillDepartmentPayloadBuilderService,
    HistoricBackfillMapArtifactBuilderService,
    SqlHistoricBackfillCurrentPriority,
    {
      provide: HISTORIC_BACKFILL_LEGACY_ZONE_PROVIDER,
      useExisting: HistoricBackfillLegacyZoneProviderService,
    },
    {
      provide: HISTORIC_BACKFILL_DEPARTMENT_PAYLOAD_BUILDER,
      useExisting: HistoricBackfillDepartmentPayloadBuilderService,
    },
    {
      provide: HISTORIC_BACKFILL_MAP_ARTIFACT_BUILDER,
      useExisting: HistoricBackfillMapArtifactBuilderService,
    },
    {
      provide: HISTORIC_BACKFILL_CURRENT_PRIORITY,
      useExisting: SqlHistoricBackfillCurrentPriority,
    },
  ],
  exports: [
    HistoricBackfillQueueService,
    HistoricBackfillWorkerLoop,
    HistoricBackfillTaskHandlerService,
    HistoricBackfillArtifactQueueService,
    HistoricBackfillArtifactWorkerLoop,
    HistoricBackfillFinalizerService,
    HistoricBackfillMapFinalizerService,
  ],
})
export class HistoricBackfillModule {}
