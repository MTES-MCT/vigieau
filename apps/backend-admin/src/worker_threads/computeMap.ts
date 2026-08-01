import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource, QueryRunner } from 'typeorm';
import { workerData, parentPort } from 'worker_threads';
import { RegleauLogger } from '../logger/regleau.logger';
import { withZoneComputeLock } from './zone-compute-lock';

const logger = new RegleauLogger('ComputeMapWorker');
const COMPUTE_LOCK_TIMEOUT_MS = 60 * 60 * 1000;

interface WorkerData {
  depsIds: number[];
  computeHistoric: boolean;
  skipIfBusy?: boolean;
}

async function withHistoricComputeLock<T>(
  dataSource: DataSource,
  task: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + COMPUTE_LOCK_TIMEOUT_MS;
  let queryRunner: QueryRunner;
  while (!queryRunner) {
    const candidate = dataSource.createQueryRunner();
    await candidate.connect();
    try {
      const [lockResult] = await candidate.query(
        "SELECT pg_try_advisory_lock(hashtext('vigieau'), hashtext('zone-compute-historic')) AS locked",
      );
      if (lockResult?.locked === true) {
        queryRunner = candidate;
        break;
      }
    } catch (error) {
      await candidate.release();
      throw error;
    }
    await candidate.release();
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the historic zone compute lock');
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  try {
    return await task();
  } finally {
    try {
      const [unlockResult] = await queryRunner.query(
        "SELECT pg_advisory_unlock(hashtext('vigieau'), hashtext('zone-compute-historic')) AS unlocked",
      );
      if (unlockResult?.unlocked !== true) {
        throw new Error('Unable to release the historic zone compute lock');
      }
    } finally {
      await queryRunner.release();
    }
  }
}

async function closeApp(app: INestApplicationContext | undefined) {
  if (app) {
    await app.close();
  }
}

async function run() {
  let app: INestApplicationContext | undefined;
  let responseSent = false;
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
    const { depsIds, computeHistoric, skipIfBusy } = workerData as WorkerData;

    logger.log(
      `Starting compute with depsIds: ${depsIds} and computeHistoric: ${computeHistoric}`,
    );
    const lockResult = await withZoneComputeLock(
      dataSource,
      depsIds,
      () => zoneAlerteComputedService.computeAll(depsIds, false),
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

    if (computeHistoric) {
      await withHistoricComputeLock(dataSource, () =>
        zoneAlerteComputedService.computeHistoric(true),
      );
    }
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
