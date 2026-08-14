import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import {
  getCivilDateAtUtcNoon,
  getScheduledCivilDate,
} from '../core/scheduling/daily-job-schedule';
import { DatagouvService } from '../datagouv/datagouv.service';

export interface AnnualCommunesPublicationOptions {
  year: number;
  expectedSourceDate: string;
}

interface AnnualCommunesPublisher {
  createOrUpdateCommunesResource: (
    year: number,
    expectedSourceDate: string,
  ) => Promise<string>;
}

export function parseYear(
  value: string | undefined,
  scheduledCivilDate: string,
): number {
  const year = value ? Number(value) : Number(scheduledCivilDate.slice(0, 4));
  if (!Number.isInteger(year) || year < 2013 || year > 9999) {
    throw new Error(`Invalid year: ${value}`);
  }
  return year;
}

export function resolveExpectedSourceDate(
  value: string | undefined,
  year: number,
  scheduledCivilDate: string,
): string {
  getCivilDateAtUtcNoon(scheduledCivilDate);
  const scheduledYear = Number(scheduledCivilDate.slice(0, 4));
  if (year > scheduledYear) {
    throw new Error(
      `Cannot publish communes for future year ${year}: scheduled source date is ${scheduledCivilDate}`,
    );
  }
  const authoritativeSourceDate =
    year < scheduledYear ? `${year}-12-31` : scheduledCivilDate;

  if (value !== undefined) {
    getCivilDateAtUtcNoon(value);
  }
  if (value !== undefined && value !== authoritativeSourceDate) {
    throw new Error(
      `EXPECTED_SOURCE_DATE ${value} must equal authoritative source date ${authoritativeSourceDate} for year ${year}`,
    );
  }
  return authoritativeSourceDate;
}

export function resolveAnnualCommunesPublicationOptions(
  yearValue: string | undefined,
  expectedSourceDateValue: string | undefined,
  now = new Date(),
): AnnualCommunesPublicationOptions {
  const scheduledCivilDate = getScheduledCivilDate(now, 6);
  const year = parseYear(yearValue, scheduledCivilDate);
  return {
    year,
    expectedSourceDate: resolveExpectedSourceDate(
      expectedSourceDateValue,
      year,
      scheduledCivilDate,
    ),
  };
}

export async function publishAnnualCommunesResource(
  datagouvService: AnnualCommunesPublisher,
  options: AnnualCommunesPublicationOptions,
): Promise<string> {
  return datagouvService.createOrUpdateCommunesResource(
    options.year,
    options.expectedSourceDate,
  );
}

async function main(): Promise<void> {
  const options = resolveAnnualCommunesPublicationOptions(
    process.argv[2],
    process.env.EXPECTED_SOURCE_DATE,
  );
  process.env.DISABLE_SCHEDULED_JOBS = 'true';
  process.env.SKIP_SCHEMA_BOOTSTRAP = 'true';
  process.env.SKIP_STARTUP_DEPARTEMENT_STATISTICS = 'true';
  const { AppModule } = await import('../app.module.js');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const datagouvService = app.get(DatagouvService);
    const resourceId = await publishAnnualCommunesResource(
      datagouvService,
      options,
    );
    process.stdout.write(
      `${JSON.stringify({ status: 'PUBLISHED', ...options, resourceId })}\n`,
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
