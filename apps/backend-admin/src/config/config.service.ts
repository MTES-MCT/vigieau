import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { Config } from '@shared/entities/config.entity';
import { shouldSkipStartupDataLoads } from '../core/startup-data-loads';

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
  ): Promise<boolean> {
    const result = await this.configRepository
      .createQueryBuilder()
      .update()
      .set({
        computeMapDate: completedThrough,
        computeMapGeneration: () => '"computeMapGeneration" + 1',
      })
      .where('id = 1')
      .andWhere('"computeMapDate" IS NOT DISTINCT FROM :expectedCurrent', {
        expectedCurrent,
      })
      .andWhere('"computeMapGeneration" = :expectedGeneration', {
        expectedGeneration,
      })
      .execute();
    return result.affected === 1;
  }

  async advanceComputeStatsDate(
    expectedCurrent: string | null,
    expectedGeneration: string,
    completedThrough: string,
  ): Promise<boolean> {
    const result = await this.configRepository
      .createQueryBuilder()
      .update()
      .set({
        computeStatsDate: completedThrough,
        computeStatsGeneration: () => '"computeStatsGeneration" + 1',
      })
      .where('id = 1')
      .andWhere('"computeStatsDate" IS NOT DISTINCT FROM :expectedCurrent', {
        expectedCurrent,
      })
      .andWhere('"computeStatsGeneration" = :expectedGeneration', {
        expectedGeneration,
      })
      .execute();
    return result.affected === 1;
  }

  async setConfig(
    computeMapDate?: string,
    computeStatsDate?: string,
    computeZoneAlerteComputedDate?: Date,
    force?: boolean,
  ) {
    if (computeMapDate) {
      // The generation records invalidations even when the dirty date is equal.
      const qb = this.configRepository
        .createQueryBuilder()
        .update()
        .set({
          computeMapDate: force
            ? computeMapDate
            : () =>
                'LEAST(COALESCE("computeMapDate", CAST(:computeMapDate AS date)), CAST(:computeMapDate AS date))',
          computeMapGeneration: () => '"computeMapGeneration" + 1',
        })
        .where('id = 1');
      if (!force) {
        qb.setParameter('computeMapDate', computeMapDate);
      }
      await qb.execute();
    }

    if (computeStatsDate) {
      const qb = this.configRepository
        .createQueryBuilder()
        .update()
        .set({
          computeStatsDate: force
            ? computeStatsDate
            : () =>
                'LEAST(COALESCE("computeStatsDate", CAST(:computeStatsDate AS date)), CAST(:computeStatsDate AS date))',
          computeStatsGeneration: () => '"computeStatsGeneration" + 1',
        })
        .where('id = 1');
      if (!force) {
        qb.setParameter('computeStatsDate', computeStatsDate);
      }
      await qb.execute();
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
    return this.configRepository
      .createQueryBuilder()
      .update()
      .set({
        computeMapDate: null,
        computeStatsDate: null,
        computeMapGeneration: () => '"computeMapGeneration" + 1',
        computeStatsGeneration: () => '"computeStatsGeneration" + 1',
      })
      .where('id = 1')
      .execute();
  }
}
