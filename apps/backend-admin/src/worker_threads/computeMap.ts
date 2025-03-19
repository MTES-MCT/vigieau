import { NestFactory } from '@nestjs/core';
import { workerData, parentPort } from 'worker_threads';
import { AppModule } from '../app.module';
import { ZoneAlerteComputedService } from "../zone_alerte_computed/zone_alerte_computed.service";
import { RegleauLogger } from '../logger/regleau.logger';

const logger = new RegleauLogger('ComputeMapWorker');

interface WorkerData {
  depsIds: number[];
  computeHistoric: boolean;
}

async function run() {
  try {
    const app = await NestFactory.createApplicationContext(AppModule);
    const zoneAlerteComputedService = app.get(ZoneAlerteComputedService);

    const { depsIds, computeHistoric } = workerData as WorkerData;

    logger.log(`Starting compute with depsIds: ${depsIds} and computeHistoric: ${computeHistoric}`);
    
    const result = await zoneAlerteComputedService.computeAll(depsIds, computeHistoric);
    
    if (parentPort) {
      parentPort.postMessage({ success: true, result });
    }
  } catch (error) {
    logger.error('Error in compute map worker', error);
    if (parentPort) {
      parentPort.postMessage({ success: false, error: error.message });
    }
  }
}

run();