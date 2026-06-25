import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import moment, { Moment } from 'moment';
import { AppModule } from '../app.module';
import { DepartementService } from '../departement/departement.service';
import { StatisticCommuneService } from '../statistic_commune/statistic_commune.service';
import { ZoneAlerteComputedHistoricService } from '../zone_alerte_computed/zone_alerte_computed_historic.service';

function parseDates(): string[] {
  const dates = new Set<string>();

  if (process.env.DATES) {
    process.env.DATES.split(',')
      .map((date) => date.trim())
      .filter(Boolean)
      .forEach((date) => dates.add(date));
  }

  if (process.env.DATE_FROM || process.env.DATE_TO) {
    if (!process.env.DATE_FROM || !process.env.DATE_TO) {
      throw new Error('DATE_FROM and DATE_TO must be set together');
    }

    const from = parseMoment(process.env.DATE_FROM);
    const to = parseMoment(process.env.DATE_TO);
    if (from.isAfter(to, 'day')) {
      throw new Error(
        `Invalid date range: ${process.env.DATE_FROM}..${process.env.DATE_TO}`,
      );
    }

    for (
      let date = moment(from);
      date.isSameOrBefore(to, 'day');
      date.add(1, 'day')
    ) {
      dates.add(date.format('YYYY-MM-DD'));
    }
  }

  const sortedDates = [...dates].sort();
  sortedDates.forEach(parseMoment);
  if (sortedDates.length === 0) {
    throw new Error(
      'Set DATES=YYYY-MM-DD[,YYYY-MM-DD] or DATE_FROM/DATE_TO',
    );
  }

  return sortedDates;
}

function parseMoment(date: string): Moment {
  const parsedDate = moment(date, 'YYYY-MM-DD', true);
  if (!parsedDate.isValid()) {
    throw new Error(`Invalid date: ${date}`);
  }
  return parsedDate;
}

function parseDepartementCodes(): string[] {
  return (process.env.DEP_CODES || process.env.DEP_CODE || '')
    .split(',')
    .map((code) => code.trim())
    .filter(Boolean);
}

async function main() {
  const dates = parseDates();
  const departementCodes = parseDepartementCodes();
  const recomputeMonths = process.env.RECOMPUTE_MONTHS !== 'false';
  const sortAtEnd = process.env.SORT_AT_END !== 'false';

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const departementService = app.get(DepartementService);
    const historicService = app.get(ZoneAlerteComputedHistoricService);
    const statisticCommuneService = app.get(StatisticCommuneService);

    let departements = await departementService.findAllLight();
    if (departementCodes.length > 0) {
      departements = departements.filter((departement) =>
        departementCodes.includes(departement.code),
      );
    }

    const foundCodes = departements.map((departement) => departement.code);
    const missingCodes = departementCodes.filter(
      (code) => !foundCodes.includes(code),
    );
    if (missingCodes.length > 0) {
      throw new Error(`Unknown departement codes: ${missingCodes.join(',')}`);
    }

    console.log(
      `[recompute-commune-statistics] dates=${dates.length} departements=${foundCodes.join(',')}`,
    );

    for (const date of dates) {
      const dateMoment = parseMoment(date);
      console.log(`[recompute-commune-statistics] ${date} zones begin`);
      await historicService.computeZonesForDate(dateMoment, departements);
      const zones = await historicService.findZonesForStatistics(foundCodes);
      console.log(
        `[recompute-commune-statistics] ${date} zones=${zones.length}`,
      );

      await statisticCommuneService.computeCommuneStatisticsRestrictions(
        zones,
        dateMoment.toDate(),
        true,
        false,
        foundCodes,
      );

      if (recomputeMonths) {
        await statisticCommuneService.computeCommuneStatisticsRestrictionsByMonth(
          dateMoment.toDate(),
          foundCodes,
        );
      }

      console.log(`[recompute-commune-statistics] ${date} done`);
    }

    if (sortAtEnd) {
      await statisticCommuneService.sortStatCommune(foundCodes);
      console.log('[recompute-commune-statistics] sorted');
    }
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('[recompute-commune-statistics] failed');
  console.error(error);
  process.exit(1);
});
