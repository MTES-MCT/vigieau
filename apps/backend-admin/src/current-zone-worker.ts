import './instrument';

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { RegleauLogger } from './logger/regleau.logger';

async function bootstrapCurrentZoneWorker(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  app.useLogger(app.get(RegleauLogger));
  app.enableShutdownHooks();
}

void bootstrapCurrentZoneWorker().catch((error) => {
  console.error('CURRENT ZONE WORKER BOOTSTRAP ERROR', error);
  process.exit(1);
});
