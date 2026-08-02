import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import {
  areScheduledJobsDisabled,
  BusinessCron,
  isBusinessSchedulerProcess,
} from '../core/scheduling/business-cron';
import { RegleauLogger } from '../logger/regleau.logger';
import {
  getScheduledCivilDate,
  NATIONAL_DAILY_COMPUTE_JOB_KEY,
  NATIONAL_HISTORIC_CATCHUP_JOB_KEY,
} from '../core/scheduling/daily-job-schedule';
import { DatagouvService } from './datagouv.service';
import { ExternalPublicationRegistryService } from './external-publication-registry.service';
import { ZonePublicationService } from '../zone_publication/zone_publication.service';

const DATAGOUV_JOB_KEY = 'datagouv:daily';

@Injectable()
export class DatagouvSchedulerService implements OnApplicationBootstrap {
  private readonly logger = new RegleauLogger('DatagouvSchedulerService');
  private catchUpScheduled = false;

  constructor(
    private readonly datagouvService: DatagouvService,
    private readonly registry: ExternalPublicationRegistryService,
    private readonly zonePublicationService: ZonePublicationService,
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
    const publicationGate =
      await this.zonePublicationService.getActivePublicationGate(scheduledFor);
    if (!publicationGate) {
      return;
    }
    const identity = {
      publicationId: publicationGate.publicationId,
      sourceRevision: publicationGate.sourceRevision,
    };
    const [currentComputed, historicCaughtUp] = await Promise.all([
      this.registry.hasSucceeded(NATIONAL_DAILY_COMPUTE_JOB_KEY, scheduledFor, {
        sourceRevision: identity.sourceRevision,
      }),
      this.registry.hasSucceeded(
        NATIONAL_HISTORIC_CATCHUP_JOB_KEY,
        scheduledFor,
        { sourceRevision: identity.sourceRevision },
      ),
    ]);
    if (!currentComputed || !historicCaughtUp) {
      return;
    }
    const verifyCurrent = () =>
      this.assertPublicationGate(scheduledFor, publicationGate);
    await this.registry.executeDailyRun(
      DATAGOUV_JOB_KEY,
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

  private async assertPublicationGate(
    scheduledFor: string,
    expected: {
      publicationId: string;
      sourceRevision: string;
      geojsonChecksum: string;
      pmtilesChecksum: string;
    },
  ): Promise<void> {
    const current =
      await this.zonePublicationService.getActivePublicationGate(scheduledFor);
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
