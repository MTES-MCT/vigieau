import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { getScheduledCivilDate } from '../core/scheduling/daily-job-schedule';
import { DatagouvService } from '../datagouv/datagouv.service';
import { HistoricExportReadinessService } from '../datagouv/historic-export-readiness.service';
import {
  HistoricExportReadinessGate,
  publishWithHistoricExportReadiness,
} from './datagouv-historic-export-operator';

interface HistoricCommunesPublisher {
  updateHistoriqueCommunes: (
    expectedSourceDate: string,
    expectedSourceRevision: string,
    expectedStartDate: string,
  ) => Promise<void>;
}

export function resolveHistoricCommunesScheduledFor(now = new Date()): string {
  return getScheduledCivilDate(now, 6);
}

export async function publishHistoricCommunesResource(
  datagouvService: HistoricCommunesPublisher,
  readinessService: HistoricExportReadinessGate,
  scheduledFor: string,
): Promise<void> {
  await publishWithHistoricExportReadiness(
    readinessService,
    scheduledFor,
    (identity) =>
      datagouvService.updateHistoriqueCommunes(
        identity.statisticPublishedDate,
        identity.sourceRevision,
        identity.historicFirstDate,
      ),
  );
}

async function main(): Promise<void> {
  const scheduledFor = resolveHistoricCommunesScheduledFor();
  process.env.DISABLE_SCHEDULED_JOBS = 'true';
  process.env.SKIP_SCHEMA_BOOTSTRAP = 'true';
  process.env.SKIP_STARTUP_DEPARTEMENT_STATISTICS = 'true';
  const { AppModule } = await import('../app.module.js');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const datagouvService = app.get(DatagouvService);
    const readinessService = app.get(HistoricExportReadinessService);
    await publishHistoricCommunesResource(
      datagouvService,
      readinessService,
      scheduledFor,
    );
    process.stdout.write(
      `${JSON.stringify({ status: 'PUBLISHED', resource: 'historique_communes', scheduledFor })}\n`,
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
