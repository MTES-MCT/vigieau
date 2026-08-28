import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import {
  areScheduledJobsDisabled,
  BusinessCron,
  isCurrentZoneRecomputeWorkerEnabled,
  isBusinessSchedulerProcess,
} from '../core/scheduling/business-cron';
import {
  DATAGOUV_DAILY_JOB_KEY,
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
import { isStatisticCacheArtifactRequired } from '../statistic_cache/statistic_cache.config';
import {
  StatisticCacheReadinessService,
  type StatisticCacheReadyIdentity,
} from '../statistic_cache/statistic_cache_readiness.service';
import { isHistoricMutableGeometryReplayEnabled } from '../core/historic-geometry-replay';

interface DailyComputationContext {
  scheduledFor: string;
  publicationMode: 'legacy' | 'versioned';
  sourceRevision: string;
  publicationId?: string;
  materializationVersion?: number;
}

export const HISTORIC_CATCHUP_ENABLED_ENV = 'HISTORIC_CATCHUP_ENABLED';

export function isHistoricCatchupEnabled(
  value = process.env[HISTORIC_CATCHUP_ENABLED_ENV],
): boolean {
  if (value === undefined) {
    return true;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  throw new Error(`${HISTORIC_CATCHUP_ENABLED_ENV} must be true or false`);
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
  private historicBoundaryInFlight: {
    scheduledFor: string;
    run: Promise<void>;
  } | null = null;

  constructor(
    private readonly arreteCadreService: ArreteCadreService,
    private readonly registry: ExternalPublicationRegistryService,
    private readonly zonePublicationService: ZonePublicationService,
    private readonly configService: ConfigService,
    private readonly statisticCacheReadiness: StatisticCacheReadinessService,
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
    if (current.publicationMode === 'versioned') {
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
    let reusablePublication: {
      publicationId: string;
      sourceRevision: string;
    } | null = null;
    if (isCurrentZoneRecomputeWorkerEnabled()) {
      reusablePublication =
        await this.zonePublicationService.findReusableDailyPublication({
          scheduledFor,
          sourceRevision: expectedSourceRevision,
        });
      if (reusablePublication) {
        try {
          if (
            String(reusablePublication.sourceRevision) !==
            expectedSourceRevision
          ) {
            throw new Error('Reusable publication source revision mismatch');
          }
          await this.assertSourceRevision(expectedSourceRevision);
          await this.arreteCadreService.assertVersionedDailyComputationReady(
            scheduledFor,
            expectedSourceRevision,
          );
        } catch {
          reusablePublication = null;
        }
      }
      if (!reusablePublication) {
        await this.arreteCadreService.updateArreteCadreStatut(
          false,
          undefined,
          scheduledFor,
        );
        return null;
      }
    }
    const currentResult = await this.registry.executeDailyRun(
      NATIONAL_DAILY_COMPUTE_JOB_KEY,
      scheduledFor,
      async () => {
        let publicationId: unknown;
        let sourceRevision: unknown;
        if (reusablePublication) {
          publicationId = reusablePublication.publicationId;
          sourceRevision = reusablePublication.sourceRevision;
        } else {
          const result = (await this.arreteCadreService.updateArreteCadreStatut(
            false,
            {
              scheduledFor,
              sourceRevision: expectedSourceRevision,
            },
          )) as {
            result?: { publicationId?: unknown; sourceRevision?: unknown };
          };
          publicationId = result?.result?.publicationId;
          sourceRevision = result?.result?.sourceRevision;
        }
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
    if (isCurrentZoneRecomputeWorkerEnabled()) {
      try {
        await this.arreteCadreService.assertLegacyDailyComputationCompleted(
          scheduledFor,
        );
      } catch {
        await this.arreteCadreService.updateArreteCadreStatut(
          false,
          undefined,
          scheduledFor,
        );
        return null;
      }
    }
    let completedSourceRevision: string | undefined;
    const currentResult = await this.registry.executeDailyRun(
      NATIONAL_DAILY_COMPUTE_JOB_KEY,
      scheduledFor,
      async () => {
        if (!isCurrentZoneRecomputeWorkerEnabled()) {
          const queueResult =
            await this.arreteCadreService.updateArreteCadreStatut(
              false,
              undefined,
              scheduledFor,
            );
          if (
            !['empty', 'processed', 'superseded'].includes(String(queueResult))
          ) {
            throw new Error(
              `Current zone recompute queue is ${String(queueResult ?? 'unknown')} for ${scheduledFor}`,
            );
          }
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
    if (
      !isHistoricCatchupEnabled() ||
      !isHistoricMutableGeometryReplayEnabled()
    ) {
      return;
    }
    if (this.historicUpdateInFlight?.scheduledFor === current.scheduledFor) {
      return;
    }
    const statisticArtifactRequired =
      current.publicationMode === 'legacy'
        ? isStatisticCacheArtifactRequired()
        : false;
    if (current.publicationMode === 'legacy' && statisticArtifactRequired) {
      await this.ensureLegacyHistoricBoundary(current);
    }
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

  private async ensureLegacyHistoricBoundary(
    current: DailyComputationContext,
  ): Promise<void> {
    while (this.historicBoundaryInFlight) {
      const boundary = this.historicBoundaryInFlight;
      await boundary.run;
      if (boundary.scheduledFor === current.scheduledFor) {
        return;
      }
    }

    const requiredThrough = shiftCivilDate(current.scheduledFor, -1);
    const run = (async () => {
      await this.arreteCadreService.prepareHistoricComputations(
        requiredThrough,
        current.sourceRevision,
      );
      await this.arreteCadreService.recoverIncompleteHistoricComputations(
        requiredThrough,
        current.sourceRevision,
      );
    })();
    this.historicBoundaryInFlight = {
      scheduledFor: current.scheduledFor,
      run,
    };
    try {
      await run;
    } finally {
      if (this.historicBoundaryInFlight?.run === run) {
        this.historicBoundaryInFlight = null;
      }
    }
  }

  private async runHistoricIfDue(
    current: DailyComputationContext,
    now: Date,
  ): Promise<void> {
    const materializationVersion = current.materializationVersion;
    const statisticArtifactRequired =
      current.publicationMode === 'legacy'
        ? isStatisticCacheArtifactRequired()
        : false;
    const statisticIdentity =
      current.publicationMode === 'legacy' && statisticArtifactRequired
        ? await this.getLegacyStatisticBoundary(current)
        : null;
    if (
      current.publicationMode === 'legacy' &&
      statisticArtifactRequired &&
      !statisticIdentity
    ) {
      return;
    }
    const historicIdentity = await this.getHistoricRunIdentity(
      current.sourceRevision,
      materializationVersion,
    );
    const publicationIdentity =
      current.publicationMode === 'versioned'
        ? historicIdentity
        : {
            publicationMode: 'legacy' as const,
            ...historicIdentity,
            ...(statisticIdentity
              ? this.toStatisticRunIdentity(statisticIdentity)
              : {}),
          };

    await this.registry.executeDailyRun(
      NATIONAL_HISTORIC_CATCHUP_JOB_KEY,
      current.scheduledFor,
      async () => {
        const requiredThrough = shiftCivilDate(current.scheduledFor, -1);
        const completedState = statisticIdentity
          ? await this.arreteCadreService.catchUpHistoricComputations(
              requiredThrough,
              current.sourceRevision,
              () => this.assertLegacyStatisticBoundary(statisticIdentity),
              {
                statisticRevision: statisticIdentity.statisticRevision,
                currentPublishedDate: statisticIdentity.statisticPublishedDate,
              },
            )
          : await this.arreteCadreService.catchUpHistoricComputations(
              requiredThrough,
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
  }

  private async getLegacyStatisticBoundary(
    current: DailyComputationContext,
  ): Promise<StatisticCacheReadyIdentity | null> {
    const statisticIdentity =
      await this.statisticCacheReadiness.getReadyPublication(
        current.scheduledFor,
        current.sourceRevision,
      );
    if (!statisticIdentity) {
      return null;
    }
    const datagouvSucceeded = await this.registry.hasSucceeded(
      DATAGOUV_DAILY_JOB_KEY,
      current.scheduledFor,
      {
        publicationMode: 'legacy',
        sourceRevision: current.sourceRevision,
        ...this.toStatisticRunIdentity(statisticIdentity),
      },
    );
    return datagouvSucceeded ? statisticIdentity : null;
  }

  private async assertLegacyStatisticBoundary(
    expected: StatisticCacheReadyIdentity,
    now = new Date(),
  ): Promise<void> {
    const currentBusinessDate = getScheduledCivilDate(
      now,
      NATIONAL_COMPUTE_START_HOUR,
    );
    if (currentBusinessDate > expected.statisticPublishedDate) {
      throw new Error(
        `Statistic boundary ${expected.statisticPublishedDate} expired at business date ${currentBusinessDate}`,
      );
    }
    await this.assertSourceRevision(expected.sourceRevision);
    await this.statisticCacheReadiness.assertReadyPublication(expected);
    const datagouvSucceeded = await this.registry.hasSucceeded(
      DATAGOUV_DAILY_JOB_KEY,
      expected.statisticPublishedDate,
      {
        publicationMode: 'legacy',
        sourceRevision: expected.sourceRevision,
        ...this.toStatisticRunIdentity(expected),
      },
    );
    if (!datagouvSucceeded) {
      throw new Error(
        `Datagouv boundary changed for ${expected.statisticPublishedDate}/${expected.sourceRevision}`,
      );
    }
  }

  private toStatisticRunIdentity(identity: StatisticCacheReadyIdentity) {
    return {
      statisticCachePublicationId: identity.publicationId,
      statisticRevision: identity.statisticRevision,
      statisticPublishedDate: identity.statisticPublishedDate,
      statisticFingerprint: identity.statisticFingerprint,
    };
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
