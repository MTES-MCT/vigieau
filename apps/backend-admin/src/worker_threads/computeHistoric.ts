import { NestFactory } from '@nestjs/core';
import { workerData, parentPort } from 'worker_threads';
import { RegleauLogger } from '../logger/regleau.logger';
import moment from 'moment';

const logger = new RegleauLogger('ComputeHistoricWorker');

interface WorkerData {
  dateMin: string;
  dateStats?: string;
  type: 'maps' | 'mapsComputed';
}

async function run() {
  let app;
  let response: { success: boolean; result?: any; error?: string };
  try {
    process.env.SKIP_STARTUP_DEPARTEMENT_STATISTICS = 'true';
    process.env.SANDRE_ZONE_SYNC_MODE = 'paused';
    process.env.DISABLE_SCHEDULED_JOBS = 'true';
    process.env.SKIP_SCHEMA_BOOTSTRAP = 'true';
    const [{ AppModule }, { ZoneAlerteComputedHistoricService }] =
      await Promise.all([
        import('../app.module.js'),
        import('../zone_alerte_computed/zone_alerte_computed_historic.service.js'),
      ]);
    app = await NestFactory.createApplicationContext(AppModule);
    const zoneAlerteComputedHistoricService = app.get(
      ZoneAlerteComputedHistoricService,
    );

    const { dateMin, dateStats, type } = workerData as WorkerData;
    const dateMinMoment = moment(dateMin);
    const dateStatsMoment = dateStats ? moment(dateStats) : null;

    logger.log(
      `Starting compute historic ${type} with dateMin: ${dateMin} and dateStats: ${dateStats}`,
    );

    let result;
    if (type === 'maps') {
      result = await zoneAlerteComputedHistoricService.computeHistoricMaps(
        dateMinMoment,
        dateStatsMoment,
      );
    } else {
      result =
        await zoneAlerteComputedHistoricService.computeHistoricMapsComputed(
          dateMinMoment,
          dateStatsMoment,
        );
    }

    response = { success: true, result };
  } catch (error) {
    logger.error('Error in compute historic worker', error.toString());
    response = {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      await app?.close();
    } catch (error) {
      logger.error(
        'Error while closing compute historic worker',
        String(error),
      );
      response = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      parentPort?.postMessage(response);
    } finally {
      parentPort?.close();
    }
  }
}

run();
