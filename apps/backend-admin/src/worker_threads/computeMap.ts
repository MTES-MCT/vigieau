import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { workerData } from 'worker_threads';
import { RegleauLogger } from '../logger/regleau.logger';
import { withZoneComputeLock } from './zone-compute-lock';
import { SKIP_STARTUP_DATA_LOADS_ENV } from '../core/startup-data-loads';
import type { DailyZonePublicationReuseContext } from '../zone_publication/zone_publication.service';
import { finishCurrentZoneComputeWorker } from './finish-current-zone-compute';
import type { ZoneComputeWorkerResult } from './run-current-zone-compute';

const logger = new RegleauLogger('ComputeMapWorker');

interface WorkerData {
  depsIds: number[];
  skipIfBusy?: boolean;
  dailyPublicationReuse?: DailyZonePublicationReuseContext;
  publicationScheduledFor?: string;
}

async function run() {
  let app: INestApplicationContext | undefined;
  let response: ZoneComputeWorkerResult & { skipped?: boolean };
  process.env[SKIP_STARTUP_DATA_LOADS_ENV] = 'true';
  process.env.SKIP_STARTUP_DEPARTEMENT_STATISTICS = 'true';
  process.env.SANDRE_ZONE_SYNC_MODE = 'paused';
  process.env.DISABLE_SCHEDULED_JOBS = 'true';
  process.env.SKIP_SCHEMA_BOOTSTRAP = 'true';

  try {
    const [{ AppModule }, { ZoneAlerteComputedService }] = await Promise.all([
      import('../app.module.js'),
      import('../zone_alerte_computed/zone_alerte_computed.service.js'),
    ]);
    app = await NestFactory.createApplicationContext(AppModule);
    const zoneAlerteComputedService = app.get(ZoneAlerteComputedService);
    const dataSource = app.get(DataSource);
    const {
      depsIds,
      skipIfBusy,
      dailyPublicationReuse,
      publicationScheduledFor,
    } = workerData as WorkerData;

    logger.log(`Starting compute with depsIds: ${depsIds}`);
    const lockResult = await withZoneComputeLock(
      dataSource,
      depsIds,
      () =>
        zoneAlerteComputedService.computeAllOrReuseDailyPublication(
          depsIds,
          dailyPublicationReuse,
          publicationScheduledFor,
        ),
      { skipIfBusy },
    );
    logger.log('Compute map operation and lock cleanup completed');
    if (!lockResult.acquired) {
      logger.log('Another dyno is already computing zones; worker exits');
      response = { success: true, skipped: true };
    } else {
      response = { success: true, result: lockResult.value };
    }
  } catch (error) {
    logger.error('Error in compute map worker', error);
    response = {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  await finishCurrentZoneComputeWorker(
    async () => {
      await app?.close();
    },
    response,
    logger,
  );
}

run();
