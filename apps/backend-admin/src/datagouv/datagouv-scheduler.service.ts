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
import {
  buildHistoricRunIdentityFromConfig,
  type HistoricRunIdentity,
} from '../core/scheduling/historic-run-identity';
import { ConfigService } from '../config/config.service';
import { DatagouvService } from './datagouv.service';
import {
  ExternalPublicationRegistryService,
  type PublicationRunIdentity,
} from './external-publication-registry.service';
import { ZonePublicationService } from '../zone_publication/zone_publication.service';
import {
  isZonePublicationEnabled,
  ZONE_PUBLICATION_MATERIALIZATION_VERSION,
} from '../zone_publication/zone_publication.config';

const DATAGOUV_JOB_KEY = 'datagouv:daily';
const LEGACY_DATAGOUV_RUN_IDENTITY = {
  publicationMode: 'legacy',
} satisfies PublicationRunIdentity;

type DatagouvHistoricRunIdentity = HistoricRunIdentity & {
  sourceRevision: string;
  materializationVersion: number;
};

@Injectable()
export class DatagouvSchedulerService implements OnApplicationBootstrap {
  private readonly logger = new RegleauLogger('DatagouvSchedulerService');
  private catchUpScheduled = false;

  constructor(
    private readonly datagouvService: DatagouvService,
    private readonly registry: ExternalPublicationRegistryService,
    private readonly zonePublicationService: ZonePublicationService,
    private readonly configService: ConfigService,
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
    const historicIdentity = await this.getHistoricRunIdentity(
      publicationGate.sourceRevision,
    );
    const identity = {
      publicationId: publicationGate.publicationId,
      ...historicIdentity,
    };
    const [currentComputed, historicCaughtUp] = await Promise.all([
      this.registry.hasSucceeded(NATIONAL_DAILY_COMPUTE_JOB_KEY, scheduledFor, {
        sourceRevision: identity.sourceRevision,
        materializationVersion: identity.materializationVersion,
      }),
      this.registry.hasSucceeded(
        NATIONAL_HISTORIC_CATCHUP_JOB_KEY,
        scheduledFor,
        historicIdentity,
      ),
    ]);
    if (!currentComputed || !historicCaughtUp) {
      return;
    }
    const verifyCurrent = () =>
      this.assertPublicationGate(
        scheduledFor,
        publicationGate,
        historicIdentity,
      );
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

  private async publishLegacyIfDue(
    scheduledFor: string,
    now: Date,
  ): Promise<void> {
    const currentComputed = await this.registry.hasSucceeded(
      NATIONAL_DAILY_COMPUTE_JOB_KEY,
      scheduledFor,
    );
    if (!currentComputed) {
      return;
    }

    await this.registry.executeDailyRun(
      DATAGOUV_JOB_KEY,
      scheduledFor,
      async () => {
        await this.datagouvService.updateDatagouvData(
          scheduledFor,
          LEGACY_DATAGOUV_RUN_IDENTITY,
        );
        return LEGACY_DATAGOUV_RUN_IDENTITY;
      },
      now,
      { identity: LEGACY_DATAGOUV_RUN_IDENTITY },
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
    expectedHistoricIdentity: DatagouvHistoricRunIdentity,
  ): Promise<void> {
    const [current, currentHistoricIdentity] = await Promise.all([
      this.zonePublicationService.getActivePublicationGate(scheduledFor),
      this.getHistoricRunIdentity(expectedHistoricIdentity.sourceRevision),
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
    if (
      currentHistoricIdentity.materializationVersion !==
        expectedHistoricIdentity.materializationVersion ||
      currentHistoricIdentity.historicMapCursor !==
        expectedHistoricIdentity.historicMapCursor ||
      currentHistoricIdentity.historicStatsCursor !==
        expectedHistoricIdentity.historicStatsCursor ||
      currentHistoricIdentity.historicMapGeneration !==
        expectedHistoricIdentity.historicMapGeneration ||
      currentHistoricIdentity.historicStatsGeneration !==
        expectedHistoricIdentity.historicStatsGeneration
    ) {
      throw new Error(
        `Historic computation gate changed during Datagouv run for ${scheduledFor}`,
      );
    }
  }

  private async getHistoricRunIdentity(
    sourceRevision: string,
  ): Promise<DatagouvHistoricRunIdentity> {
    const config = await this.configService.getConfig();
    if (!config) {
      throw new Error('Historic cursor configuration is missing');
    }
    return {
      ...buildHistoricRunIdentityFromConfig(config),
      sourceRevision,
      materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
    };
  }
}
