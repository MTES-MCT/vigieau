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

interface DailyComputationContext {
  scheduledFor: string;
  publicationMode: 'legacy' | 'versioned';
  sourceRevision: string;
  publicationId?: string;
  materializationVersion?: number;
}

@Injectable()
export class ArreteCadreScheduler implements OnApplicationBootstrap {
  private readonly logger = new RegleauLogger('ArreteCadreScheduler');
  private catchUpScheduled = false;
  private currentUpdateInFlight: {
    scheduledFor: string;
    run: Promise<DailyComputationContext | null>;
  } | null = null;
  private historicUpdateInFlight: {
    scheduledFor: string;
    run: Promise<void>;
  } | null = null;

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

  @BusinessCron(CronExpression.EVERY_5_MINUTES, { waitForCompletion: false })
  async updateIfDue(now = new Date()): Promise<void> {
    const scheduledFor = getScheduledCivilDate(
      now,
      NATIONAL_COMPUTE_START_HOUR,
    );
    const current = await this.updateCurrentIfDue(scheduledFor, now);
    if (!current) {
      return;
    }
    await this.updateHistoricIfDue(current, now);
  }

  private async updateCurrentIfDue(
    scheduledFor: string,
    now: Date,
  ): Promise<DailyComputationContext | null> {
    if (this.currentUpdateInFlight) {
      if (this.currentUpdateInFlight.scheduledFor !== scheduledFor) {
        this.logger.log(
          `CURRENT COMPUTE ${scheduledFor} deferred while ${this.currentUpdateInFlight.scheduledFor} is in progress`,
        );
      }
      return null;
    }
    const run = isZonePublicationEnabled()
      ? this.runVersionedCurrentIfDue(scheduledFor, now)
      : this.runLegacyCurrentIfDue(scheduledFor, now);
    this.currentUpdateInFlight = { scheduledFor, run };
    try {
      return await run;
    } finally {
      if (this.currentUpdateInFlight?.run === run) {
        this.currentUpdateInFlight = null;
      }
    }
  }

  private async runVersionedCurrentIfDue(
    scheduledFor: string,
    now: Date,
  ): Promise<DailyComputationContext | null> {
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
        await this.arreteCadreService.assertVersionedDailyComputationReady(
          scheduledFor,
          computedSourceRevision,
        );
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
      return null;
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
    await this.arreteCadreService.assertVersionedDailyComputationReady(
      scheduledFor,
      computedSourceRevision,
    );
    return {
      scheduledFor,
      publicationMode: 'versioned',
      publicationId,
      sourceRevision: computedSourceRevision,
      materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
    };
  }

  private async runLegacyCurrentIfDue(
    scheduledFor: string,
    now: Date,
  ): Promise<DailyComputationContext | null> {
    const expectedSourceRevision =
      await this.zonePublicationService.getSourceRevision();
    let completedSourceRevision: string | undefined;
    const currentResult = await this.registry.executeDailyRun(
      NATIONAL_DAILY_COMPUTE_JOB_KEY,
      scheduledFor,
      async () => {
        const queueResult =
          await this.arreteCadreService.updateArreteCadreStatut(
            false,
            undefined,
            scheduledFor,
          );
        if (!['empty', 'processed'].includes(String(queueResult))) {
          throw new Error(
            `Current zone recompute queue is ${String(queueResult ?? 'unknown')} for ${scheduledFor}`,
          );
        }
        const completed =
          await this.arreteCadreService.assertLegacyDailyComputationCompleted(
            scheduledFor,
          );
        completedSourceRevision = completed.sourceRevision;
        await this.assertSourceRevision(completed.sourceRevision);
        return {
          publicationMode: 'legacy' as const,
          sourceRevision: completed.sourceRevision,
        };
      },
      now,
      {
        identity: {
          publicationMode: 'legacy',
          sourceRevision: expectedSourceRevision,
        },
      },
    );
    if (!['succeeded', 'already_succeeded'].includes(currentResult)) {
      return null;
    }
    if (completedSourceRevision === undefined) {
      const completed =
        await this.arreteCadreService.assertLegacyDailyComputationCompleted(
          scheduledFor,
        );
      completedSourceRevision = completed.sourceRevision;
    }
    await this.assertSourceRevision(completedSourceRevision);
    return {
      scheduledFor,
      publicationMode: 'legacy',
      sourceRevision: completedSourceRevision,
    };
  }

  private async updateHistoricIfDue(
    current: DailyComputationContext,
    now: Date,
  ): Promise<void> {
    if (this.historicUpdateInFlight) {
      if (this.historicUpdateInFlight.scheduledFor !== current.scheduledFor) {
        this.logger.log(
          `HISTORIC COMPUTE ${current.scheduledFor} deferred while ${this.historicUpdateInFlight.scheduledFor} is in progress`,
        );
      }
      return;
    }
    const run = this.runHistoricIfDue(current, now);
    this.historicUpdateInFlight = {
      scheduledFor: current.scheduledFor,
      run,
    };
    try {
      await run;
    } finally {
      if (this.historicUpdateInFlight?.run === run) {
        this.historicUpdateInFlight = null;
      }
    }
  }

  private async runHistoricIfDue(
    current: DailyComputationContext,
    now: Date,
  ): Promise<void> {
    const materializationVersion = current.materializationVersion;
    const historicIdentity = await this.getHistoricRunIdentity(
      current.sourceRevision,
      materializationVersion,
    );
    const publicationIdentity =
      current.publicationMode === 'versioned'
        ? historicIdentity
        : { publicationMode: 'legacy' as const, ...historicIdentity };

    const historicResult = await this.registry.executeDailyRun(
      NATIONAL_HISTORIC_CATCHUP_JOB_KEY,
      current.scheduledFor,
      async () => {
        const completedState =
          await this.arreteCadreService.catchUpHistoricComputations(
            shiftCivilDate(current.scheduledFor, -1),
            current.sourceRevision,
          );
        await this.assertSourceRevision(current.sourceRevision);
        const completedIdentity = buildHistoricRunIdentity(completedState, {
          sourceRevision: current.sourceRevision,
          ...(materializationVersion === undefined
            ? {}
            : { materializationVersion }),
        });
        return {
          ...(current.publicationMode === 'legacy'
            ? { publicationMode: 'legacy' as const }
            : {}),
          ...completedIdentity,
        };
      },
      now,
      { identity: publicationIdentity },
    );
    if (
      current.publicationMode === 'versioned' &&
      ['succeeded', 'already_succeeded'].includes(historicResult)
    ) {
      await this.assertSourceRevision(current.sourceRevision);
      const marked =
        await this.zonePublicationService.promoteCertifiedPublicationIfAvailable(
          {
            scheduledFor: current.scheduledFor,
            sourceRevision: current.sourceRevision,
            preferredPublicationId: current.publicationId,
          },
        );
      if (!marked) {
        throw new Error(
          `Zone publication ${current.publicationId} was superseded before candidacy`,
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
