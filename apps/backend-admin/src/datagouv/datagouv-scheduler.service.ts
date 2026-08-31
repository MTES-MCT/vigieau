import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import {
  areScheduledJobsDisabled,
  BusinessCron,
  isBusinessSchedulerProcess,
} from '../core/scheduling/business-cron';
import { RegleauLogger } from '../logger/regleau.logger';
import {
  DATAGOUV_DAILY_JOB_KEY,
  getScheduledCivilDate,
  NATIONAL_DAILY_COMPUTE_JOB_KEY,
} from '../core/scheduling/daily-job-schedule';
import { DatagouvService } from './datagouv.service';
import {
  ExternalPublicationRegistryService,
  type PublicationRunIdentity,
} from './external-publication-registry.service';
import { ZonePublicationService } from '../zone_publication/zone_publication.service';
import { isZonePublicationEnabled } from '../zone_publication/zone_publication.config';
import { isStatisticCacheArtifactRequired } from '../statistic_cache/statistic_cache.config';
import { StatisticCacheReadinessService } from '../statistic_cache/statistic_cache_readiness.service';
import {
  HistoricExportReadinessIdentity,
  HistoricExportReadinessService,
} from './historic-export-readiness.service';

@Injectable()
export class DatagouvSchedulerService implements OnApplicationBootstrap {
  private readonly logger = new RegleauLogger('DatagouvSchedulerService');
  private catchUpScheduled = false;

  constructor(
    private readonly datagouvService: DatagouvService,
    private readonly registry: ExternalPublicationRegistryService,
    private readonly zonePublicationService: ZonePublicationService,
    private readonly statisticCacheReadiness: StatisticCacheReadinessService,
    private readonly historicExportReadiness: HistoricExportReadinessService,
  ) {}

  onApplicationBootstrap(): void {
    if (
      !isBusinessSchedulerProcess() ||
      areScheduledJobsDisabled() ||
      this.catchUpScheduled
    ) {
      return;
    }
    this.catchUpScheduled = true;
    setTimeout(() => {
      void this.publishIfDue().catch((error) => {
        this.logger.error('DATAGOUV CATCH-UP ERROR', error);
      });
    }, 0).unref();
  }

  @BusinessCron(CronExpression.EVERY_5_MINUTES)
  async publishIfDue(now = new Date()): Promise<void> {
    const scheduledFor = getScheduledCivilDate(now, 6);
    if (!isZonePublicationEnabled()) {
      await this.publishLegacyIfDue(scheduledFor, now);
      return;
    }

    const publicationGate =
      await this.zonePublicationService.getActivePublicationGate(scheduledFor);
    if (!publicationGate) {
      return;
    }
    const readiness = await this.historicExportReadiness.evaluate(
      scheduledFor,
      publicationGate,
    );
    if (readiness.status !== 'ready') {
      return;
    }
    const identity = readiness.identity;
    const verifyCurrent = () =>
      this.assertPublicationGate(scheduledFor, publicationGate, identity);
    await this.registry.executeDailyRun(
      DATAGOUV_DAILY_JOB_KEY,
      scheduledFor,
      async () => {
        await verifyCurrent();
        await this.datagouvService.updateDatagouvData(scheduledFor, {
          ...identity,
          verifyCurrent,
        });
        await verifyCurrent();
        return {
          ...identity,
          geojsonChecksum: publicationGate.geojsonChecksum,
          pmtilesChecksum: publicationGate.pmtilesChecksum,
        };
      },
      now,
      { identity },
    );
  }

  private async publishLegacyIfDue(
    scheduledFor: string,
    now: Date,
  ): Promise<void> {
    const sourceRevision =
      await this.zonePublicationService.getSourceRevision();
    const dailyIdentity = {
      publicationMode: 'legacy' as const,
      sourceRevision,
    } satisfies PublicationRunIdentity;
    const currentComputed = await this.registry.hasSucceeded(
      NATIONAL_DAILY_COMPUTE_JOB_KEY,
      scheduledFor,
      dailyIdentity,
    );
    if (!currentComputed) {
      return;
    }
    const artifactRequired = isStatisticCacheArtifactRequired();
    const artifactIdentity = artifactRequired
      ? await this.statisticCacheReadiness.getReadyPublication(
          scheduledFor,
          sourceRevision,
        )
      : null;
    if (artifactRequired && !artifactIdentity) {
      return;
    }
    const identity = {
      ...dailyIdentity,
      ...(artifactIdentity
        ? {
            statisticCachePublicationId: artifactIdentity.publicationId,
            statisticRevision: artifactIdentity.statisticRevision,
            statisticPublishedDate: artifactIdentity.statisticPublishedDate,
            statisticFingerprint: artifactIdentity.statisticFingerprint,
          }
        : {}),
    } satisfies PublicationRunIdentity;
    const verifyCurrent = async () => {
      const [currentSourceRevision, stillComputed] = await Promise.all([
        this.zonePublicationService.getSourceRevision(),
        this.registry.hasSucceeded(
          NATIONAL_DAILY_COMPUTE_JOB_KEY,
          scheduledFor,
          dailyIdentity,
        ),
        ...(artifactIdentity
          ? [
              this.statisticCacheReadiness.assertReadyPublication(
                artifactIdentity,
              ),
            ]
          : []),
      ]);
      if (currentSourceRevision !== sourceRevision || !stillComputed) {
        throw new Error(
          `Legacy computation gate changed during Datagouv run for ${scheduledFor}`,
        );
      }
    };

    await this.registry.executeDailyRun(
      DATAGOUV_DAILY_JOB_KEY,
      scheduledFor,
      async () => {
        await verifyCurrent();
        await this.datagouvService.updateDatagouvData(scheduledFor, {
          ...identity,
          verifyCurrent,
        });
        await verifyCurrent();
        return identity;
      },
      now,
      { identity },
    );
  }

  private async assertPublicationGate(
    scheduledFor: string,
    expected: {
      publicationId: string;
      sourceRevision: string;
      geojsonChecksum: string;
      pmtilesChecksum: string;
    },
    expectedHistoricIdentity: HistoricExportReadinessIdentity,
  ): Promise<void> {
    const [current] = await Promise.all([
      this.zonePublicationService.getActivePublicationGate(scheduledFor),
      this.historicExportReadiness.assertReady(expectedHistoricIdentity),
    ]);
    if (
      !current ||
      current.publicationId !== expected.publicationId ||
      current.sourceRevision !== expected.sourceRevision ||
      current.geojsonChecksum !== expected.geojsonChecksum ||
      current.pmtilesChecksum !== expected.pmtilesChecksum
    ) {
      throw new Error(
        `Zone publication gate changed during Datagouv run for ${scheduledFor}`,
      );
    }
  }
}
