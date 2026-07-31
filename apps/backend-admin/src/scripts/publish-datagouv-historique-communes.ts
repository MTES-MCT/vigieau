import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { DatagouvService } from '../datagouv/datagouv.service';

async function main(): Promise<void> {
  process.env.DISABLE_SCHEDULED_JOBS = 'true';
  process.env.SKIP_SCHEMA_BOOTSTRAP = 'true';
  process.env.SKIP_STARTUP_DEPARTEMENT_STATISTICS = 'true';
  const { AppModule } = await import('../app.module.js');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const datagouvService = app.get(DatagouvService);
    await datagouvService.updateHistoriqueCommunes();
    process.stdout.write(
      `${JSON.stringify({ status: 'PUBLISHED', resource: 'historique_communes' })}\n`,
    );
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[publish-datagouv-historique-communes] failed');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
