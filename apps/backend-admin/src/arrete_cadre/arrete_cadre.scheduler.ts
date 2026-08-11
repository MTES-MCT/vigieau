import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import {
  areScheduledJobsDisabled,
  BusinessCron,
  isBusinessSchedulerProcess,
} from '../core/scheduling/business-cron';
import {
  getScheduledCivilDate,
  NATIONAL_COMPUTE_START_HOUR,
  NATIONAL_DAILY_COMPUTE_JOB_KEY,
  NATIONAL_HISTORIC_CATCHUP_JOB_KEY,
  shiftCivilDate,
} from '../core/scheduling/daily-job-schedule';
import {
  buildHistoricRunIdentity,
  buildHistoricRunIdentityFromConfig,
} from '../core/scheduling/historic-run-identity';
import { ConfigService } from '../config/config.service';
import {
  ExternalPublicationRegistryService,
  PublicationRunIdentity,
} from '../datagouv/external-publication-registry.service';
import { RegleauLogger } from '../logger/regleau.logger';
import {
  isZonePublicationEnabled,
  ZONE_PUBLICATION_MATERIALIZATION_VERSION,
} from '../zone_publication/zone_publication.config';
import { ZonePublicationService } from '../zone_publication/zone_publication.service';
import { ArreteCadreService } from './arrete_cadre.service';

@Injectable()
export class ArreteCadreScheduler implements OnApplicationBootstrap {
  private readonly logger = new RegleauLogger('ArreteCadreScheduler');
  private catchUpScheduled = false;
  private updateInFlight: Promise<void> | null = null;

  constructor(
    private readonly arreteCadreService: ArreteCadreService,
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
      void this.updateIfDue().catch((error) => {
        this.logger.error('NATIONAL COMPUTE CATCH-UP ERROR', error);
      });
    }, 0).unref();
  }

  @BusinessCron(CronExpression.EVERY_5_MINUTES)
  async updateIfDue(now = new Date()): Promise<void> {
    if (this.updateInFlight) {
      return this.updateInFlight;
    }
    const update = this.runUpdateIfDue(now);
    this.updateInFlight = update;
    try {
      await update;
    } finally {
      if (this.updateInFlight === update) {
        this.updateInFlight = null;
      }
    }
  }

  private async runUpdateIfDue(now: Date): Promise<void> {
    const scheduledFor = getScheduledCivilDate(
      now,
      NATIONAL_COMPUTE_START_HOUR,
    );
    if (!isZonePublicationEnabled()) {
      await this.updateLegacyIfDue(scheduledFor, now);
      return;
    }

    const expectedSourceRevision =
      await this.zonePublicationService.getSourceRevision();
    const currentResult = await this.registry.executeDailyRun(
      NATIONAL_DAILY_COMPUTE_JOB_KEY,
      scheduledFor,
      async () => {
        const result = (await this.arreteCadreService.updateArreteCadreStatut(
          false,
          {
            scheduledFor,
            sourceRevision: expectedSourceRevision,
          },
        )) as {
          result?: { publicationId?: unknown; sourceRevision?: unknown };
        };
        const publicationId = result?.result?.publicationId;
        const sourceRevision = result?.result?.sourceRevision;
        if (
          typeof publicationId !== 'string' ||
          (typeof sourceRevision !== 'string' &&
            typeof sourceRevision !== 'number')
        ) {
          throw new Error(
            'National computation did not produce a versioned publication',
          );
        }
        const computedSourceRevision = String(sourceRevision);
        await this.assertSourceRevision(computedSourceRevision);
        return {
          publicationId,
          sourceRevision: computedSourceRevision,
          materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
        };
      },
      now,
      {
        identity: {
          sourceRevision: expectedSourceRevision,
          materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
        },
      },
    );
    if (!['succeeded', 'already_succeeded'].includes(currentResult)) {
      return;
    }

    const currentMetadata = await this.registry.getSucceededRunMetadata(
      NATIONAL_DAILY_COMPUTE_JOB_KEY,
      scheduledFor,
    );
    const publicationId = currentMetadata?.publicationId;
    const sourceRevision = currentMetadata?.sourceRevision;
    const materializationVersion = currentMetadata?.materializationVersion;
    if (
      typeof publicationId !== 'string' ||
      (typeof sourceRevision !== 'string' &&
        typeof sourceRevision !== 'number') ||
      materializationVersion !== ZONE_PUBLICATION_MATERIALIZATION_VERSION
    ) {
      throw new Error(
        'National computation metadata is missing its publication identity',
      );
    }
    const computedSourceRevision = String(sourceRevision);
    await this.assertSourceRevision(computedSourceRevision);
    const historicIdentity = await this.getHistoricRunIdentity(
      computedSourceRevision,
      ZONE_PUBLICATION_MATERIALIZATION_VERSION,
    );

    const historicResult = await this.registry.executeDailyRun(
      NATIONAL_HISTORIC_CATCHUP_JOB_KEY,
      scheduledFor,
      async () => {
        const completedState =
          await this.arreteCadreService.catchUpHistoricComputations(
            shiftCivilDate(scheduledFor, -1),
            computedSourceRevision,
          );
        await this.assertSourceRevision(computedSourceRevision);
        return buildHistoricRunIdentity(completedState, {
          sourceRevision: computedSourceRevision,
          materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
        });
      },
      now,
      { identity: historicIdentity },
    );
    if (['succeeded', 'already_succeeded'].includes(historicResult)) {
      await this.assertSourceRevision(computedSourceRevision);
      const marked =
        await this.zonePublicationService.promoteCertifiedPublicationIfAvailable(
          {
            scheduledFor,
            sourceRevision: computedSourceRevision,
            preferredPublicationId: publicationId,
          },
        );
      if (!marked) {
        throw new Error(
          `Zone publication ${publicationId} was superseded before candidacy`,
        );
      }
    }
  }

  private async assertSourceRevision(expected: string): Promise<void> {
    const current = await this.zonePublicationService.getSourceRevision();
    if (current !== expected) {
      throw new Error(
        `Zone source revision changed during computation (${expected} -> ${current})`,
      );
    }
  }

  private async updateLegacyIfDue(
    scheduledFor: string,
    now: Date,
  ): Promise<void> {
    const currentResult = await this.registry.executeDailyRun(
      NATIONAL_DAILY_COMPUTE_JOB_KEY,
      scheduledFor,
      () => this.arreteCadreService.updateArreteCadreStatut(false),
      now,
    );
    if (!['succeeded', 'already_succeeded'].includes(currentResult)) {
      return;
    }
    const historicIdentity = await this.getHistoricRunIdentity();
    await this.registry.executeDailyRun(
      NATIONAL_HISTORIC_CATCHUP_JOB_KEY,
      scheduledFor,
      async () => {
        const completedState =
          await this.arreteCadreService.catchUpHistoricComputations(
            shiftCivilDate(scheduledFor, -1),
          );
        return buildHistoricRunIdentity(completedState);
      },
      now,
      { identity: historicIdentity },
    );
  }

  private async getHistoricRunIdentity(
    sourceRevision?: string,
    materializationVersion?: number,
  ): Promise<PublicationRunIdentity> {
    const config = await this.configService.getConfig();
    if (!config) {
      throw new Error('Historic cursor configuration is missing');
    }
    return buildHistoricRunIdentityFromConfig(config, {
      ...(sourceRevision === undefined ? {} : { sourceRevision }),
      ...(materializationVersion === undefined
        ? {}
        : { materializationVersion }),
    });
  }
}
