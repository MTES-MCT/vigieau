import './instrument';

import { NestFactory } from '@nestjs/core';
import { StatcacheModule } from './statcache/statcache.module';
import { VigieauLogger } from './logger/vigieau.logger';

async function bootstrap() {
  process.env.VIGIEAU_PROCESS_ROLE = 'statcache';
  const app = await NestFactory.createApplicationContext(StatcacheModule);
  app.useLogger(app.get(VigieauLogger));
  app.enableShutdownHooks();
}

void bootstrap().catch((error) => {
  const normalized = error instanceof Error ? error : new Error(String(error));
  console.error('STATISTIC CACHE WORKER BOOTSTRAP FAILED', normalized);
  process.exit(1);
});
