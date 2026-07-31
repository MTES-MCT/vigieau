import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource, QueryRunner } from 'typeorm';
import { workerData, parentPort } from 'worker_threads';
import { RegleauLogger } from '../logger/regleau.logger';

const logger = new RegleauLogger('ComputeMapWorker');
const COMPUTE_LOCK_TIMEOUT_MS = 60 * 60 * 1000;

interface WorkerData {
  depsIds: number[];
  computeHistoric: boolean;
}

async function acquireComputeLock(
  dataSource: DataSource,
): Promise<QueryRunner> {
  const deadline = Date.now() + COMPUTE_LOCK_TIMEOUT_MS;
  while (true) {
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      const [lockResult] = await queryRunner.query(
        "SELECT pg_try_advisory_lock(hashtext('vigieau'), hashtext('zone-compute-global')) AS locked",
      );
      if (lockResult?.locked === true) {
        return queryRunner;
      }
    } catch (error) {
      await queryRunner.release();
      throw error;
    }
    await queryRunner.release();
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the zone compute lock');
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function acquireDepartmentLocks(
  queryRunner: QueryRunner,
  depsIds: number[],
  acquiredDepartmentIds: number[],
): Promise<void> {
  const departmentIds =
    depsIds.length > 0
      ? [...new Set(depsIds)].sort((left, right) => left - right)
      : (await queryRunner.query('SELECT id FROM departement ORDER BY id')).map(
          (row) => Number(row.id),
        );
  const deadline = Date.now() + COMPUTE_LOCK_TIMEOUT_MS;

  for (const departmentId of departmentIds) {
    while (true) {
      const [lockResult] = await queryRunner.query(
        "SELECT pg_try_advisory_lock(hashtext('vigieau:sandre-zone-sync'), $1) AS locked",
        [departmentId],
      );
      if (lockResult?.locked === true) {
        acquiredDepartmentIds.push(departmentId);
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for department ${departmentId} zone synchronization`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function withComputeLock<T>(
  dataSource: DataSource,
  depsIds: number[],
  task: () => Promise<T>,
): Promise<T> {
  const queryRunner = await acquireComputeLock(dataSource);
  const departmentIds: number[] = [];
  try {
    await acquireDepartmentLocks(queryRunner, depsIds, departmentIds);
    return await task();
  } finally {
    let unlockError: unknown;
    for (const departmentId of [...departmentIds].reverse()) {
      try {
        const [unlockResult] = await queryRunner.query(
          "SELECT pg_advisory_unlock(hashtext('vigieau:sandre-zone-sync'), $1) AS unlocked",
          [departmentId],
        );
        if (unlockResult?.unlocked !== true) {
          throw new Error(
            `Unable to release department ${departmentId} zone synchronization lock`,
          );
        }
      } catch (error) {
        unlockError ??= error;
      }
    }
    try {
      const [unlockResult] = await queryRunner.query(
        "SELECT pg_advisory_unlock(hashtext('vigieau'), hashtext('zone-compute-global')) AS unlocked",
      );
      if (unlockResult?.unlocked !== true) {
        throw new Error('Unable to release the zone compute lock');
      }
    } catch (error) {
      unlockError ??= error;
    }
    try {
      await queryRunner.release();
    } catch (error) {
      unlockError ??= error;
    }
    if (unlockError) {
      throw unlockError;
    }
  }
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
    const { depsIds, computeHistoric } = workerData as WorkerData;

    logger.log(
      `Starting compute with depsIds: ${depsIds} and computeHistoric: ${computeHistoric}`,
    );
    const result = await withComputeLock(dataSource, depsIds, () =>
      zoneAlerteComputedService.computeAll(depsIds, false),
    );
    const response = { success: true, result };

    if (computeHistoric) {
      parentPort?.postMessage(response);
      responseSent = true;
      await withHistoricComputeLock(dataSource, () =>
        zoneAlerteComputedService.computeHistoric(),
      );
    } else {
      await closeApp(app);
      app = undefined;
      parentPort?.postMessage(response);
      responseSent = true;
    }
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
