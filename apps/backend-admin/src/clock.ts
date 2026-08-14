import './instrument';

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { RegleauLogger } from './logger/regleau.logger';

async function bootstrapClock(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  app.useLogger(app.get(RegleauLogger));
  app.enableShutdownHooks();
}

void bootstrapClock().catch((error) => {
  console.error('CLOCK BOOTSTRAP ERROR', error);
  process.exit(1);
});
