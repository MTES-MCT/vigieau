import { NestFactory } from '@nestjs/core';
import { workerData, parentPort } from 'worker_threads';
import { AppModule } from '../app.module';
import { ZoneAlerteComputedHistoricService } from '../zone_alerte_computed/zone_alerte_computed_historic.service';
import { RegleauLogger } from '../logger/regleau.logger';
import moment from 'moment';

const logger = new RegleauLogger('ComputeHistoricWorker');

interface WorkerData {
  dateMin: string;
  dateStats?: string;
  type: 'maps' | 'mapsComputed';
}

async function cleanup(app: any) {
  try {
    await app.close();
  } catch (error) {
    logger.error('Error during cleanup', error.toString());
  }
}

async function run() {
  let app;
  try {
    app = await NestFactory.createApplicationContext(AppModule);
    const zoneAlerteComputedHistoricService = app.get(ZoneAlerteComputedHistoricService);

    const { dateMin, dateStats, type } = workerData as WorkerData;
    const dateMinMoment = moment(dateMin);
    const dateStatsMoment = dateStats ? moment(dateStats) : null;

    logger.log(`Starting compute historic ${type} with dateMin: ${dateMin} and dateStats: ${dateStats}`);
    
    let result;
    if (type === 'maps') {
      result = await zoneAlerteComputedHistoricService.computeHistoricMaps(dateMinMoment, dateStatsMoment);
    } else {
      result = await zoneAlerteComputedHistoricService.computeHistoricMapsComputed(dateMinMoment, dateStatsMoment);
    }
    
    if (parentPort) {
      parentPort.postMessage({ success: true, result });
    }

    await cleanup(app);
    process.exit(0);
  } catch (error) {
    logger.error('Error in compute historic worker', error.toString());
    if (app) {
      await cleanup(app);
    }
    if (parentPort) {
      parentPort.postMessage({ success: false, error: error.toString() });
    }
    process.exit(1);
  }
}

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', error.toString());
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection', reason.toString());
  process.exit(1);
});

run(); 