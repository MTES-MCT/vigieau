import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { Config } from '@shared/entities/config.entity';
import { shouldSkipStartupDataLoads } from '../core/startup-data-loads';
import { sourceRevisionColumn } from '../zone_publication/zone_publication.config';
import { recordHistoricComputeInvalidation } from './historic-computation-invalidation';

export interface ConfigHistoricInvalidationOptions {
  cause?: string;
  affectedFrom?: string | null;
  affectedThrough?: string | null;
  invalidatesStatistics?: boolean;
  invalidatesMaps?: boolean;
  context?: Record<string, unknown>;
}

@Injectable()
export class ConfigService {
  constructor(
    @InjectRepository(Config)
    private readonly configRepository: Repository<Config>,
  ) {
    if (!shouldSkipStartupDataLoads()) {
      void this.initConfig();
    }
  }

  async initConfig() {
    const count = await this.configRepository.count();
    if (count > 0) {
      return;
    }
    await this.configRepository.save({});
  }

  getConfig() {
    return this.configRepository.findOne({ where: { id: 1 } });
  }

  async advanceComputeMapDate(
    expectedCurrent: string | null,
    expectedGeneration: string,
    completedThrough: string,
    expectedSourceRevision?: string,
  ): Promise<boolean> {
    const query = this.configRepository
      .createQueryBuilder()
      .update()
      .set({
        computeMapDate: completedThrough,
        computeMapGeneration: () => '"computeMapGeneration" + 1',
        computeMapUpdatedAt: () => 'now()',
      })
      .where('id = 1')
      .andWhere('"computeMapDate" IS NOT DISTINCT FROM :expectedCurrent', {
        expectedCurrent,
      })
      .andWhere('"computeMapGeneration" = :expectedGeneration', {
        expectedGeneration,
      });
    if (expectedSourceRevision !== undefined) {
      query.andWhere(
        `EXISTS (
          SELECT 1
          FROM "zone_publication_source_state" source_state
          WHERE source_state."id" = 1
            AND ${sourceRevisionColumn('source_state')} = :expectedSourceRevision
          FOR SHARE
        )`,
        { expectedSourceRevision },
      );
    }
    const result = await query.execute();
    return result.affected === 1;
  }

  async advanceComputeStatsDate(
    expectedCurrent: string | null,
    expectedGeneration: string,
    completedThrough: string,
    expectedSourceRevision?: string,
  ): Promise<boolean> {
    const query = this.configRepository
      .createQueryBuilder()
      .update()
      .set({
        computeStatsDate: completedThrough,
        computeStatsGeneration: () => '"computeStatsGeneration" + 1',
        computeStatsUpdatedAt: () => 'now()',
      })
      .where('id = 1')
      .andWhere('"computeStatsDate" IS NOT DISTINCT FROM :expectedCurrent', {
        expectedCurrent,
      })
      .andWhere('"computeStatsGeneration" = :expectedGeneration', {
        expectedGeneration,
      });
    if (expectedSourceRevision !== undefined) {
      query.andWhere(
        `EXISTS (
          SELECT 1
          FROM "zone_publication_source_state" source_state
          WHERE source_state."id" = 1
            AND ${sourceRevisionColumn('source_state')} = :expectedSourceRevision
          FOR SHARE
        )`,
        { expectedSourceRevision },
      );
    }
    const result = await query.execute();
    return result.affected === 1;
  }

  async setConfig(
    computeMapDate?: string,
    computeStatsDate?: string,
    computeZoneAlerteComputedDate?: Date,
    force?: boolean,
    historicInvalidation?: ConfigHistoricInvalidationOptions,
  ) {
    if (computeMapDate || computeStatsDate) {
      const requestedDates = [computeMapDate, computeStatsDate].filter(
        (date): date is string => Boolean(date),
      );
      await recordHistoricComputeInvalidation(this.configRepository, {
        affectedFrom:
          historicInvalidation?.affectedFrom ?? requestedDates.sort()[0],
        affectedThrough: historicInvalidation?.affectedThrough,
        invalidatesStatistics:
          historicInvalidation?.invalidatesStatistics ??
          Boolean(computeStatsDate),
        invalidatesMaps:
          historicInvalidation?.invalidatesMaps ?? Boolean(computeMapDate),
        cause: historicInvalidation?.cause ?? 'config-cursor-rewind',
        context: {
          force: Boolean(force),
          ...(historicInvalidation?.context ?? {}),
        },
        requestedMapDate: computeMapDate ?? null,
        requestedStatsDate: computeStatsDate ?? null,
        forceCursor: Boolean(force),
        bumpBackfillEpoch: true,
      });
    }

    if (computeZoneAlerteComputedDate) {
      const qb = this.configRepository
        .createQueryBuilder()
        .update()
        .set({ computeZoneAlerteComputedDate })
        .where('id = 1');
      if (!force) {
        qb.andWhere(
          new Brackets((qb) => {
            qb.where(
              'computeZoneAlerteComputedDate < :computeZoneAlerteComputedDate',
              { computeZoneAlerteComputedDate },
            ).orWhere('computeZoneAlerteComputedDate IS NULL');
          }),
        );
      }
      await qb.execute();
    }
  }

  async resetConfig() {
    return recordHistoricComputeInvalidation(this.configRepository, {
      affectedFrom: null,
      invalidatesStatistics: true,
      invalidatesMaps: true,
      cause: 'config-reset',
      resetCursors: true,
      bumpBackfillEpoch: true,
    });
  }
}
