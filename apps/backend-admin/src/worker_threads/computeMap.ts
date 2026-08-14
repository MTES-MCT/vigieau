import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { workerData, parentPort } from 'worker_threads';
import { RegleauLogger } from '../logger/regleau.logger';
import { withZoneComputeLock } from './zone-compute-lock';
import { SKIP_STARTUP_DATA_LOADS_ENV } from '../core/startup-data-loads';
import type { DailyZonePublicationReuseContext } from '../zone_publication/zone_publication.service';

const logger = new RegleauLogger('ComputeMapWorker');

interface WorkerData {
  depsIds: number[];
  skipIfBusy?: boolean;
  dailyPublicationReuse?: DailyZonePublicationReuseContext;
  publicationScheduledFor?: string;
}

async function closeApp(app: INestApplicationContext | undefined) {
  if (app) {
    await app.close();
  }
}

async function run() {
  let app: INestApplicationContext | undefined;
  let responseSent = false;
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
    if (!lockResult.acquired) {
      logger.log('Another dyno is already computing zones; worker exits');
      await closeApp(app);
      app = undefined;
      parentPort?.postMessage({ success: true, skipped: true });
      responseSent = true;
      return;
    }
    const response = { success: true, result: lockResult.value };

    await closeApp(app);
    app = undefined;
    parentPort?.postMessage(response);
    responseSent = true;
  } catch (error) {
    logger.error('Error in compute map worker', error);
    if (!responseSent) {
      let responseError = error;
      try {
        await closeApp(app);
        app = undefined;
      } catch (closeError) {
        logger.error('Error while closing compute map worker', closeError);
        responseError = closeError;
      }
      parentPort?.postMessage({
        success: false,
        error:
          responseError instanceof Error
            ? responseError.message
            : String(responseError),
      });
      responseSent = true;
    }
  } finally {
    try {
      await closeApp(app);
    } catch (error) {
      logger.error('Error while closing compute map worker', error);
    }
    parentPort?.close();
  }
}

run();
