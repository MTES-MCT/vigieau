import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { DatagouvService } from '../datagouv/datagouv.service';

function parseYear(value: string | undefined): number {
  const year = value ? Number(value) : new Date().getFullYear();
  if (!Number.isInteger(year) || year < 2013 || year > 9999) {
    throw new Error(`Invalid year: ${value}`);
  }
  return year;
}

async function main(): Promise<void> {
  const year = parseYear(process.argv[2]);
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const datagouvService = app.get(DatagouvService);
    const resourceId =
      await datagouvService.createOrUpdateCommunesResource(year);
    process.stdout.write(
      `${JSON.stringify({ status: 'PUBLISHED', year, resourceId })}\n`,
    );
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[publish-datagouv-communes] failed');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
