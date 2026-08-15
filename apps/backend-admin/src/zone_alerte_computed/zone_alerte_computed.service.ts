import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ConfigService as NestConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Departement } from '@shared/entities/departement.entity';
import { ZoneAlerteComputed } from '@shared/entities/zone_alerte_computed.entity';
import * as fs from 'fs';
import moment from 'moment';
import { writeFile } from 'node:fs/promises';
import {
  DataSource,
  FindManyOptions,
  IsNull,
  QueryRunner,
  Repository,
} from 'typeorm';
import { Worker } from 'worker_threads';
import { createHash } from 'node:crypto';
import { ArreteRestrictionService } from '../arrete_restriction/arrete_restriction.service';
import { CommuneService } from '../commune/commune.service';
import { ConfigService } from '../config/config.service';
import { Utils } from '../core/utils';
import { DatagouvService } from '../datagouv/datagouv.service';
import { DepartementService } from '../departement/departement.service';
import { RegleauLogger } from '../logger/regleau.logger';
import { RestrictionService } from '../restriction/restriction.service';
import { S3Service } from '../shared/services/s3.service';
import { StatisticService } from '../statistic/statistic.service';
import { StatisticCommuneService } from '../statistic_commune/statistic_commune.service';
import { StatisticDepartementService } from '../statistic_departement/statistic_departement.service';
import {
  historicWorkerThreadFilePath,
  workerThreadFilePath,
} from '../worker_threads/config';
import { ZoneAlerteService } from '../zone_alerte/zone_alerte.service';
import {
  HistoricCursorState,
  ZoneAlerteComputedHistoricService,
} from './zone_alerte_computed_historic.service';
import {
  DailyZonePublicationReuseContext,
  ZonePublicationService,
} from '../zone_publication/zone_publication.service';
import { isZonePublicationEnabled } from '../zone_publication/zone_publication.config';
import { isStatisticCacheArtifactRequired } from '../statistic_cache/statistic_cache.config';
import { generateEmptyPmtiles } from './empty-pmtiles';
import {
  collectPmtilesFeatureIds,
  generatePmtiles,
} from './pmtiles-generation';
import { shouldRunWebScheduledJobs } from '../core/scheduling/business-cron';
import {
  getCivilDateAtUtcNoon,
  getScheduledCivilDate,
  NATIONAL_COMPUTE_START_HOUR,
} from '../core/scheduling/daily-job-schedule';

export const ZONE_COMPUTE_WORKER_TIMEOUT_MS = 60 * 60 * 1000;
const ZONE_PUBLICATION_WATCHDOG_INTERVAL_MS = 30 * 1000;
const HISTORIC_COMPUTE_LOCK_TIMEOUT_MS = 60 * 60 * 1000;
export const HISTORIC_COMPUTE_WORKER_TIMEOUT_MS = 4 * 60 * 60 * 1000;
export const HISTORIC_COMPUTE_CHUNK_DAYS_DEFAULT = 7;
const HISTORIC_COMPUTE_CHUNK_DAYS_MAX = 3660;

export function readHistoricComputeChunkDays(
  value = process.env.HISTORIC_COMPUTE_CHUNK_DAYS,
): number {
  if (value === undefined || value.trim() === '') {
    return HISTORIC_COMPUTE_CHUNK_DAYS_DEFAULT;
  }
  const normalized = value.trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error('HISTORIC_COMPUTE_CHUNK_DAYS must be a positive integer');
  }
  const parsed = Number(normalized);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed > HISTORIC_COMPUTE_CHUNK_DAYS_MAX
  ) {
    throw new Error(
      `HISTORIC_COMPUTE_CHUNK_DAYS must be at most ${HISTORIC_COMPUTE_CHUNK_DAYS_MAX}`,
    );
  }
  return parsed;
}

export type HistoricBoundaryAssertion = () => Promise<void>;

export interface HistoricStatisticPublicationTarget {
  statisticRevision: string;
  currentPublishedDate: string;
}

export interface HistoricStatisticPreparation {
  status: 'prepared' | 'already-completed';
  statisticRevision: string;
  currentPublishedDate: string;
  historicDirtyFrom: string | null;
  historicDirtyThrough: string | null;
}

interface QueuedComputeWaiter {
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
}

type ComputedZoneGeoJsonSource = Pick<
  ZoneAlerteComputed,
  | 'id'
  | 'idSandre'
  | 'nom'
  | 'code'
  | 'type'
  | 'niveauGravite'
  | 'departement'
  | 'restriction'
>;

export function buildComputedZoneGeoJsonFeature(
  z: ComputedZoneGeoJsonSource,
  geometry: unknown,
) {
  const niveauGravite = z.niveauGravite;

  return {
    type: 'Feature',
    geometry,
    properties: {
      id: z.id,
      idSandre: z.idSandre,
      nom: z.nom,
      code: z.code,
      type: z.type,
      niveauGravite,
      departement: z.departement,
      arreteRestriction: {
        id: z.restriction?.arreteRestriction.id,
        numero: z.restriction?.arreteRestriction.numero,
        dateDebut: z.restriction?.arreteRestriction.dateDebut,
        dateFin: z.restriction?.arreteRestriction.dateFin,
        dateSignature: z.restriction?.arreteRestriction.dateSignature,
        fichier: z.restriction?.arreteRestriction.fichier?.url,
      },
      restrictions: z.restriction?.usages.map((u) => {
        let description;
        switch (niveauGravite) {
          case 'vigilance':
            description = u.descriptionVigilance;
            break;
          case 'alerte':
            description = u.descriptionAlerte;
            break;
          case 'alerte_renforcee':
            description = u.descriptionAlerteRenforcee;
            break;
          case 'crise':
            description = u.descriptionCrise;
            break;
        }
        return {
          nom: u.nom,
          thematique: u.thematique.nom,
          concerneParticulier: u.concerneParticulier,
          concerneEntreprise: u.concerneEntreprise,
          concerneCollectivite: u.concerneCollectivite,
          concerneExploitation: u.concerneExploitation,
          concerneEso: u.concerneEso,
          concerneEsu: u.concerneEsu,
          concerneAep: u.concerneAep,
          description,
        };
      }),
    },
  };
}

@Injectable()
export class ZoneAlerteComputedService {
  private readonly logger = new RegleauLogger('ZoneAlerteComputedService');
  private isComputing = false;
  private askForCompute = false;
  private departementsToUpdate: number[] = [];
  private pendingNationalCompute = false;
  private pendingNormalCompute = false;
  private pendingDailyPublicationReuse:
    DailyZonePublicationReuseContext | null | undefined;
  private pendingPublicationScheduledFor: string | null | undefined;
  private activeComputeWorker: Worker | null = null;
  private computeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private queuedComputeWaiters: QueuedComputeWaiter[] = [];
  private publicationWatchdogInProgress = false;
  private readonly historicComputedStartDate = '2024-04-29';
  constructor(
    @InjectRepository(ZoneAlerteComputed)
    private readonly zoneAlerteComputedRepository: Repository<ZoneAlerteComputed>,
    private readonly departementService: DepartementService,
    private readonly zoneAlerteService: ZoneAlerteService,
    private readonly communeService: CommuneService,
    @Inject(forwardRef(() => ArreteRestrictionService))
    private readonly arreteResrictionService: ArreteRestrictionService,
    private readonly s3Service: S3Service,
    private readonly nestConfigService: NestConfigService,
    private readonly restrictionService: RestrictionService,
    @Inject(forwardRef(() => DatagouvService))
    private readonly datagouvService: DatagouvService,
    private readonly statisticService: StatisticService,
    @Inject(forwardRef(() => StatisticDepartementService))
    private readonly statisticDepartementService: StatisticDepartementService,
    @Inject(forwardRef(() => StatisticCommuneService))
    private readonly statisticCommuneService: StatisticCommuneService,
    private readonly zoneAlerteComputedHistoricService: ZoneAlerteComputedHistoricService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    private readonly zonePublicationService: ZonePublicationService,
  ) {}

  findOne(id: number): Promise<any> {
    return this.zoneAlerteComputedRepository
      .createQueryBuilder('zone_alerte_computed')
      .select('zone_alerte_computed.id', 'id')
      .addSelect('zone_alerte_computed.idSandre', 'idSandre')
      .addSelect('zone_alerte_computed.code', 'code')
      .addSelect('zone_alerte_computed.nom', 'nom')
      .addSelect('zone_alerte_computed.type', 'type')
      .addSelect(
        'ST_AsGeoJSON(ST_TRANSFORM(zone_alerte_computed.geom, 4326))',
        'geom',
      )
      .where('zone_alerte_computed.id = :id', { id })
      .getRawOne();
  }

  async askCompute(
    depsIds?: number[],
    force = false,
    _computeHistoric = false,
    skipIfBusy = false,
    dailyPublicationReuse?: DailyZonePublicationReuseContext,
    publicationScheduledFor?: string,
  ) {
    // Historic catch-up is exclusively owned by the persistent clock scheduler.
    void _computeHistoric;
    if (
      publicationScheduledFor !== undefined &&
      dailyPublicationReuse !== undefined
    ) {
      throw new Error(
        'A zone computation cannot use legacy and versioned daily contexts together',
      );
    }
    if (publicationScheduledFor !== undefined) {
      getCivilDateAtUtcNoon(publicationScheduledFor);
    }
    this.departementsToUpdate = this.departementsToUpdate.concat(depsIds ?? []);
    if (!force && (!depsIds || depsIds.length === 0)) {
      this.pendingNationalCompute = true;
    }
    this.pendingNormalCompute ||= !skipIfBusy;
    if (!skipIfBusy && !dailyPublicationReuse) {
      this.pendingDailyPublicationReuse = null;
    }
    if (!skipIfBusy && publicationScheduledFor === undefined) {
      this.pendingPublicationScheduledFor = null;
    }
    if (publicationScheduledFor !== undefined) {
      if (this.pendingPublicationScheduledFor === undefined) {
        this.pendingPublicationScheduledFor = publicationScheduledFor;
      } else if (
        this.pendingPublicationScheduledFor !== null &&
        this.pendingPublicationScheduledFor !== publicationScheduledFor
      ) {
        this.pendingPublicationScheduledFor = null;
      }
    }
    if (dailyPublicationReuse) {
      if (this.pendingDailyPublicationReuse === undefined) {
        this.pendingDailyPublicationReuse = { ...dailyPublicationReuse };
      } else if (
        this.pendingDailyPublicationReuse !== null &&
        (this.pendingDailyPublicationReuse.scheduledFor !==
          dailyPublicationReuse.scheduledFor ||
          this.pendingDailyPublicationReuse.sourceRevision !==
            dailyPublicationReuse.sourceRevision)
      ) {
        this.pendingDailyPublicationReuse = null;
      }
    }
    if (force && !this.askForCompute) {
      return;
    }
    if (this.isComputing) {
      this.askForCompute = true;
      this.scheduleComputeRetry();
      return new Promise((resolve, reject) => {
        this.queuedComputeWaiters.push({ resolve, reject });
      });
    }
    let queuedWaiters: QueuedComputeWaiter[] = [];
    try {
      this.askForCompute = false;
      this.isComputing = true;

      const uniqueDepsIds = this.pendingNationalCompute
        ? []
        : [...new Set(this.departementsToUpdate)];
      this.departementsToUpdate = [];
      this.pendingNationalCompute = false;
      const effectiveSkipIfBusy = !this.pendingNormalCompute;
      const effectiveDailyPublicationReuse =
        this.pendingDailyPublicationReuse ?? undefined;
      const effectivePublicationScheduledFor =
        this.pendingPublicationScheduledFor ?? undefined;
      this.pendingNormalCompute = false;
      this.pendingDailyPublicationReuse = undefined;
      this.pendingPublicationScheduledFor = undefined;
      queuedWaiters = this.queuedComputeWaiters.splice(0);

      const resolveQueuedWaiters = (result: unknown) => {
        queuedWaiters.splice(0).forEach(({ resolve }) => resolve(result));
      };
      const rejectQueuedWaiters = (error: unknown) => {
        queuedWaiters.splice(0).forEach(({ reject }) => reject(error));
      };

      if (effectiveSkipIfBusy && (await this.isGlobalZoneComputeBusy())) {
        const result = { success: true, skipped: true };
        this.isComputing = false;
        resolveQueuedWaiters(result);
        return result;
      }

      const worker = new Worker(workerThreadFilePath, {
        workerData: {
          depsIds: uniqueDepsIds,
          skipIfBusy: effectiveSkipIfBusy,
          ...(effectiveDailyPublicationReuse
            ? { dailyPublicationReuse: effectiveDailyPublicationReuse }
            : {}),
          ...(effectivePublicationScheduledFor
            ? { publicationScheduledFor: effectivePublicationScheduledFor }
            : {}),
        },
      });
      this.activeComputeWorker = worker;

      return new Promise((resolve, reject) => {
        let currentResultReceived = false;
        let promiseSettled = false;
        let timedOut = false;
        const releaseComputeSlot = () => {
          if (this.activeComputeWorker === worker) {
            this.activeComputeWorker = null;
            this.isComputing = false;
          }
        };
        const timeout = setTimeout(async () => {
          timedOut = true;
          const timeoutError = new Error('COMPUTE ALL worker timed out');
          this.logger.error(timeoutError.message, '');
          try {
            await worker.terminate();
          } catch (error) {
            this.logger.error(
              'COMPUTE ALL WORKER TERMINATION ERROR',
              error instanceof Error ? error.toString() : String(error),
            );
          }
          if (!promiseSettled) {
            promiseSettled = true;
            releaseComputeSlot();
            rejectQueuedWaiters(timeoutError);
            reject(timeoutError);
          }
        }, ZONE_COMPUTE_WORKER_TIMEOUT_MS);

        worker.on('message', (result) => {
          if (timedOut) {
            return;
          }
          currentResultReceived = true;
          if (result?.success === false) {
            clearTimeout(timeout);
            promiseSettled = true;
            releaseComputeSlot();
            const error = new Error(
              result.error || 'COMPUTE ALL worker reported an error',
            );
            this.logger.error('COMPUTE ALL WORKER ERROR', error.toString());
            rejectQueuedWaiters(error);
            reject(error);
            return;
          }
          clearTimeout(timeout);
          promiseSettled = true;
          releaseComputeSlot();
          resolveQueuedWaiters(result);
          resolve(result);
        });

        worker.on('error', (error) => {
          if (timedOut) {
            return;
          }
          clearTimeout(timeout);
          releaseComputeSlot();
          if (promiseSettled) {
            return;
          }
          promiseSettled = true;
          this.logger.error('COMPUTE ALL WORKER ERROR', error.toString());
          rejectQueuedWaiters(error);
          reject(error);
        });

        worker.on('exit', (code) => {
          clearTimeout(timeout);
          releaseComputeSlot();
          if (timedOut) {
            return;
          }
          if (promiseSettled || currentResultReceived) {
            return;
          }
          promiseSettled = true;
          const errorMessage =
            code === 0
              ? 'COMPUTE ALL worker exited without a result'
              : `COMPUTE ALL Worker stopped with exit code ${code}`;
          this.logger.error(errorMessage, '');
          const error = new Error(errorMessage);
          rejectQueuedWaiters(error);
          reject(error);
        });
      });
    } catch (e) {
      this.logger.error('COMPUTE ALL', e.toString());
      this.activeComputeWorker = null;
      this.isComputing = false;
      queuedWaiters.splice(0).forEach(({ reject }) => reject(e));
      throw e;
    }
  }

  private async isGlobalZoneComputeBusy(): Promise<boolean> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    let locked = false;
    try {
      const [lockResult] = await queryRunner.query(
        "SELECT pg_try_advisory_lock(hashtext('vigieau'), hashtext('zone-compute-global')) AS locked",
      );
      locked = lockResult?.locked === true;
      return !locked;
    } finally {
      try {
        if (locked) {
          const [unlockResult] = await queryRunner.query(
            "SELECT pg_advisory_unlock(hashtext('vigieau'), hashtext('zone-compute-global')) AS unlocked",
          );
          if (unlockResult?.unlocked !== true) {
            throw new Error(
              'Unable to release the zone compute preflight lock',
            );
          }
        }
      } finally {
        await queryRunner.release();
      }
    }
  }

  private scheduleComputeRetry(): void {
    if (this.computeRetryTimer) {
      return;
    }
    this.computeRetryTimer = setTimeout(() => {
      this.computeRetryTimer = null;
      void this.askCompute([], true, false, true).catch((error) => {
        this.logger.error('COMPUTE ALL QUEUED WORKER ERROR', error);
      });
    }, 10 * 1000);
  }

  async findOneWithCommuneZone(id: number, communeId: number): Promise<any> {
    const zoneFull = await this.zoneAlerteComputedRepository.findOne({
      where: { id },
      relations: ['departement', 'bassinVersant', 'restriction'],
    });
    const zoneGeom = await this.zoneAlerteComputedRepository
      .createQueryBuilder('zone_alerte_computed')
      .select(
        `ST_AsGeoJSON(ST_TRANSFORM((select commune.geom from commune where commune.id = ${communeId}), 4326))`,
        'geom',
      )
      .where('zone_alerte_computed.id = :id', { id })
      .getRawOne();
    zoneFull.geom = zoneGeom.geom;
    return zoneFull;
  }

  @Interval(ZONE_PUBLICATION_WATCHDOG_INTERVAL_MS)
  async ensureFreshZonePublication(): Promise<void> {
    if (
      !shouldRunWebScheduledJobs() ||
      !isZonePublicationEnabled() ||
      this.isComputing ||
      this.publicationWatchdogInProgress
    ) {
      return;
    }
    this.publicationWatchdogInProgress = true;
    try {
      if (
        await this.zonePublicationService.promoteCertifiedPublicationIfAvailable()
      ) {
        return;
      }
      if (await this.zonePublicationService.isRecomputeRequired()) {
        await this.askCompute([], false, false, true);
      }
    } catch (error) {
      this.logger.error('ZONE PUBLICATION WATCHDOG ERROR', error);
    } finally {
      this.publicationWatchdogInProgress = false;
    }
  }

  async computeAll(
    depsId?: number[],
    computeHistoric?: boolean,
    scheduledFor?: string,
  ) {
    this.logger.log(`COMPUTING ZONES D'ALERTES - BEGIN`);
    const isNationalCompute = !depsId?.length;
    const requiresStatisticCertificationContext =
      isNationalCompute || !isZonePublicationEnabled();
    const publicationScheduledFor = requiresStatisticCertificationContext
      ? (scheduledFor ??
        getScheduledCivilDate(new Date(), NATIONAL_COMPUTE_START_HOUR))
      : undefined;
    if (publicationScheduledFor !== undefined) {
      getCivilDateAtUtcNoon(publicationScheduledFor);
    }
    const sourceRevision = requiresStatisticCertificationContext
      ? await this.zonePublicationService.getSourceRevision()
      : undefined;
    const historicComputeEpoch = requiresStatisticCertificationContext
      ? String(
          (await this.configService.getConfig())?.historicComputeEpoch ?? '',
        )
      : undefined;
    if (
      requiresStatisticCertificationContext &&
      (historicComputeEpoch === undefined ||
        !/^\d+$/.test(historicComputeEpoch))
    ) {
      throw new Error('National computation is missing its historic epoch');
    }
    this.departementsToUpdate = [];
    let departements = await this.departementService.findAllLight();
    if (depsId && depsId.length > 0) {
      departements = departements.filter((d) =>
        depsId.some((dep) => dep === d.id),
      );
    }
    for (const departement of departements) {
      const param = departement.parametres.find(
        (p) => !p.disabled,
      )?.superpositionCommune;
      const zonesSaved = await this.computeRegleAr(departement);
      if (zonesSaved.length > 0) {
        switch (param) {
          case 'no':
          case 'no_all':
            break;
          case 'yes_all':
            await this.computeYesDistinct(departement, false);
            await this.computeYesAll(departement, false);
            break;
          case 'yes_only_aep':
            await this.computeYesDistinct(departement, true);
            break;
          case 'yes_except_aep':
            await this.computeYesDistinct(departement, false);
            await this.computeYesAll(departement, true);
            break;
          case 'yes_distinct':
            await this.computeYesDistinct(departement, false);
            break;
          default:
            this.logger.error(
              `COMPUTING ${departement.code} - ${departement.nom} - ${param} not implemented`,
              '',
            );
        }
      }
      await this.computeCommunesIntersected(departement);
    }
    // On récupère toutes les restrictions en cours
    this.logger.log(`COMPUTING ZONES D'ALERTES - END`);
    return this.computeGeoJson(
      computeHistoric,
      sourceRevision,
      publicationScheduledFor,
      historicComputeEpoch,
      isNationalCompute,
    );
  }

  async computeAllOrReuseDailyPublication(
    depsIds: number[],
    dailyPublicationReuse?: DailyZonePublicationReuseContext,
    publicationScheduledFor?: string,
  ) {
    if (depsIds.length === 0 && dailyPublicationReuse) {
      const reusablePublication =
        await this.zonePublicationService.findReusableDailyPublication(
          dailyPublicationReuse,
        );
      if (reusablePublication) {
        this.logger.log(
          `Reusing daily zone publication ${reusablePublication.publicationId} for ${dailyPublicationReuse.scheduledFor}`,
        );
        return reusablePublication;
      }
      return this.computeAll(
        depsIds,
        false,
        dailyPublicationReuse.scheduledFor,
      );
    }
    return publicationScheduledFor === undefined
      ? this.computeAll(depsIds, false)
      : this.computeAll(depsIds, false, publicationScheduledFor);
  }

  async computeRegleAr(departement: Departement) {
    const arretesRestrictions =
      await this.arreteResrictionService.findByDepartement(departement.code);
    this.logger.log(
      `COMPUTING ${departement.code} - ${departement.nom} - ${arretesRestrictions.length} arrêtés de restriction`,
    );
    let zonesToSave = [];
    for (const ar of arretesRestrictions) {
      await Promise.all(
        ar.restrictions.map(async (restriction) => {
          if (restriction.zoneAlerte) {
            const arreteCadreId = restriction.arreteCadre?.id;
            const za = await this.zoneAlerteService.findOne(
              restriction.zoneAlerte.id,
              arreteCadreId === undefined ? undefined : [arreteCadreId],
            );
            za.restriction = {
              id: restriction.id,
              niveauGravite: restriction.niveauGravite,
            };
            za.departement = { id: departement.id };

            if (
              za.arreteCadreZoneAlerteCommunes &&
              za.arreteCadreZoneAlerteCommunes[0] &&
              za.arreteCadreZoneAlerteCommunes[0].communes?.length > 0
            ) {
              za.geom =
                await this.zoneAlerteService.getUnionGeomOfZoneAndCommunes(
                  restriction.zoneAlerte.id,
                  za.arreteCadreZoneAlerteCommunes[0].communes.map((c) => c.id),
                );
            }
            // SAUVEGARDE ZONE ESU ou ESO
            zonesToSave.push(za);
          } else if (restriction.communes?.length > 0) {
            const za = {
              nom: restriction.nomGroupementAep,
              type: 'AEP',
              geom: null,
              departement: { id: departement.id },
              bassinVersant: null,
              restriction: {
                id: restriction.id,
                niveauGravite: restriction.niveauGravite,
              },
            };
            za.geom = (
              await this.communeService.getUnionGeomOfCommunes(
                restriction.communes,
              )
            ).geom;
            // SAUVEGARDE ZONE AEP
            zonesToSave.push(za);
          }
        }),
      );
    }

    zonesToSave = zonesToSave
      .filter((z) => z.geom)
      .map((z) => {
        z.id = null;
        z.geom = JSON.parse(z.geom);
        z.niveauGravite = z.restriction.niveauGravite;
        return z;
      })
      .filter((z) => z.geom.coordinates.length > 0);
    await Promise.all([
      this.zoneAlerteComputedRepository.delete({ departement: IsNull() }),
      this.zoneAlerteComputedRepository.delete({ departement: departement }),
    ]);
    const toReturn = await this.zoneAlerteComputedRepository.save(zonesToSave);
    if (toReturn.length > 0) {
      await this.cleanZones(departement);
    }
    const param = departement.parametres.find(
      (p) => !p.disabled,
    )?.superpositionCommune;
    if (!param || param !== 'yes_all') {
      await this.computeRegleAepNotSpecific(departement);
    }
    this.logger.log(
      `COMPUTING ${departement.code} - ${departement.nom} - ${zonesToSave.length} zones ajoutées`,
    );
    return toReturn;
  }

  async computeRegleAepNotSpecific(departement: Departement) {
    const arretesRestrictions =
      await this.arreteResrictionService.findByDepartement(departement.code);
    const zonesDepartement =
      await this.getZonesAlerteComputedByDepartement(departement);
    let zonesToSave = [];
    for (const ar of arretesRestrictions) {
      const zonesAr = zonesDepartement.filter(
        (z) => z.restriction.arreteRestriction.id === ar.id,
      );
      if (
        ar.niveauGraviteSpecifiqueEap === false &&
        ar.ressourceEapCommunique &&
        zonesAr.length > 0
      ) {
        let allZones;

        if (
          ar.ressourceEapCommunique === 'eso' ||
          ar.ressourceEapCommunique === 'esu'
        ) {
          allZones = zonesAr.filter(
            (z) =>
              z.type ===
                (ar.ressourceEapCommunique === 'eso' ? 'SOU' : 'SUP') &&
              ar.restrictions.some((r) => r.id === z.restriction.id),
          );
          allZones = structuredClone(allZones);
        } else {
          const zonesEsu: any = structuredClone(
            zonesAr.filter((z) => z?.type === 'SUP'),
          );
          const zonesEso: any = structuredClone(
            zonesAr.filter((z) => z?.type === 'SOU'),
          );
          allZones = [...zonesEsu, ...zonesEso];
        }

        // On boucle sur toutes les zones et on stock un tableau intersect avec les autres zones
        if (allZones.length > 1) {
          for (const zone of allZones) {
            zone.intersect = await this.getIntersect(
              zone.id,
              allZones.filter((z) => z.id !== zone.id).map((z) => z.id),
            );
          }
        }

        // Pour les zones de l'AR qui ne s'intersectent pas, on peut les copier et les enregistrer sous AEP
        const zonesWithoutIntersection = allZones
          .filter((z) => !z.intersect || z.intersect.length < 1)
          .map((z) => {
            z.type = 'AEP';
            return z;
          });
        zonesToSave = zonesToSave.concat(zonesWithoutIntersection);
        // Pour chaque couple de zone qui s'intersectent, vérifier celle qui a le niveau de gravité max et qui doit être prioritaire
        let zonesWithIntersection = allZones
          .filter((z) => z.intersect && z.intersect.length > 0)
          .map((z) => {
            z.add = [];
            z.remove = [];
            return z;
          });

        for (const z of allZones.filter(
          (z) => z.intersect && z.intersect.length > 0,
        )) {
          for (const zIntersected of z.intersect) {
            // On décide ici quelle portion de quelle zone on ajoute ou on enlève à l'autre
            // Si même niveau de gravité, on prend la zone au pif
            // Si ressource naturelle && ressource influencée, la ressource naturelle à l'aval pour l'AEP
            if (
              (z.type === zIntersected.type &&
                !z.ressourceInfluencee &&
                zIntersected.ressourceInfluencee) ||
              (!(
                z.type === zIntersected.type &&
                z.ressourceInfluencee &&
                !zIntersected.ressourceInfluencee
              ) &&
                this.getNiveauGravite(z.id, ar.restrictions) >=
                  this.getNiveauGravite(zIntersected.id, ar.restrictions))
            ) {
              zonesWithIntersection
                .find((zwi) => zwi.id === z.id)
                .add.push(zIntersected.id);
              zonesWithIntersection
                .find((zwi) => zwi.id === zIntersected.id)
                .remove.push(z.id);
            } else {
              zonesWithIntersection
                .find((zwi) => zwi.id === z.id)
                .remove.push(zIntersected.id);
              zonesWithIntersection
                .find((zwi) => zwi.id === zIntersected.id)
                .add.push(z.id);
            }

            // On supprime la zone en question de zIntersected afin de ne pas faire le calcul en double
            const zi = allZones.find((az) => az.id === zIntersected.id);
            zi.intersect = zi.intersect.filter((iz) => iz.id !== z.id);
          }
        }

        for (const z of zonesWithIntersection) {
          // On construit les nouvelles géométries de zones
          z.geom = (await this.computeNewZone(z)).geom;
        }
        zonesWithIntersection = zonesWithIntersection.map((z) => {
          z.type = 'AEP';
          return z;
        });
        zonesToSave = zonesToSave.concat(zonesWithIntersection);
      }
    }
    zonesToSave = zonesToSave
      .map((z) => {
        z.id = null;
        z.geom = JSON.parse(z.geom);
        return z;
      })
      .filter((z) => z.geom.coordinates.length > 0);
    const toReturn = await this.zoneAlerteComputedRepository.save(zonesToSave);
    if (toReturn.length > 0) {
      await this.cleanZones(departement);
    }
  }

  // Chaque type de zone doit être harmonisé indépendamment à la commune
  async computeYesDistinct(departement, onlyAep: boolean) {
    this.logger.log(
      `COMPUTING ${departement.code} - ${departement.nom} - ${onlyAep ? 'YES_ONLY_AEP' : 'YES_DISTINCT'} BEGIN`,
    );
    // On récupères les communes avec des ZA qui ne couvrent pas totalement la zone
    const communes =
      await this.communeService.getZoneAlerteComputedForHarmonisation(
        departement.id,
      );
    const zoneTypes = onlyAep ? ['AEP'] : ['SUP', 'SOU', 'AEP'];
    const queries = [];
    for (const commune of communes) {
      for (const zoneType of zoneTypes) {
        let zonesSameType = commune.zones.filter((z) => z.type === zoneType);
        // Gestion des zones influencées
        // Si il y a des ressources influencées ET des ressources naturelles, on exclut les ressources influencées des calculs
        if (
          zonesSameType.length > 1 &&
          zonesSameType.some(
            (z) => z.ressourceInfluencee && z.areaCommunePercentage >= 5,
          ) &&
          zonesSameType.some(
            (z) => !z.ressourceInfluencee && z.areaCommunePercentage >= 5,
          )
        ) {
          zonesSameType = zonesSameType.filter((z) => !z.ressourceInfluencee);
        }

        // Quand une seule zone, on l'agrandie à la geometrie de la commune
        if (
          zonesSameType.length === 1 &&
          zonesSameType[0].areaCommunePercentage >= 5
        ) {
          queries.push(
            this.getQueryToExtendZone(zonesSameType[0].id, commune.id),
          );
        } else if (zonesSameType.length > 1) {
          // Si plusieurs zones, soit elles sont toutes au même niveau de gravité et on prend celle qui couvre le plus le territoire
          // Soit on prend celle qui a le niveau de gravité le plus élevé
          const zonesSameTypeExploitables = zonesSameType.filter(
            (z) => z.areaCommunePercentage >= 5,
          );
          if (zonesSameTypeExploitables.length >= 1) {
            const maxNiveauGravite = zonesSameTypeExploitables.reduce(
              (prev, current) => {
                return Utils.getNiveau(prev.niveauGravite) >
                  Utils.getNiveau(current.niveauGravite)
                  ? prev
                  : current;
              },
            );
            const zonesSameTypeMaxNiveau = zonesSameTypeExploitables.filter(
              (z) => z.niveauGravite === maxNiveauGravite.niveauGravite,
            );
            const zoneToExtend =
              zonesSameTypeMaxNiveau.length === 1
                ? zonesSameTypeMaxNiveau[0]
                : zonesSameTypeMaxNiveau.reduce((prev, current) => {
                    return prev.areaCommune > current.areaCommune
                      ? prev
                      : current;
                  });
            const zonesToReduce = zonesSameType.filter(
              (z) => z.id !== zoneToExtend.id,
            );
            queries.push(
              this.getQueryToExtendZone(zoneToExtend.id, commune.id),
            );
            zonesToReduce.forEach((z) => {
              queries.push(this.getQueryToReduceZone(z.id, commune.id));
            });
          }
        }
      }
    }
    await Promise.all(queries.map((q) => q.execute()));
    await this.cleanZones(departement);
    this.logger.log(
      `COMPUTING ${departement.code} - ${departement.nom} - ${onlyAep ? 'YES_ONLY_AEP' : 'YES_DISTINCT'} END`,
    );
  }

  async computeYesAll(departement, exceptAep: boolean) {
    this.logger.log(
      `COMPUTING ${departement.code} - ${departement.nom} - ${exceptAep ? 'YES_EXCEPT_AEP' : 'YES_ALL'} BEGIN`,
    );
    // On récupères les communes avec des ZA (même celles qui couvrent totalement la commune)
    const communes =
      await this.communeService.getZoneAlerteComputedForHarmonisation(
        departement.id,
      );
    const zoneTypes = exceptAep ? ['SUP', 'SOU'] : ['SUP', 'SOU', 'AEP'];
    const queries = [];
    let zonesToSave = [];
    for (const commune of communes) {
      // On filtre sur les aires des zones / communes pour éviter les zones résiduelles
      const zones = commune.zones.filter(
        (z) =>
          zoneTypes.includes(z.type) &&
          commune.area.toFixed(10) === z.areaCommune.toFixed(10),
      );
      if (!zones || zones.length <= 0) {
        continue;
      }
      const maxNiveauGravite = zones.reduce((prev, current) => {
        return Utils.getNiveau(prev.niveauGravite) >
          Utils.getNiveau(current.niveauGravite)
          ? prev
          : current;
      }).niveauGravite;
      for (const zoneType of zoneTypes) {
        // Normalement il y a au maximum une zone par type mais si ils ont fait plusieurs AR avec des règles de gestions différentes il se peut que plusieurs zones AEP se superposent
        let zonesSameType = zones.filter((z) => z.type === zoneType);

        // Gestion des ressources influencées
        if (
          zonesSameType.some((z) => z.ressourceInfluencee) &&
          zonesSameType.some((z) => !z.ressourceInfluencee)
        ) {
          zonesSameType = zonesSameType.filter((z) => !z.ressourceInfluencee);
        }

        if (
          zonesSameType.length === 1 &&
          zonesSameType[0].niveauGravite !== maxNiveauGravite
        ) {
          // Si il n'y a qu'une zone et que ce n'est pas son niveau de gravité de base, on la duplique pour avoir la zone au niveau de la commune avec le bon niveau de gravité
          const zoneToDuplicate = await this.findOneWithCommuneZone(
            zonesSameType[0].id,
            commune.id,
          );
          zoneToDuplicate.niveauGravite = maxNiveauGravite;
          zonesToSave.push(zoneToDuplicate);
          queries.push(
            this.getQueryToReduceZone(zonesSameType[0].id, commune.id),
          );
        } else if (zonesSameType.length > 1) {
          // Si plusieurs zones du même type, on prend celle qui a le niveau de gravité le plus élevé, ou une au pif
          const maxNiveauGraviteZonesSameType = zonesSameType.reduce(
            (prev, current) => {
              return Utils.getNiveau(prev.niveauGravite) >
                Utils.getNiveau(current.niveauGravite)
                ? prev
                : current;
            },
          ).niveauGravite;
          let zoneToKeep = zonesSameType.filter(
            (z) => z.niveauGravite === maxNiveauGraviteZonesSameType,
          );
          if (zoneToKeep.length > 1) {
            zoneToKeep = zoneToKeep.reduce((prev, current) => {
              return prev.areaCommune > current.areaCommune ? prev : current;
            });
          } else {
            zoneToKeep = zoneToKeep[0];
          }
          if (zoneToKeep.niveauGravite !== maxNiveauGravite) {
            const zoneToDuplicate = await this.findOneWithCommuneZone(
              zoneToKeep.id,
              commune.id,
            );
            zoneToDuplicate.niveauGravite = maxNiveauGravite;
            zonesToSave.push(zoneToDuplicate);
            queries.push(this.getQueryToReduceZone(zoneToKeep.id, commune.id));
          } else {
            queries.push(this.getQueryToExtendZone(zoneToKeep.id, commune.id));
          }
          zonesSameType
            .filter((z) => z.id !== zoneToKeep.id && !z.ressourceInfluencee)
            .forEach((z) => {
              queries.push(this.getQueryToReduceZone(z.id, commune.id));
            });
        } else if (zonesSameType.length <= 0) {
          // Si il n'y a pas de zone, on en crée une
          let zoneToDuplicate = zones
            .filter((z) => z.niveauGravite === maxNiveauGravite)
            .reduce((prev, current) => {
              return prev.areaCommune > current.areaCommune ? prev : current;
            });
          zoneToDuplicate = await this.findOneWithCommuneZone(
            zoneToDuplicate.id,
            commune.id,
          );
          zoneToDuplicate.type = zoneType;
          zonesToSave.push(zoneToDuplicate);
        }
      }
    }
    await Promise.all(queries.map((q) => q.execute()));
    zonesToSave = zonesToSave.map((z) => {
      z.id = null;
      z.geom = JSON.parse(z.geom);
      return z;
    });
    await this.zoneAlerteComputedRepository.save(zonesToSave);
    await this.fusionSameZones(departement);
    await this.cleanZones(departement);
    this.logger.log(
      `COMPUTING ${departement.code} - ${departement.nom} - ${exceptAep ? 'YES_EXCEPT_AEP' : 'YES_ALL'} END`,
    );
  }

  getNiveauGravite(zoneId, restrictions) {
    const r = restrictions.find((r) =>
      r.zonesAlerteComputed?.some((z) => z.id === zoneId),
    );
    return Utils.getNiveau(r?.niveauGravite);
  }

  getQueryToExtendZone(zoneId, communeId) {
    return this.zoneAlerteComputedRepository
      .createQueryBuilder('zone_alerte_computed')
      .update()
      .set({
        geom: () =>
          `ST_UNION(zone_alerte_computed.geom, (select c.geom from commune as c where c.id = ${communeId}))`,
      })
      .where('zone_alerte_computed.id = :id', { id: zoneId });
  }

  getQueryToReduceZone(zoneId, communeId) {
    return this.zoneAlerteComputedRepository
      .createQueryBuilder('zone_alerte_computed')
      .update()
      .set({
        geom: () =>
          `ST_DIFFERENCE(zone_alerte_computed.geom, (select c.geom from commune as c where c.id = ${communeId}))`,
      })
      .where('zone_alerte_computed.id = :id', { id: zoneId });
  }

  async cleanZones(departement: Departement) {
    await this.zoneAlerteComputedRepository
      .createQueryBuilder('zone_alerte_computed')
      .update()
      .set({
        geom: () =>
          `st_makevalid(geom, 'method=structure keepcollapsed=false')`,
      })
      .where('not st_isvalid(geom)')
      .andWhere('"departementId" = :id', { id: departement.id })
      .execute();
    await this.zoneAlerteComputedRepository
      .createQueryBuilder('zone_alerte_computed')
      .update()
      .set({ geom: () => 'ST_CollectionExtract(geom, 3)' })
      .where('"departementId" = :id', { id: departement.id })
      .execute();
    await this.dataSource.query(
      `
        UPDATE zone_alerte_computed
        SET geom = ST_CollectionExtract(
          ST_MakeValid(geom, 'method=structure keepcollapsed=false'),
          3
        )
        WHERE "departementId" = $1
          AND geom IS NOT NULL
          AND NOT ST_IsEmpty(geom)
          AND NOT ST_IsValid(geom, 0)
      `,
      [departement.id],
    );
    await this.dataSource.query(
      `
        DELETE FROM zone_alerte_computed
        WHERE "departementId" = $1
          AND (
            geom IS NULL
            OR ST_IsEmpty(geom)
            OR ST_GeometryType(geom) NOT IN ('ST_Polygon', 'ST_MultiPolygon')
          )
      `,
      [departement.id],
    );
    const [validation] = await this.dataSource.query(
      `
        SELECT COALESCE(array_agg(id ORDER BY id), ARRAY[]::integer[])
          AS "invalidIds"
        FROM zone_alerte_computed
        WHERE "departementId" = $1
          AND geom IS NOT NULL
          AND NOT ST_IsEmpty(geom)
          AND ST_GeometryType(geom) IN ('ST_Polygon', 'ST_MultiPolygon')
          AND NOT ST_IsValid(geom, 0)
      `,
      [departement.id],
    );
    const invalidIds = (validation?.invalidIds ?? []).map(Number);
    if (invalidIds.length > 0) {
      throw new Error(
        `Geometries de zones calculees invalides apres nettoyage: ${invalidIds.join(',')}`,
      );
    }
    // Clean des résidus de moins de 100m²
    await this.dataSource.query(
      `
WITH cleaned_geometries AS (
      SELECT
          id,
          ST_Collect(geom) AS cleaned_geom
      FROM (
          SELECT
              id,
              (ST_Dump(geom)).geom AS geom
          FROM zone_alerte_computed
          WHERE "departementId" = $1
      ) AS dumped
      WHERE ST_GeometryType(geom) = 'ST_Polygon' AND ST_Area(ST_Transform(geom, 2154)) > 100
      GROUP BY id
    )
    UPDATE zone_alerte_computed
    SET geom = cleaned_geometries.cleaned_geom
    FROM cleaned_geometries
    WHERE zone_alerte_computed.id = cleaned_geometries.id AND zone_alerte_computed."departementId" = $1;
  `,
      [departement.id],
    );
    await this.dataSource.query(
      `
        DELETE FROM zone_alerte_computed zone
        WHERE zone."departementId" = $1
          AND NOT EXISTS (
            SELECT 1
            FROM ST_Dump(zone.geom) dumped
            WHERE ST_GeometryType(dumped.geom) = 'ST_Polygon'
              AND ST_Area(ST_Transform(dumped.geom, 2154)) > 100
          )
      `,
      [departement.id],
    );
    return;
  }

  async fusionSameZones(departement: Departement) {
    const groupedResults = await this.zoneAlerteComputedRepository
      .createQueryBuilder('zone_alerte_computed')
      .select('MIN(id)', 'id')
      .addSelect(['nom', 'type', '"niveauGravite"'])
      .addSelect('ST_Union(geom)', 'merged_geom')
      .groupBy('nom')
      .addGroupBy('type')
      .addGroupBy('"niveauGravite"')
      .where('"departementId" = :id', { id: departement.id })
      .having('COUNT(*) > 1')
      .getRawMany();

    await Promise.all(
      groupedResults.map(async (row) => {
        const { id, merged_geom } = row;
        return this.dataSource.query(
          `
UPDATE zone_alerte_computed 
    SET geom = $1
    WHERE id = $2
  `,
          [merged_geom, id],
        );
      }),
    );

    await Promise.all(
      groupedResults.map(async (row) => {
        const { nom, type, niveauGravite, id } = row;
        return this.dataSource.query(
          `
DELETE FROM zone_alerte_computed 
    WHERE nom = $2 AND type = $3 AND "niveauGravite" = $4 AND "departementId" = $5 AND id != $1
  `,
          [id, nom, type, niveauGravite, departement.id],
        );
      }),
    );
  }

  async computeGeoJson(
    computeHistoric?: boolean,
    sourceRevision?: string,
    scheduledFor?: string,
    historicComputeEpoch?: string,
    isNationalCompute = sourceRevision !== undefined,
  ) {
    const publicationEnabled = isZonePublicationEnabled();
    if (
      !publicationEnabled &&
      (sourceRevision === undefined ||
        historicComputeEpoch === undefined ||
        scheduledFor === undefined)
    ) {
      throw new Error(
        'Legacy computation is missing its statistic certification context',
      );
    }
    const isNationalVersionedCompute =
      isNationalCompute && publicationEnabled && sourceRevision !== undefined;
    if (isNationalVersionedCompute && scheduledFor === undefined) {
      throw new Error(
        'National versioned computation is missing its scheduled civil date',
      );
    }
    const allZonesComputed: any = await this.zoneAlerteComputedRepository.find(<
      FindManyOptions
    >{
      select: {
        id: true,
        idSandre: true,
        code: true,
        nom: true,
        type: true,
        niveauGravite: true,
        departement: {
          code: true,
          nom: true,
        },
        restriction: {
          niveauGravite: true,
          arreteRestriction: {
            id: true,
            numero: true,
            dateDebut: true,
            dateFin: true,
            dateSignature: true,
            fichier: {
              url: true,
            },
          },
          usages: {
            nom: true,
            concerneParticulier: true,
            concerneEntreprise: true,
            concerneExploitation: true,
            concerneCollectivite: true,
            concerneEso: true,
            concerneEsu: true,
            concerneAep: true,
            descriptionVigilance: true,
            descriptionAlerte: true,
            descriptionAlerteRenforcee: true,
            descriptionCrise: true,
            thematique: {
              nom: true,
            },
          },
        },
      },
      relations: [
        'departement',
        'restriction',
        'restriction.usages',
        'restriction.usages.thematique',
        'restriction.arreteRestriction',
        'restriction.arreteRestriction.fichier',
      ],
    });

    const allZones = await Promise.all(
      allZonesComputed.map(async (z) => {
        z.geom = JSON.parse((await this.findOne(z.id)).geom);
        return buildComputedZoneGeoJsonFeature(z, z.geom);
      }),
    );

    const geojson = {
      type: 'FeatureCollection',
      features: allZones,
    };
    const expectedPmtilesFeatureIds = collectPmtilesFeatureIds(allZones);

    const path = this.nestConfigService.get('PATH_TO_WRITE_FILE');

    const date =
      sourceRevision !== undefined && scheduledFor !== undefined
        ? getCivilDateAtUtcNoon(scheduledFor)
        : new Date();
    await writeFile(
      `${path}/zones_arretes_en_vigueur.geojson`,
      JSON.stringify(geojson),
    );
    const dataGeojson = fs.readFileSync(
      `${path}/zones_arretes_en_vigueur.geojson`,
    );
    const fileToTransferGeojson = {
      originalname: `zones_arretes_en_vigueur.geojson`,
      buffer: dataGeojson,
    };
    const geojsonChecksum = createHash('sha256')
      .update(dataGeojson)
      .digest('hex');
    let pmtilesChecksum: string | undefined;
    let fileToTransferPmtiles:
      { originalname: string; buffer: Buffer } | undefined;
    try {
      if (allZones.length === 0) {
        await generateEmptyPmtiles({
          workingDirectory: path,
          outputPath: `${path}/zones_arretes_en_vigueur.pmtiles`,
        });
      } else {
        await generatePmtiles({
          workingDirectory: path,
          inputPath: `${path}/zones_arretes_en_vigueur.geojson`,
          outputPath: `${path}/zones_arretes_en_vigueur.pmtiles`,
          expectedFeatureIds: expectedPmtilesFeatureIds,
        });
      }
      const data = fs.readFileSync(`${path}/zones_arretes_en_vigueur.pmtiles`);
      pmtilesChecksum = createHash('sha256').update(data).digest('hex');
      fileToTransferPmtiles = {
        originalname: 'zones_arretes_en_vigueur.pmtiles',
        buffer: data,
      };
    } catch (e) {
      this.logger.error('ERROR GENERATING PMTILES', e);
      throw e;
    }

    let immutableArtifacts: { geojsonUrl?: string; pmtilesUrl?: string } = {};
    if (publicationEnabled) {
      immutableArtifacts = await this.publishGeneratedZoneArtifacts({
        sourceRevision,
        geojsonFile: fileToTransferGeojson,
        geojsonChecksum,
        pmtilesFile: fileToTransferPmtiles,
        pmtilesChecksum,
      });
    }
    await this.zoneAlerteComputedRepository
      .createQueryBuilder()
      .update()
      .set({ enabled: true })
      .where('1 = 1')
      .execute();
    await this.computePublicationStatistics(
      allZonesComputed,
      date,
      Boolean(computeHistoric),
      publicationEnabled,
      isNationalCompute || !publicationEnabled ? sourceRevision : undefined,
      isNationalCompute || !publicationEnabled
        ? historicComputeEpoch
        : undefined,
      isNationalCompute,
    );
    if (!publicationEnabled) {
      const stableArtifacts = await this.publishLegacyZoneArtifacts({
        geojsonFile: fileToTransferGeojson,
        pmtilesFile: fileToTransferPmtiles,
      });
      await this.statisticCommuneService.finalizeLegacyCurrentPublication(
        date,
        sourceRevision!,
        historicComputeEpoch!,
      );
      await this.markLegacyComputationAvailable(new Date(), false);
      try {
        await this.publishLegacyZoneArtifactSideEffects({
          geojsonFile: fileToTransferGeojson,
          geojsonUrl: stableArtifacts.geojsonUrl,
          pmtilesFile: fileToTransferPmtiles!,
          pmtilesUrl: stableArtifacts.pmtilesUrl,
          date,
        });
      } catch (error) {
        this.logger.error(
          'ERROR PUBLISHING LEGACY ZONE ARTIFACT SIDE EFFECTS',
          error,
        );
      }
    }
    const publicationId = await this.buildVersionedPublicationIfNational({
      sourceRevision: isNationalCompute ? sourceRevision : undefined,
      sourceComputedAt: date,
      artifactZoneCount: allZones.length,
      geojsonUrl: immutableArtifacts.geojsonUrl,
      geojsonChecksum,
      pmtilesUrl: immutableArtifacts.pmtilesUrl,
      pmtilesChecksum,
    });
    return { publicationId, sourceRevision };
  }

  private async computePublicationStatistics(
    allZonesComputed: ZoneAlerteComputed[],
    date: Date,
    computeHistoric: boolean,
    publicationEnabled: boolean,
    sourceRevision?: string,
    historicComputeEpoch?: string,
    certifyCurrentPublication = true,
  ): Promise<void> {
    if (publicationEnabled && sourceRevision === undefined) {
      return;
    }
    const certifyCompleteCurrentSnapshot =
      certifyCurrentPublication || !publicationEnabled;
    await this.statisticCommuneService.computeCommuneStatisticsRestrictions(
      allZonesComputed,
      date,
      undefined,
      undefined,
      undefined,
      {
        beforeCommuneStatistics: () =>
          this.statisticDepartementService.computeDepartementStatisticsRestrictions(
            allZonesComputed,
            date,
          ),
        beforeCertification: async () => {
          await this.statisticCommuneService.computeCommuneStatisticsRestrictionsByMonth(
            date,
            undefined,
            true,
          );
          await this.statisticService.computeDepartementsSituation(
            allZonesComputed,
            date.toISOString().slice(0, 10),
          );
        },
        deferCertificationUntilPublication: true,
        sourceRevision,
        historicComputeEpoch,
        requireNationalCoverage:
          certifyCompleteCurrentSnapshot &&
          sourceRevision !== undefined &&
          historicComputeEpoch !== undefined,
        publishCurrentDate: false,
      },
    );
    if (computeHistoric && publicationEnabled) {
      const historicThrough = moment
        .utc(date.toISOString().slice(0, 10), 'YYYY-MM-DD')
        .subtract(1, 'day')
        .format('YYYY-MM-DD');
      await this.computeHistoric(true, historicThrough, sourceRevision);
    }
    if (computeHistoric && !publicationEnabled) {
      if (isStatisticCacheArtifactRequired()) {
        throw new Error(
          'Direct legacy historic computation is disabled while the statistic artifact boundary is required',
        );
      }
      void this.computeHistoric();
    }
  }

  private async publishGeneratedZoneArtifacts(input: {
    sourceRevision?: string;
    geojsonFile: { originalname: string; buffer: Buffer };
    geojsonChecksum: string;
    pmtilesFile?: { originalname: string; buffer: Buffer };
    pmtilesChecksum?: string;
  }): Promise<{ geojsonUrl?: string; pmtilesUrl?: string }> {
    if (!isZonePublicationEnabled() || input.sourceRevision === undefined) {
      return {};
    }
    if (!input.pmtilesFile || !input.pmtilesChecksum) {
      throw new Error('Versioned publication requires a PMTiles artifact');
    }

    const geojsonUrl = await this.uploadImmutableArtifact(
      input.geojsonFile,
      input.geojsonChecksum,
      'geojson',
    );
    const pmtilesUrl = await this.uploadImmutableArtifact(
      input.pmtilesFile,
      input.pmtilesChecksum,
      'pmtiles',
    );
    return { geojsonUrl, pmtilesUrl };
  }

  private async markLegacyComputationAvailable(
    date: Date,
    publicationEnabled = isZonePublicationEnabled(),
  ): Promise<void> {
    if (!publicationEnabled) {
      await this.configService.setConfig(null, null, date);
    }
  }

  private async publishLegacyZoneArtifacts(input: {
    geojsonFile: { originalname: string; buffer: Buffer };
    pmtilesFile?: { originalname: string; buffer: Buffer };
  }): Promise<{ geojsonUrl: string; pmtilesUrl: string }> {
    if (!input.pmtilesFile) {
      throw new Error('Legacy publication requires a PMTiles artifact');
    }
    const geojsonUrl = await this.uploadStableLegacyArtifact(
      input.geojsonFile,
      'geojson',
    );
    const pmtilesUrl = await this.uploadStableLegacyArtifact(
      input.pmtilesFile,
      'pmtiles',
    );
    return { geojsonUrl, pmtilesUrl };
  }

  private async uploadStableLegacyArtifact(
    file: { originalname: string; buffer: Buffer },
    kind: 'geojson' | 'pmtiles',
  ): Promise<string> {
    const timeoutMs = this.getZonePublicationS3TimeoutMs();
    const stableResponse = await this.s3Service.uploadFile(
      file as Express.Multer.File,
      `${kind}/`,
      {
        abortSignal: AbortSignal.timeout(timeoutMs),
        cacheControl: 'public, max-age=0, must-revalidate',
        contentType:
          kind === 'geojson'
            ? 'application/geo+json'
            : 'application/vnd.pmtiles',
      },
    );
    const stableUrl = stableResponse?.Location;
    if (!stableUrl) {
      throw new Error(`Stable ${kind} upload returned no URL`);
    }
    return stableUrl;
  }

  private async publishLegacyZoneArtifactSideEffects(input: {
    geojsonFile: { originalname: string; buffer: Buffer };
    geojsonUrl: string;
    pmtilesFile: { originalname: string; buffer: Buffer };
    pmtilesUrl: string;
    date: Date;
  }): Promise<void> {
    await this.publishLegacyArtifactSideEffects(
      input.geojsonFile,
      input.geojsonUrl,
      input.date,
      'geojson',
      'Carte des zones et arrêtés en vigueur - GeoJSON',
    );
    await this.publishLegacyArtifactSideEffects(
      input.pmtilesFile,
      input.pmtilesUrl,
      input.date,
      'pmtiles',
      'Carte des zones et arrêtés en vigueur - PMTILES',
    );
  }

  private async publishLegacyArtifactSideEffects(
    file: { originalname: string; buffer: Buffer },
    stableUrl: string,
    date: Date,
    kind: 'geojson' | 'pmtiles',
    dataGouvTitle: string,
  ): Promise<void> {
    let datedCopySucceeded = false;
    try {
      const datedFileName = `zones_arretes_en_vigueur_${date.toISOString().split('T')[0]}.${kind}`;
      await this.s3Service.copyFile(
        file.originalname,
        datedFileName,
        `${kind}/`,
        {
          abortSignal: AbortSignal.timeout(
            this.getZonePublicationS3TimeoutMs(),
          ),
          cacheControl: 'public, max-age=0, must-revalidate',
          contentType:
            kind === 'geojson'
              ? 'application/geo+json'
              : 'application/vnd.pmtiles',
        },
      );
      datedCopySucceeded = true;
    } catch (error) {
      this.logger.error(`ERROR COPYING ${kind.toUpperCase()}`, error);
    }

    if (kind === 'pmtiles' || datedCopySucceeded) {
      try {
        await this.datagouvService.uploadToDatagouv(
          kind,
          stableUrl,
          dataGouvTitle,
          true,
        );
      } catch (error) {
        this.logger.error(
          `ERROR UPLOADING ${kind.toUpperCase()} TO DATAGOUV`,
          error,
        );
      }
    }
  }

  private async uploadImmutableArtifact(
    file: { originalname: string; buffer: Buffer },
    checksum: string,
    kind: 'geojson' | 'pmtiles',
  ): Promise<string> {
    const timeoutMs = this.getZonePublicationS3TimeoutMs();
    const immutableResponse = await this.s3Service.uploadFile(
      {
        ...file,
        originalname: `zones_arretes_en_vigueur_${checksum}.${kind}`,
      } as Express.Multer.File,
      `${kind}/`,
      {
        abortSignal: AbortSignal.timeout(timeoutMs),
        cacheControl: 'public, max-age=31536000, immutable',
        contentType:
          kind === 'geojson'
            ? 'application/geo+json'
            : 'application/vnd.pmtiles',
      },
    );
    const immutableUrl = immutableResponse?.Location;
    if (!immutableUrl) {
      throw new Error(`Immutable ${kind} upload returned no URL`);
    }
    return immutableUrl;
  }

  private getZonePublicationS3TimeoutMs(): number {
    const configuredTimeoutMs = Number(
      this.nestConfigService.get?.('ZONE_PUBLICATION_S3_TIMEOUT_MS'),
    );
    return Number.isInteger(configuredTimeoutMs) && configuredTimeoutMs > 0
      ? configuredTimeoutMs
      : 60_000;
  }

  private async buildVersionedPublicationIfNational(input: {
    sourceRevision?: string;
    sourceComputedAt: Date;
    artifactZoneCount: number;
    geojsonUrl?: string;
    geojsonChecksum?: string;
    pmtilesUrl?: string;
    pmtilesChecksum?: string;
  }): Promise<string | undefined> {
    if (!isZonePublicationEnabled() || input.sourceRevision === undefined) {
      return;
    }
    return this.zonePublicationService.buildCandidateFromCurrentComputed({
      sourceRevision: input.sourceRevision,
      sourceComputedAt: input.sourceComputedAt,
      artifactZoneCount: input.artifactZoneCount,
      geojsonUrl: input.geojsonUrl,
      geojsonChecksum: input.geojsonChecksum,
      pmtilesUrl: input.pmtilesUrl,
      pmtilesChecksum: input.pmtilesChecksum,
    });
  }

  async computeCommunesIntersected(departement: Departement) {
    const zones = await this.zoneAlerteComputedRepository
      .createQueryBuilder('zone_alerte_computed')
      .select([
        'zone_alerte_computed.id',
        'zone_alerte_computed.idSandre',
        'zone_alerte_computed.nom',
        'zone_alerte_computed.code',
        'zone_alerte_computed.type',
      ])
      .leftJoin('zone_alerte_computed.departement', 'departement')
      // Au moins 1% de la surface en commun
      .leftJoinAndSelect(
        'commune',
        'commune',
        'commune.departement = departement.id AND ST_INTERSECTS(zone_alerte_computed.geom, commune.geom) AND ST_Area(ST_Intersection(zone_alerte_computed.geom, commune.geom)) / ST_AREA(commune.geom) > 0.001',
      )
      .where('departement.id = :id', { id: departement.id })
      .andWhere(
        `ST_GeometryType(zone_alerte_computed.geom) IN ('ST_Polygon', 'ST_MultiPolygon')`,
      )
      .andWhere('ST_IsValid(ST_TRANSFORM(zone_alerte_computed.geom, 4326))')
      .andWhere('ST_IsValid(ST_TRANSFORM(commune.geom, 4326))')
      .getRawMany();
    const toSave = [];
    zones.forEach((z) => {
      if (!toSave.some((s) => s.id === z.zone_alerte_computed_id)) {
        toSave.push({
          id: z.zone_alerte_computed_id,
          communes: [],
        });
      }
      const s = toSave.find((s) => s.id === z.zone_alerte_computed_id);
      if (z.commune_id) {
        s.communes.push({
          id: z.commune_id,
        });
      }
    });
    await this.zoneAlerteComputedRepository.save(toSave);
  }

  async computeHistoric(
    rethrowWorkerError = false,
    requiredThrough?: string,
    expectedSourceRevision?: string,
    assertBoundary?: HistoricBoundaryAssertion,
    expectedStatisticPublication?: HistoricStatisticPublicationTarget,
  ) {
    let historicSourceRevision: string | undefined;
    let historicDirtyFromForRetry: string | undefined;
    try {
      const publicationEnabled = isZonePublicationEnabled();
      historicSourceRevision =
        expectedSourceRevision ??
        (await this.zonePublicationService.getSourceRevision());
      const config = await this.configService.getConfig();
      if (!config) {
        throw new Error('Historic cursor configuration is missing');
      }
      const historicComputeEpoch = String(config.historicComputeEpoch ?? 0);
      let certifiedCursorState = this.toHistoricCursorState(config);
      const dirtyDates = [config.computeMapDate, config.computeStatsDate]
        .filter(Boolean)
        .map((date) => moment(date, 'YYYY-MM-DD'));
      const dirtyDate = dirtyDates.reduce((minDate, date) => {
        return date.isBefore(minDate, 'day') ? date : minDate;
      }, dirtyDates[0]);
      let historicPublicationStarted = false;
      let historicAlreadyPublished = false;
      let historicCompletedThrough: string | undefined;
      const dirtyThrough =
        requiredThrough ?? moment().subtract(1, 'day').format('YYYY-MM-DD');
      const dirtyThroughDate = moment(dirtyThrough, 'YYYY-MM-DD', true);
      if (!dirtyThroughDate.isValid()) {
        throw new Error(`Invalid historic catch-up date: ${dirtyThrough}`);
      }

      await assertBoundary?.();

      if (assertBoundary) {
        if (!requiredThrough || !expectedStatisticPublication) {
          throw new Error(
            'A guarded historic computation requires an exact statistic publication target',
          );
        }
        const prepared = await this.assertHistoricStatisticsPublicationPrepared(
          dirtyDate?.format('YYYY-MM-DD'),
          requiredThrough,
          expectedStatisticPublication,
        );
        historicPublicationStarted = prepared.status === 'prepared';
        historicAlreadyPublished = prepared.status === 'already-completed';
        historicDirtyFromForRetry = prepared.historicDirtyFrom ?? undefined;
      }

      if (historicAlreadyPublished) {
        await this.assertHistoricCatchUpComplete(
          requiredThrough!,
          historicSourceRevision,
        );
        await this.assertCurrentHistoricCursorState(
          certifiedCursorState,
          historicComputeEpoch,
        );
        return certifiedCursorState;
      }

      if (dirtyDate && !dirtyDate.isAfter(dirtyThroughDate, 'day')) {
        const computedStartDate = moment(
          this.historicComputedStartDate,
          'YYYY-MM-DD',
        );
        const dirtyDateString = dirtyDate.format('YYYY-MM-DD');
        const statisticsStartDate = config.computeStatsDate ?? dirtyDateString;
        historicDirtyFromForRetry = dirtyDateString;
        if (!assertBoundary) {
          await this.beginHistoricStatisticsPublication(
            dirtyDateString,
            dirtyThrough,
          );
          historicPublicationStarted = true;
        }

        if (dirtyDate.isBefore(computedStartDate, 'day')) {
          const naturalLegacyEnd = computedStartDate.clone().subtract(1, 'day');
          const legacyEnd = dirtyThroughDate.isBefore(naturalLegacyEnd, 'day')
            ? dirtyThroughDate.clone()
            : naturalLegacyEnd;
          const legacyState = await this.runHistoricWorkerInChunks(
            'maps',
            dirtyDateString,
            statisticsStartDate,
            config.computeMapDate,
            config.computeStatsDate,
            String(config.computeMapGeneration ?? 0),
            String(config.computeStatsGeneration ?? 0),
            legacyEnd.format('YYYY-MM-DD'),
            historicSourceRevision,
            historicComputeEpoch,
            assertBoundary,
          );
          historicCompletedThrough =
            this.getHistoricCompletedThrough(legacyState);
          certifiedCursorState = legacyState;

          if (!dirtyThroughDate.isBefore(computedStartDate, 'day')) {
            const resumedConfig = await this.configService.getConfig();
            this.assertHistoricCursorState(
              legacyState,
              resumedConfig,
              historicComputeEpoch,
            );
            const resumedDirtyDates = [
              resumedConfig.computeMapDate,
              resumedConfig.computeStatsDate,
            ]
              .filter(Boolean)
              .map((value) => moment(value, 'YYYY-MM-DD'));
            const resumedDirtyDate = resumedDirtyDates.reduce(
              (minimum, value) =>
                value.isBefore(minimum, 'day') ? value : minimum,
              resumedDirtyDates[0],
            );
            if (!resumedDirtyDate) {
              throw new Error(
                'Historic cursors disappeared during legacy computation',
              );
            }
            const legacyCompletedThrough = moment(computedStartDate).subtract(
              1,
              'day',
            );
            if (resumedDirtyDate.isBefore(legacyCompletedThrough, 'day')) {
              throw new Error(
                `Historic cursor rewound during legacy computation to ${resumedDirtyDate.format('YYYY-MM-DD')}`,
              );
            }
            const computedState = await this.runHistoricWorkerInChunks(
              'mapsComputed',
              this.historicComputedStartDate,
              resumedConfig.computeStatsDate,
              resumedConfig.computeMapDate,
              resumedConfig.computeStatsDate,
              String(resumedConfig.computeMapGeneration ?? 0),
              String(resumedConfig.computeStatsGeneration ?? 0),
              dirtyThrough,
              historicSourceRevision,
              historicComputeEpoch,
              assertBoundary,
            );
            historicCompletedThrough =
              this.getHistoricCompletedThrough(computedState);
            certifiedCursorState = computedState;
          }
        } else {
          const computedState = await this.runHistoricWorkerInChunks(
            'mapsComputed',
            dirtyDateString,
            statisticsStartDate,
            config.computeMapDate,
            config.computeStatsDate,
            String(config.computeMapGeneration ?? 0),
            String(config.computeStatsGeneration ?? 0),
            dirtyThrough,
            historicSourceRevision,
            historicComputeEpoch,
            assertBoundary,
          );
          historicCompletedThrough =
            this.getHistoricCompletedThrough(computedState);
          certifiedCursorState = computedState;
        }
      }
      const statsMonthDate =
        config.computeStatsDate || dirtyDate?.format('YYYY-MM-DD');
      const historicComputedThrough =
        requiredThrough ?? historicCompletedThrough;
      const candidateSnapshotDate =
        requiredThrough && expectedSourceRevision !== undefined
          ? moment
              .utc(requiredThrough, 'YYYY-MM-DD')
              .add(1, 'day')
              .format('YYYY-MM-DD')
          : undefined;
      const monthlyAggregateThrough = publicationEnabled
        ? (candidateSnapshotDate ?? historicComputedThrough)
        : undefined;
      if (statsMonthDate) {
        await assertBoundary?.();
        await this.statisticCommuneService.computeByMonth(
          moment(statsMonthDate, 'YYYY-MM-DD'),
          undefined,
          monthlyAggregateThrough
            ? {
                aggregateThrough: moment(monthlyAggregateThrough, 'YYYY-MM-DD'),
                allowedReadySnapshot:
                  candidateSnapshotDate && expectedSourceRevision !== undefined
                    ? {
                        date: candidateSnapshotDate,
                        sourceRevision: expectedSourceRevision,
                      }
                    : undefined,
              }
            : undefined,
        );
      }
      if (requiredThrough) {
        await this.assertHistoricCatchUpComplete(
          requiredThrough,
          historicSourceRevision,
          historicDirtyFromForRetry,
        );
      }
      if (historicPublicationStarted) {
        const publishedThrough = historicComputedThrough;
        if (!publishedThrough) {
          throw new Error(
            'Historic statistics publication has no completed cursor',
          );
        }
        await assertBoundary?.();
        await this.publishHistoricStatistics(
          publishedThrough,
          historicSourceRevision,
          expectedStatisticPublication,
          certifiedCursorState,
          historicComputeEpoch,
        );
      }
      await this.assertCurrentHistoricCursorState(
        certifiedCursorState,
        historicComputeEpoch,
      );
      return certifiedCursorState;
    } catch (error) {
      this.logger.error('Error in computeHistoric', error.toString());
      await this.rewindHistoricAfterSourceRevisionChange(
        historicDirtyFromForRetry,
        historicSourceRevision,
      );
      if (rethrowWorkerError) {
        throw error;
      }
    }
  }

  async prepareHistoricStatisticsPublication(
    requiredThrough: string,
    expectedSourceRevision: string,
  ): Promise<HistoricStatisticPreparation> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requiredThrough)) {
      throw new Error(`Invalid historic catch-up date: ${requiredThrough}`);
    }
    const expectedCurrentPublishedDate = moment
      .utc(requiredThrough, 'YYYY-MM-DD', true)
      .add(1, 'day')
      .format('YYYY-MM-DD');
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    let locked = false;
    let primaryError: unknown = null;
    const deadline = Date.now() + HISTORIC_COMPUTE_LOCK_TIMEOUT_MS;
    try {
      while (!locked) {
        const [lock] = await queryRunner.query(
          "SELECT pg_try_advisory_lock(hashtext('vigieau'), hashtext('zone-compute-historic')) AS locked",
        );
        locked = lock?.locked === true;
        if (!locked) {
          if (Date.now() >= deadline) {
            throw new Error(
              'Timed out waiting to prepare the historic zone compute boundary',
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      await queryRunner.startTransaction('SERIALIZABLE');
      const [source] = await queryRunner.query(`
        SELECT "revision"::text AS "revision"
        FROM "zone_publication_source_state"
        WHERE "id" = 1
        FOR UPDATE
      `);
      if (String(source?.revision ?? 'missing') !== expectedSourceRevision) {
        throw new Error(
          `Historic source revision changed (${expectedSourceRevision} -> ${String(source?.revision ?? 'missing')})`,
        );
      }
      const [config] = await queryRunner.query(`
        SELECT
          "computeMapDate"::text AS "computeMapDate",
          "computeStatsDate"::text AS "computeStatsDate",
          "historicComputeEpoch"::text AS "historicComputeEpoch"
        FROM "config"
        WHERE "id" = 1
        FOR UPDATE
      `);
      if (!config) {
        throw new Error('Historic cursor configuration is missing');
      }
      const [state] = await queryRunner.query(`
        SELECT
          "revision"::text AS "revision",
          "currentPublishedDate"::text AS "currentPublishedDate",
          "historicPublishedThrough"::text AS "historicPublishedThrough",
          "historicDirtyFrom"::text AS "historicDirtyFrom",
          "historicDirtyThrough"::text AS "historicDirtyThrough"
        FROM "statistic_publication_state"
        WHERE "id" = 1
        FOR UPDATE
      `);
      if (!state) {
        throw new Error('Statistic publication state is unavailable');
      }
      if (state.currentPublishedDate !== expectedCurrentPublishedDate) {
        throw new Error(
          `Historic boundary requires current statistic date ${expectedCurrentPublishedDate}, got ${state.currentPublishedDate ?? 'missing'}`,
        );
      }
      const [incompleteSnapshot] = await queryRunner.query(
        `
          SELECT snapshot."snapshotDate"::text AS "snapshotDate"
          FROM "statistic_commune_snapshot" snapshot
          WHERE snapshot."scope" <> 'bootstrap'
            AND (
              snapshot."status" <> 'completed'
              OR snapshot."processedCommuneCount" <>
                 snapshot."expectedCommuneCount"
            )
            AND snapshot."snapshotDate" <= $1::date
          ORDER BY snapshot."snapshotDate" ASC
          LIMIT 1
          FOR UPDATE OF snapshot
        `,
        [requiredThrough],
      );
      const [activeArtifact] = await queryRunner.query(`
        SELECT
          publication."statisticRevision"::text AS "statisticRevision",
          publication."mode",
          publication."currentPublishedDate"::text
            AS "currentPublishedDate",
          publication."historicDirtyFrom"::text AS "historicDirtyFrom",
          publication."historicDirtyThrough"::text AS "historicDirtyThrough",
          publication."historicMapCursor"::text AS "historicMapCursor",
          publication."historicStatsCursor"::text AS "historicStatsCursor",
          publication."sourceRevision"::text AS "sourceRevision",
          publication."historicComputeEpoch"::text
            AS "historicComputeEpoch",
          cache_state."historicRecoveryMonthlyFrom"::text
            AS "historicRecoveryMonthlyFrom"
        FROM "statistic_cache_state" cache_state
        JOIN "statistic_cache_publication" publication
          ON publication."id" = cache_state."activePublicationId"
        WHERE cache_state."id" = 1
          AND publication."status" = 'active'
        FOR SHARE OF cache_state, publication
      `);
      if (incompleteSnapshot?.snapshotDate) {
        await queryRunner.query(
          `
            UPDATE "statistic_cache_state"
            SET "historicRecoveryMonthlyFrom" = CASE
                  WHEN "historicRecoveryMonthlyFrom" IS NULL THEN $1::date
                  ELSE LEAST("historicRecoveryMonthlyFrom", $1::date)
                END,
                "updatedAt" = now()
            WHERE "id" = 1
          `,
          [String(incompleteSnapshot.snapshotDate).slice(0, 10)],
        );
      }
      const cursorValues = [config.computeMapDate, config.computeStatsDate]
        .filter((value): value is string => Boolean(value))
        .map((value) => String(value).slice(0, 10));
      const cursorCoverageComplete =
        cursorValues.length === 2 &&
        cursorValues.every((value) => value >= requiredThrough);
      const artifactBoundaryMatches = Boolean(
        activeArtifact?.mode === 'legacy-bootstrap' &&
        activeArtifact.currentPublishedDate === expectedCurrentPublishedDate &&
        String(activeArtifact.sourceRevision ?? '') ===
          expectedSourceRevision &&
        String(activeArtifact.historicComputeEpoch ?? '') ===
          String(config.historicComputeEpoch ?? ''),
      );
      const alreadyCompleted = Boolean(
        !state.historicDirtyFrom &&
        !state.historicDirtyThrough &&
        !incompleteSnapshot &&
        !activeArtifact?.historicRecoveryMonthlyFrom &&
        state.historicPublishedThrough >= requiredThrough &&
        cursorCoverageComplete &&
        artifactBoundaryMatches,
      );
      if (alreadyCompleted) {
        await queryRunner.commitTransaction();
        return {
          status: 'already-completed',
          statisticRevision: String(state.revision),
          currentPublishedDate: state.currentPublishedDate,
          historicDirtyFrom: null,
          historicDirtyThrough: null,
        };
      }

      const dirtyDates = cursorValues.map((date) =>
        moment.utc(date, 'YYYY-MM-DD', true),
      );
      const dirtyDate = dirtyDates.reduce(
        (minimum, date) => (date.isBefore(minimum, 'day') ? date : minimum),
        dirtyDates[0],
      );
      const existingDirtyFrom = state.historicDirtyFrom
        ? String(state.historicDirtyFrom).slice(0, 10)
        : null;
      const cursorDirtyFrom =
        dirtyDate && !dirtyDate.isAfter(requiredThrough, 'day')
          ? dirtyDate.format('YYYY-MM-DD')
          : requiredThrough;
      const proposedDirtyFrom = [
        existingDirtyFrom,
        cursorDirtyFrom,
        incompleteSnapshot?.snapshotDate
          ? String(incompleteSnapshot.snapshotDate).slice(0, 10)
          : null,
        activeArtifact?.historicRecoveryMonthlyFrom
          ? String(activeArtifact.historicRecoveryMonthlyFrom).slice(0, 10)
          : null,
      ]
        .filter((value): value is string => Boolean(value))
        .sort()[0];
      const proposedDirtyThrough = state.historicDirtyThrough
        ? String(state.historicDirtyThrough).slice(0, 10) > requiredThrough
          ? String(state.historicDirtyThrough).slice(0, 10)
          : requiredThrough
        : requiredThrough;
      const activeArtifactPreparedBoundaryMatches = Boolean(
        activeArtifact?.mode === 'legacy-bootstrap' &&
        activeArtifact.currentPublishedDate === expectedCurrentPublishedDate &&
        activeArtifact.historicDirtyFrom === proposedDirtyFrom &&
        activeArtifact.historicDirtyThrough === proposedDirtyThrough &&
        String(activeArtifact.sourceRevision ?? '') ===
          expectedSourceRevision &&
        String(activeArtifact.historicComputeEpoch ?? '') ===
          String(config.historicComputeEpoch ?? ''),
      );
      const forceRevisionBump = Boolean(
        activeArtifact &&
        String(activeArtifact.statisticRevision ?? '') ===
          String(state.revision) &&
        !activeArtifactPreparedBoundaryMatches,
      );
      const [prepared] = await this.beginHistoricStatisticsPublication(
        proposedDirtyFrom,
        requiredThrough,
        queryRunner,
        forceRevisionBump,
      );
      await queryRunner.commitTransaction();
      return {
        status: 'prepared',
        statisticRevision: String(prepared.revision),
        currentPublishedDate: String(prepared.currentPublishedDate).slice(
          0,
          10,
        ),
        historicDirtyFrom: String(prepared.historicDirtyFrom).slice(0, 10),
        historicDirtyThrough: String(prepared.historicDirtyThrough).slice(
          0,
          10,
        ),
      };
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await this.cleanupHistoricLockSession(
        queryRunner,
        locked,
        queryRunner.isTransactionActive,
        primaryError,
      );
    }
  }

  async recoverIncompleteHistoricSnapshots(
    requiredThrough: string,
    expectedSourceRevision: string,
  ): Promise<string[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requiredThrough)) {
      throw new Error(`Invalid historic recovery date: ${requiredThrough}`);
    }
    const expectedCurrentPublishedDate = moment
      .utc(requiredThrough, 'YYYY-MM-DD', true)
      .add(1, 'day')
      .format('YYYY-MM-DD');
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    let locked = false;
    let primaryError: unknown = null;
    const deadline = Date.now() + HISTORIC_COMPUTE_LOCK_TIMEOUT_MS;
    const recoveredDates: string[] = [];
    let recoveryEpoch: string | null = null;
    try {
      while (!locked) {
        const [lock] = await queryRunner.query(
          "SELECT pg_try_advisory_lock(hashtext('vigieau'), hashtext('zone-compute-historic')) AS locked",
        );
        locked = lock?.locked === true;
        if (!locked) {
          if (Date.now() >= deadline) {
            throw new Error(
              'Timed out waiting to recover incomplete historic snapshots',
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      while (true) {
        const [context] = await queryRunner.query(
          `
            SELECT
              source_state."revision"::text AS "sourceRevision",
              config."computeMapDate"::text AS "mapCursor",
              config."computeStatsDate"::text AS "statsCursor",
              config."computeMapGeneration"::text AS "mapGeneration",
              config."computeStatsGeneration"::text AS "statsGeneration",
              config."historicComputeEpoch"::text AS "historicComputeEpoch",
              publication_state."currentPublishedDate"::text
                AS "currentPublishedDate",
              publication_state."historicDirtyFrom"::text
                AS "historicDirtyFrom",
              publication_state."historicDirtyThrough"::text
                AS "historicDirtyThrough",
              cache_state."historicRecoveryMonthlyFrom"::text
                AS "historicRecoveryMonthlyFrom",
              incomplete."snapshotDate"::text AS "incompleteSnapshotDate",
              incomplete."scope" AS "incompleteSnapshotScope"
            FROM "zone_publication_source_state" source_state
            CROSS JOIN "config" config
            CROSS JOIN "statistic_publication_state" publication_state
            CROSS JOIN "statistic_cache_state" cache_state
            LEFT JOIN LATERAL (
              SELECT snapshot."snapshotDate", snapshot."scope"
              FROM "statistic_commune_snapshot" snapshot
              WHERE snapshot."scope" <> 'bootstrap'
                AND (
                  snapshot."status" <> 'completed'
                  OR snapshot."processedCommuneCount" <>
                     snapshot."expectedCommuneCount"
                )
                AND snapshot."snapshotDate" <= $1::date
              ORDER BY snapshot."snapshotDate" DESC
              LIMIT 1
            ) incomplete ON true
            WHERE source_state."id" = 1
              AND config."id" = 1
              AND publication_state."id" = 1
              AND cache_state."id" = 1
          `,
          [requiredThrough],
        );
        if (!context) {
          throw new Error('Historic recovery context is unavailable');
        }
        if (String(context.sourceRevision) !== expectedSourceRevision) {
          throw new Error(
            `Historic source revision changed (${expectedSourceRevision} -> ${String(context.sourceRevision ?? 'missing')})`,
          );
        }
        if (context.currentPublishedDate !== expectedCurrentPublishedDate) {
          throw new Error(
            `Historic recovery requires current statistic date ${expectedCurrentPublishedDate}, got ${String(context.currentPublishedDate ?? 'missing')}`,
          );
        }
        const snapshotDate = context.incompleteSnapshotDate
          ? String(context.incompleteSnapshotDate).slice(0, 10)
          : null;
        const currentEpoch = String(context.historicComputeEpoch ?? '0');
        if (recoveryEpoch !== null && currentEpoch !== recoveryEpoch) {
          throw new Error(
            `Historic recovery epoch changed (${recoveryEpoch} -> ${currentEpoch})`,
          );
        }
        recoveryEpoch = currentEpoch;
        if (!snapshotDate) {
          const monthlyFrom = context.historicRecoveryMonthlyFrom
            ? String(context.historicRecoveryMonthlyFrom).slice(0, 10)
            : null;
          if (monthlyFrom) {
            await this.statisticCommuneService.computeByMonth(
              moment.utc(monthlyFrom, 'YYYY-MM-DD', true),
            );
            const [cleared] = await queryRunner.query(
              `
                WITH source_guard AS MATERIALIZED (
                  SELECT "revision"::text AS "sourceRevision"
                  FROM "zone_publication_source_state"
                  WHERE "id" = 1
                ), config_guard AS MATERIALIZED (
                  SELECT "historicComputeEpoch"::text
                    AS "historicComputeEpoch"
                  FROM "config"
                  CROSS JOIN source_guard
                  WHERE "id" = 1
                ), cleared AS (
                  UPDATE "statistic_cache_state" cache_state
                  SET "historicRecoveryMonthlyFrom" = NULL,
                      "updatedAt" = now()
                  FROM source_guard, config_guard
                  WHERE cache_state."id" = 1
                    AND cache_state."historicRecoveryMonthlyFrom" = $1::date
                    AND source_guard."sourceRevision" = $2::text
                    AND config_guard."historicComputeEpoch" = $3::text
                    AND NOT EXISTS (
                      SELECT 1
                      FROM "statistic_commune_snapshot" snapshot
                      WHERE snapshot."scope" <> 'bootstrap'
                        AND (
                          snapshot."status" <> 'completed'
                          OR snapshot."processedCommuneCount" <>
                             snapshot."expectedCommuneCount"
                        )
                        AND snapshot."snapshotDate" <= $4::date
                    )
                  RETURNING 1
                )
                SELECT EXISTS(SELECT 1 FROM cleared) AS cleared
              `,
              [
                monthlyFrom,
                expectedSourceRevision,
                recoveryEpoch,
                requiredThrough,
              ],
            );
            if (cleared?.cleared !== true) {
              throw new Error(
                `Historic monthly recovery ${monthlyFrom} could not be certified`,
              );
            }
          }
          break;
        }
        const dirtyFrom = context.historicDirtyFrom
          ? String(context.historicDirtyFrom).slice(0, 10)
          : null;
        const dirtyThrough = context.historicDirtyThrough
          ? String(context.historicDirtyThrough).slice(0, 10)
          : null;
        if (
          !dirtyFrom ||
          !dirtyThrough ||
          snapshotDate < dirtyFrom ||
          snapshotDate > dirtyThrough
        ) {
          throw new Error(
            `Incomplete historic snapshot ${snapshotDate} is outside the prepared dirty range ${dirtyFrom ?? 'null'}..${dirtyThrough ?? 'null'}`,
          );
        }
        if (recoveredDates.includes(snapshotDate)) {
          throw new Error(
            `Historic snapshot ${snapshotDate} remained incomplete after recovery`,
          );
        }
        await queryRunner.query(
          `
            UPDATE "statistic_cache_state"
            SET "historicRecoveryMonthlyFrom" = CASE
                  WHEN "historicRecoveryMonthlyFrom" IS NULL THEN $1::date
                  ELSE LEAST("historicRecoveryMonthlyFrom", $1::date)
                END,
                "updatedAt" = now()
            WHERE "id" = 1
          `,
          [snapshotDate],
        );
        const mapCursor = context.mapCursor
          ? String(context.mapCursor).slice(0, 10)
          : null;
        const statsCursor = context.statsCursor
          ? String(context.statsCursor).slice(0, 10)
          : null;
        const predecessor = moment
          .utc(snapshotDate, 'YYYY-MM-DD', true)
          .subtract(1, 'day')
          .format('YYYY-MM-DD');
        if (
          (mapCursor && mapCursor < predecessor) ||
          (statsCursor && statsCursor < predecessor)
        ) {
          throw new Error(
            `Historic snapshot ${snapshotDate} cannot be recovered without opening unstarted dates (map=${mapCursor ?? 'null'}, stats=${statsCursor ?? 'null'})`,
          );
        }
        if (
          (mapCursor && mapCursor > snapshotDate) ||
          (statsCursor && statsCursor > snapshotDate)
        ) {
          await this.configService.setConfig(snapshotDate, snapshotDate);
          recoveryEpoch = null;
          continue;
        }
        const recovered = await this.runHistoricWorker(
          snapshotDate < this.historicComputedStartDate
            ? 'maps'
            : 'mapsComputed',
          snapshotDate,
          snapshotDate,
          mapCursor,
          statsCursor,
          String(context.mapGeneration ?? '0'),
          String(context.statsGeneration ?? '0'),
          expectedSourceRevision,
          snapshotDate,
          currentEpoch,
        );
        await this.assertCurrentHistoricCursorState(recovered, currentEpoch);
        const [reconciled] = await queryRunner.query(
          `
            WITH certified_national AS MATERIALIZED (
              SELECT 1
              FROM "statistic_commune_snapshot" national
              WHERE national."snapshotDate" = $1::date
                AND national."scope" = 'national'
                AND national."status" = 'completed'
                AND national."processedCommuneCount" =
                    national."expectedCommuneCount"
                AND national."sourceRevision" = $2::bigint
            ), reconciled AS (
              UPDATE "statistic_commune_snapshot" snapshot
              SET "status" = 'completed',
                  "processedCommuneCount" = snapshot."expectedCommuneCount",
                  "sourceRevision" = $2::bigint,
                  "completedAt" = COALESCE(snapshot."completedAt", now()),
                  "lastError" = NULL,
                  "updatedAt" = now()
              FROM certified_national
              WHERE snapshot."snapshotDate" = $1::date
                AND snapshot."scope" NOT IN ('national', 'bootstrap')
                AND (
                  snapshot."status" <> 'completed'
                  OR snapshot."processedCommuneCount" <>
                     snapshot."expectedCommuneCount"
                  OR snapshot."sourceRevision" IS DISTINCT FROM $2::bigint
                )
              RETURNING 1
            )
            SELECT
              EXISTS(SELECT 1 FROM certified_national) AS "certified",
              COUNT(*)::integer AS "reconciledCount"
            FROM reconciled
          `,
          [snapshotDate, expectedSourceRevision],
        );
        if (reconciled?.certified !== true) {
          throw new Error(
            `Historic snapshot ${snapshotDate} was not nationally certified after recovery`,
          );
        }
        recoveredDates.push(snapshotDate);
      }
      return recoveredDates;
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await this.cleanupHistoricLockSession(
        queryRunner,
        locked,
        false,
        primaryError,
      );
    }
  }

  private async beginHistoricStatisticsPublication(
    dirtyFrom: string,
    dirtyThrough: string,
    queryable: Pick<DataSource, 'query'> = this.dataSource,
    forceRevisionBump = false,
  ): Promise<any[]> {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(dirtyFrom) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(dirtyThrough) ||
      dirtyFrom > dirtyThrough
    ) {
      throw new Error(
        `Invalid historic statistics dirty range: ${dirtyFrom}..${dirtyThrough}`,
      );
    }
    return queryable.query(
      `
        INSERT INTO "statistic_publication_state" (
          "id", "revision", "historicDirtyFrom", "historicDirtyThrough",
          "updatedAt"
        ) VALUES (1, 1, $1::date, $2::date, now())
        ON CONFLICT ("id") DO UPDATE SET
          "revision" = "statistic_publication_state"."revision" + CASE
            WHEN $3::boolean
              OR "statistic_publication_state"."historicDirtyFrom"
                  IS DISTINCT FROM CASE
                    WHEN "statistic_publication_state"."historicDirtyFrom" IS NULL
                      THEN EXCLUDED."historicDirtyFrom"
                    ELSE LEAST(
                      "statistic_publication_state"."historicDirtyFrom",
                      EXCLUDED."historicDirtyFrom"
                    )
                  END
              OR "statistic_publication_state"."historicDirtyThrough"
                  IS DISTINCT FROM CASE
                    WHEN "statistic_publication_state"."historicDirtyThrough" IS NULL
                      THEN EXCLUDED."historicDirtyThrough"
                    ELSE GREATEST(
                      "statistic_publication_state"."historicDirtyThrough",
                      EXCLUDED."historicDirtyThrough"
                    )
                  END
              THEN 1
            ELSE 0
          END,
          "historicDirtyFrom" = CASE
            WHEN "statistic_publication_state"."historicDirtyFrom" IS NULL
              THEN EXCLUDED."historicDirtyFrom"
            ELSE LEAST(
              "statistic_publication_state"."historicDirtyFrom",
              EXCLUDED."historicDirtyFrom"
            )
          END,
          "historicDirtyThrough" = CASE
            WHEN "statistic_publication_state"."historicDirtyThrough" IS NULL
              THEN EXCLUDED."historicDirtyThrough"
            ELSE GREATEST(
              "statistic_publication_state"."historicDirtyThrough",
              EXCLUDED."historicDirtyThrough"
            )
          END,
          "updatedAt" = now()
        RETURNING
          "revision"::text AS "revision",
          "currentPublishedDate"::text AS "currentPublishedDate",
          "historicDirtyFrom"::text AS "historicDirtyFrom",
          "historicDirtyThrough"::text AS "historicDirtyThrough"
      `,
      [dirtyFrom, dirtyThrough, forceRevisionBump],
    );
  }

  private async assertHistoricStatisticsPublicationPrepared(
    dirtyFrom: string | undefined,
    dirtyThrough: string,
    expected: HistoricStatisticPublicationTarget,
  ): Promise<HistoricStatisticPreparation> {
    const [state] = await this.dataSource.query(
      `
        SELECT
          "revision"::text AS "revision",
          "currentPublishedDate"::text AS "currentPublishedDate",
          "historicPublishedThrough"::text AS "historicPublishedThrough",
          "historicDirtyFrom"::text AS "historicDirtyFrom",
          "historicDirtyThrough"::text AS "historicDirtyThrough"
        FROM "statistic_publication_state"
        WHERE "id" = 1
          AND "revision" = $1::bigint
          AND "currentPublishedDate" = $2::date
      `,
      [expected.statisticRevision, expected.currentPublishedDate],
    );
    if (!state) {
      throw new Error(
        `Historic statistics publication identity changed before ${dirtyThrough}`,
      );
    }
    const alreadyCompleted = Boolean(
      !state.historicDirtyFrom &&
      !state.historicDirtyThrough &&
      state.historicPublishedThrough >= dirtyThrough,
    );
    if (alreadyCompleted) {
      return {
        status: 'already-completed',
        statisticRevision: String(state.revision),
        currentPublishedDate: String(state.currentPublishedDate).slice(0, 10),
        historicDirtyFrom: null,
        historicDirtyThrough: null,
      };
    }
    const prepared = Boolean(
      state.historicDirtyFrom &&
      state.historicDirtyThrough &&
      (!dirtyFrom || state.historicDirtyFrom <= dirtyFrom) &&
      state.historicDirtyThrough >= dirtyThrough,
    );
    if (!prepared) {
      throw new Error(
        `Historic statistics publication was not prepared for ${dirtyFrom ?? 'completed cursors'}..${dirtyThrough}`,
      );
    }
    return {
      status: 'prepared',
      statisticRevision: String(state.revision),
      currentPublishedDate: String(state.currentPublishedDate).slice(0, 10),
      historicDirtyFrom: String(state.historicDirtyFrom).slice(0, 10),
      historicDirtyThrough: String(state.historicDirtyThrough).slice(0, 10),
    };
  }

  private async publishHistoricStatistics(
    publishedThrough: string,
    expectedSourceRevision?: string,
    expectedStatisticPublication?: HistoricStatisticPublicationTarget,
    expectedCursorState?: HistoricCursorState,
    expectedHistoricComputeEpoch?: string,
  ): Promise<void> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(publishedThrough)) {
      throw new Error(
        `Invalid historic statistics publication date: ${publishedThrough}`,
      );
    }
    const [result] = await this.dataSource.query(
      `
        WITH source_guard AS MATERIALIZED (
          SELECT source_state."revision"::text AS revision
          FROM "zone_publication_source_state" source_state
          WHERE source_state."id" = 1
          FOR UPDATE
        ), config_guard AS MATERIALIZED (
          SELECT
            config."computeMapDate"::text AS "mapCursor",
            config."computeStatsDate"::text AS "statsCursor",
            config."computeMapGeneration"::text AS "mapGeneration",
            config."computeStatsGeneration"::text AS "statsGeneration",
            config."historicComputeEpoch"::text AS "historicComputeEpoch"
          FROM "config" config
          CROSS JOIN source_guard
          WHERE config."id" = 1
          FOR UPDATE OF config
        ), publication_guard AS MATERIALIZED (
          SELECT
            state."id",
            state."revision"::text AS "revision",
            state."currentPublishedDate"::text AS "currentPublishedDate",
            state."historicDirtyFrom",
            state."historicDirtyThrough"
          FROM "statistic_publication_state" state
          CROSS JOIN config_guard
          WHERE state."id" = 1
          FOR UPDATE OF state
        ), incomplete_snapshot AS MATERIALIZED (
          SELECT snapshot."snapshotDate"
          FROM "statistic_commune_snapshot" snapshot
          CROSS JOIN publication_guard publication_state
          WHERE snapshot."scope" <> 'bootstrap'
            AND (
              snapshot."status" <> 'completed'
              OR snapshot."processedCommuneCount" <>
                 snapshot."expectedCommuneCount"
              OR (
                $2::bigint IS NOT NULL
                AND snapshot."scope" = 'national'
                AND snapshot."sourceRevision" IS DISTINCT FROM $2::bigint
              )
            )
            AND snapshot."snapshotDate" >= publication_state."historicDirtyFrom"
            AND snapshot."snapshotDate" <= $1::date
          ORDER BY snapshot."snapshotDate" ASC
          LIMIT 1
        ), published AS (
          UPDATE "statistic_publication_state" state
          SET "revision" = state."revision" + 1,
              "historicPublishedThrough" = CASE
                WHEN state."historicPublishedThrough" IS NULL THEN $1::date
                ELSE GREATEST(state."historicPublishedThrough", $1::date)
              END,
              "historicDirtyFrom" = NULL,
              "historicDirtyThrough" = NULL,
              "updatedAt" = now()
          FROM publication_guard publication_state
          WHERE state."id" = publication_state."id"
            AND publication_state."historicDirtyFrom" IS NOT NULL
            AND publication_state."historicDirtyThrough" IS NOT NULL
            AND (
              $3::bigint IS NULL
              OR publication_state."revision" = $3::bigint
            )
            AND (
              $4::date IS NULL
              OR publication_state."currentPublishedDate" = $4::date
            )
            AND EXISTS (
              SELECT 1
              FROM config_guard config
              WHERE config."mapCursor"::date >= $1::date
                AND config."statsCursor"::date >= $1::date
                AND (
                  $5::bigint IS NULL
                  OR config."historicComputeEpoch" = $5::text
                )
                AND (
                  $6::date IS NULL
                  OR config."mapCursor"::date = $6::date
                )
                AND (
                  $7::date IS NULL
                  OR config."statsCursor"::date = $7::date
                )
                AND (
                  $8::bigint IS NULL
                  OR config."mapGeneration" = $8::text
                )
                AND (
                  $9::bigint IS NULL
                  OR config."statsGeneration" = $9::text
                )
            )
            AND $1::date >= publication_state."historicDirtyThrough"
            AND (
              $2::bigint IS NULL
              OR EXISTS (
                SELECT 1
                FROM source_guard
                WHERE source_guard.revision = $2::text
              )
            )
            AND NOT EXISTS (SELECT 1 FROM incomplete_snapshot)
          RETURNING state."revision"
        )
        SELECT
          EXISTS(SELECT 1 FROM published) AS published,
          (SELECT "snapshotDate" FROM incomplete_snapshot) AS "incompleteDate",
          (SELECT revision FROM source_guard) AS "currentSourceRevision",
          (SELECT revision FROM publication_guard)
            AS "currentStatisticRevision",
          (SELECT "currentPublishedDate" FROM publication_guard)
            AS "currentStatisticPublishedDate",
          (SELECT row_to_json(config_guard) FROM config_guard)
            AS "currentCursorState"
      `,
      [
        publishedThrough,
        expectedSourceRevision ?? null,
        expectedStatisticPublication?.statisticRevision ?? null,
        expectedStatisticPublication?.currentPublishedDate ?? null,
        expectedHistoricComputeEpoch ?? null,
        expectedCursorState?.mapCursor ?? null,
        expectedCursorState?.statsCursor ?? null,
        expectedCursorState?.mapGeneration ?? null,
        expectedCursorState?.statsGeneration ?? null,
      ],
    );
    if (result?.published !== true) {
      if (
        expectedSourceRevision !== undefined &&
        String(result?.currentSourceRevision) !== expectedSourceRevision
      ) {
        throw new Error(
          `Historic statistics source revision changed (${expectedSourceRevision} -> ${String(result?.currentSourceRevision ?? 'missing')})`,
        );
      }
      if (
        expectedStatisticPublication &&
        (String(result?.currentStatisticRevision ?? 'missing') !==
          expectedStatisticPublication.statisticRevision ||
          String(result?.currentStatisticPublishedDate ?? '').slice(0, 10) !==
            expectedStatisticPublication.currentPublishedDate)
      ) {
        throw new Error(
          `Historic statistic publication changed (${expectedStatisticPublication.statisticRevision}/${expectedStatisticPublication.currentPublishedDate} -> ${String(result?.currentStatisticRevision ?? 'missing')}/${String(result?.currentStatisticPublishedDate ?? 'missing').slice(0, 10)})`,
        );
      }
      if (result?.incompleteDate) {
        const incompleteDate = String(result.incompleteDate).slice(0, 10);
        throw new Error(
          `Historic statistics publication blocked by snapshot ${incompleteDate}`,
        );
      }
      const currentCursorState = result?.currentCursorState ?? {};
      const cursorStateChanged = Boolean(
        (expectedHistoricComputeEpoch !== undefined &&
          String(currentCursorState.historicComputeEpoch ?? '') !==
            expectedHistoricComputeEpoch) ||
        (expectedCursorState &&
          (String(currentCursorState.mapCursor ?? '').slice(0, 10) !==
            expectedCursorState.mapCursor ||
            String(currentCursorState.statsCursor ?? '').slice(0, 10) !==
              expectedCursorState.statsCursor ||
            String(currentCursorState.mapGeneration ?? '') !==
              expectedCursorState.mapGeneration ||
            String(currentCursorState.statsGeneration ?? '') !==
              expectedCursorState.statsGeneration)),
      );
      if (cursorStateChanged) {
        throw new Error(
          `Historic cursor publication changed before finalization (${JSON.stringify(currentCursorState)})`,
        );
      }
      throw new Error(
        'Historic statistics publication preconditions changed before finalization',
      );
    }
  }

  async computeHistoricPersistently(
    requiredThrough: string,
    expectedSourceRevision?: string,
    assertBoundary?: HistoricBoundaryAssertion,
    expectedStatisticPublication?: HistoricStatisticPublicationTarget,
  ): Promise<HistoricCursorState> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    let locked = false;
    let primaryError: unknown = null;
    const deadline = Date.now() + HISTORIC_COMPUTE_LOCK_TIMEOUT_MS;
    try {
      while (!locked) {
        const [lock] = await queryRunner.query(
          "SELECT pg_try_advisory_lock(hashtext('vigieau'), hashtext('zone-compute-historic')) AS locked",
        );
        locked = lock?.locked === true;
        if (locked) {
          break;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            'Timed out waiting for the historic zone compute lock',
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      const state = await this.computeHistoric(
        true,
        requiredThrough,
        expectedSourceRevision,
        assertBoundary,
        expectedStatisticPublication,
      );
      if (!state) {
        throw new Error('Historic computation returned no cursor state');
      }
      return state;
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await this.cleanupHistoricLockSession(
        queryRunner,
        locked,
        false,
        primaryError,
      );
    }
  }

  private async cleanupHistoricLockSession(
    queryRunner: QueryRunner,
    locked: boolean,
    rollbackTransaction: boolean,
    primaryError: unknown,
  ): Promise<void> {
    const cleanupErrors: unknown[] = [];
    if (rollbackTransaction) {
      try {
        await queryRunner.rollbackTransaction();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    let advisoryCleanupFailed = false;
    if (locked) {
      try {
        const [result] = await queryRunner.query(
          "SELECT pg_advisory_unlock(hashtext('vigieau'), hashtext('zone-compute-historic')) AS unlocked",
        );
        if (result?.unlocked !== true) {
          throw new Error('Historic advisory lock was not released');
        }
      } catch (error) {
        advisoryCleanupFailed = true;
        cleanupErrors.push(error);
      }
    }
    if (advisoryCleanupFailed) {
      try {
        await queryRunner.query('SELECT pg_advisory_unlock_all()');
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await queryRunner.release();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0 && primaryError === null) {
      throw new AggregateError(
        cleanupErrors,
        'Failed to clean up historic statistic lock session',
      );
    }
  }

  private async assertHistoricCatchUpComplete(
    requiredThrough: string,
    expectedSourceRevision?: string,
    historicDirtyFrom?: string,
  ): Promise<void> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requiredThrough)) {
      throw new Error(`Invalid historic catch-up date: ${requiredThrough}`);
    }
    const startDate = `${requiredThrough.slice(0, 4)}-01-01`;
    const rewindDate = historicDirtyFrom ?? startDate;
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(rewindDate) ||
      rewindDate > requiredThrough
    ) {
      throw new Error(`Invalid historic dirty date: ${rewindDate}`);
    }
    const [config] = await this.dataSource.query(
      `SELECT "computeMapDate", "computeStatsDate" FROM "config" WHERE "id" = 1`,
    );
    const toDateString = (value: unknown): string | null => {
      if (!value) {
        return null;
      }
      if (value instanceof Date) {
        return value.toISOString().slice(0, 10);
      }
      return String(value).slice(0, 10);
    };
    const mapDate = toDateString(config?.computeMapDate);
    const statsDate = toDateString(config?.computeStatsDate);
    if (
      !mapDate ||
      !statsDate ||
      mapDate < requiredThrough ||
      statsDate < requiredThrough
    ) {
      await this.configService.setConfig(rewindDate, rewindDate);
      throw new Error(
        `Historic catch-up incomplete through ${requiredThrough}: map=${mapDate || 'null'}, stats=${statsDate || 'null'}`,
      );
    }

    const [incompleteSnapshot] = await this.dataSource.query(
      `
        SELECT "snapshotDate"
        FROM "statistic_commune_snapshot"
        WHERE "scope" <> 'bootstrap'
          AND (
            "status" <> 'completed'
            OR "processedCommuneCount" <> "expectedCommuneCount"
            OR (
              "scope" = 'national'
              AND
              $3::bigint IS NOT NULL
              AND "sourceRevision" IS DISTINCT FROM $3::bigint
            )
          )
          AND "snapshotDate" >= $2::date
          AND "snapshotDate" <= $1::date
        ORDER BY "snapshotDate" ASC
        LIMIT 1
      `,
      [requiredThrough, rewindDate, expectedSourceRevision ?? null],
    );
    if (incompleteSnapshot) {
      const snapshotDate = toDateString(incompleteSnapshot.snapshotDate);
      if (!snapshotDate) {
        throw new Error('Incomplete commune snapshot has no date');
      }
      await this.configService.setConfig(rewindDate, rewindDate);
      throw new Error(
        `Historic catch-up blocked by incompatible commune snapshot ${snapshotDate}`,
      );
    }

    const [coverage] = await this.dataSource.query(
      `
        WITH expected AS (
          SELECT ($2::date - $1::date + 1)::integer AS "dayCount"
        ), commune_coverage AS (
          SELECT
            commune."id",
            COUNT(DISTINCT restriction.value ->> 'date')::integer AS "dayCount"
          FROM "commune" commune
          LEFT JOIN "statistic_commune" statistic
            ON statistic."communeId" = commune."id"
          LEFT JOIN LATERAL jsonb_array_elements(
            COALESCE(statistic."restrictions", '[]'::jsonb)
          ) restriction(value)
            ON restriction.value ->> 'date' >= $1
           AND restriction.value ->> 'date' <= $2
          GROUP BY commune."id"
        )
        SELECT
          COUNT(*) FILTER (
            WHERE commune_coverage."dayCount" <> expected."dayCount"
          )::integer AS "incompleteCommuneCount",
          expected."dayCount" AS "expectedDayCount"
        FROM commune_coverage
        CROSS JOIN expected
        GROUP BY expected."dayCount"
      `,
      [startDate, requiredThrough],
    );
    if (!coverage) {
      throw new Error('Historic commune coverage contains no commune');
    }
    if (Number(coverage.incompleteCommuneCount || 0) > 0) {
      const coverageRewindDate =
        rewindDate < startDate ? rewindDate : startDate;
      await this.configService.setConfig(null, coverageRewindDate);
      throw new Error(
        `Historic commune coverage incomplete through ${requiredThrough}: ${Number(coverage.incompleteCommuneCount)} communes do not contain ${Number(coverage.expectedDayCount)} daily entries`,
      );
    }
  }

  private async runHistoricWorkerInChunks(
    type: 'maps' | 'mapsComputed',
    dateMin: string,
    dateStats: string | Date | null | undefined,
    expectedMapCursor: string | Date | null | undefined,
    expectedStatsCursor: string | Date | null | undefined,
    expectedMapGeneration: string,
    expectedStatsGeneration: string,
    requiredThrough: string,
    expectedSourceRevision?: string,
    expectedHistoricComputeEpoch?: string,
    assertBoundary?: HistoricBoundaryAssertion,
  ): Promise<HistoricCursorState> {
    const startDate = moment.utc(dateMin, 'YYYY-MM-DD', true);
    const endDate = moment.utc(requiredThrough, 'YYYY-MM-DD', true);
    if (
      !startDate.isValid() ||
      !endDate.isValid() ||
      startDate.isAfter(endDate, 'day')
    ) {
      throw new Error(
        `Invalid historic worker range: ${dateMin}..${requiredThrough}`,
      );
    }
    const dateString = (value: string | Date | null | undefined) =>
      value instanceof Date
        ? value.toISOString().slice(0, 10)
        : value
          ? String(value).slice(0, 10)
          : null;
    const chunkDays = assertBoundary ? 1 : readHistoricComputeChunkDays();
    let chunkStart = startDate;
    let cursorState: HistoricCursorState = {
      mapCursor: dateString(expectedMapCursor),
      statsCursor: dateString(expectedStatsCursor),
      mapGeneration: expectedMapGeneration,
      statsGeneration: expectedStatsGeneration,
    };
    const initialStatsDate = dateString(dateStats) ?? undefined;

    while (!chunkStart.isAfter(endDate, 'day')) {
      await assertBoundary?.();
      const naturalChunkEnd = chunkStart.clone().add(chunkDays - 1, 'days');
      const chunkEnd = naturalChunkEnd.isAfter(endDate, 'day')
        ? endDate.clone()
        : naturalChunkEnd;
      const chunkEndString = chunkEnd.format('YYYY-MM-DD');
      cursorState = await this.runHistoricWorker(
        type,
        chunkStart.format('YYYY-MM-DD'),
        cursorState.statsCursor ?? initialStatsDate,
        cursorState.mapCursor,
        cursorState.statsCursor,
        cursorState.mapGeneration,
        cursorState.statsGeneration,
        expectedSourceRevision,
        chunkEndString,
        expectedHistoricComputeEpoch,
      );
      await this.assertCurrentHistoricCursorState(
        cursorState,
        expectedHistoricComputeEpoch,
      );
      this.assertHistoricChunkCompleted(cursorState, chunkEndString);
      chunkStart = chunkEnd.add(1, 'day');
    }

    return cursorState;
  }

  private assertHistoricChunkCompleted(
    state: HistoricCursorState,
    requiredThrough: string,
  ): void {
    if (
      !state.mapCursor ||
      !state.statsCursor ||
      state.mapCursor < requiredThrough ||
      state.statsCursor < requiredThrough
    ) {
      throw new Error(
        `Historic worker did not complete its chunk through ${requiredThrough}: map=${state.mapCursor || 'null'}, stats=${state.statsCursor || 'null'}`,
      );
    }
  }

  private getHistoricCompletedThrough(state: HistoricCursorState): string {
    if (!state.mapCursor || !state.statsCursor) {
      throw new Error(
        `Historic computation has incomplete cursors: map=${state.mapCursor || 'null'}, stats=${state.statsCursor || 'null'}`,
      );
    }
    return state.mapCursor < state.statsCursor
      ? state.mapCursor
      : state.statsCursor;
  }

  private async rewindHistoricAfterSourceRevisionChange(
    dirtyFrom?: string,
    expectedSourceRevision?: string,
  ): Promise<void> {
    if (!dirtyFrom || expectedSourceRevision === undefined) {
      return;
    }
    try {
      const currentSourceRevision =
        await this.zonePublicationService.getSourceRevision();
      if (currentSourceRevision === expectedSourceRevision) {
        return;
      }
      await this.configService.setConfig(dirtyFrom, dirtyFrom);
      this.logger.log(
        `Historic cursors rewound to ${dirtyFrom} after source revision changed (${expectedSourceRevision} -> ${currentSourceRevision})`,
      );
    } catch (rewindError) {
      this.logger.error(
        'Unable to verify or rewind historic cursors after a failure',
        rewindError instanceof Error
          ? rewindError.toString()
          : String(rewindError),
      );
    }
  }

  private async runHistoricWorker(
    type: 'maps' | 'mapsComputed',
    dateMin: string,
    dateStats?: string,
    expectedMapCursor?: string | null,
    expectedStatsCursor?: string | null,
    expectedMapGeneration?: string,
    expectedStatsGeneration?: string,
    expectedSourceRevision?: string,
    dateMax?: string,
    expectedHistoricComputeEpoch?: string,
  ): Promise<HistoricCursorState> {
    const worker = new Worker(historicWorkerThreadFilePath, {
      workerData: {
        dateMin,
        dateStats,
        expectedMapCursor,
        expectedStatsCursor,
        expectedMapGeneration,
        expectedStatsGeneration,
        expectedSourceRevision,
        dateMax,
        expectedHistoricComputeEpoch,
        type,
      },
    });

    return new Promise<HistoricCursorState>((resolve, reject) => {
      let settled = false;
      let terminationInProgress = false;
      const settle = (callback: (value?: unknown) => void, value?: unknown) => {
        if (settled || terminationInProgress) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        callback(value);
      };
      const timeout = setTimeout(() => {
        if (settled || terminationInProgress) {
          return;
        }
        terminationInProgress = true;
        const error = new Error(
          `COMPUTE HISTORIC ${type.toUpperCase()} worker timed out`,
        );
        void (async () => {
          try {
            await worker.terminate();
          } catch (terminationError) {
            this.logger.error(
              `COMPUTE HISTORIC ${type.toUpperCase()} WORKER TERMINATION ERROR`,
              terminationError,
            );
          }
          terminationInProgress = false;
          settle(reject, error);
        })();
      }, HISTORIC_COMPUTE_WORKER_TIMEOUT_MS);

      worker.on('message', (result) => {
        if (result?.success === false) {
          settle(reject, new Error(result.error));
          return;
        }
        settle(resolve, result?.result);
      });

      worker.on('error', (error) => {
        this.logger.error(
          `COMPUTE HISTORIC ${type.toUpperCase()} WORKER ERROR`,
          error.toString(),
        );
        settle(reject, error);
      });

      worker.on('exit', (code) => {
        if (code === 0) {
          return;
        }
        const errorMessage = `COMPUTE HISTORIC ${type.toUpperCase()} Worker stopped with exit code ${code}`;
        this.logger.error(errorMessage, '');
        settle(reject, new Error(errorMessage));
      });
    });
  }

  private async assertCurrentHistoricCursorState(
    expected: HistoricCursorState,
    expectedHistoricComputeEpoch?: string,
  ): Promise<void> {
    this.assertHistoricCursorState(
      expected,
      await this.configService.getConfig(),
      expectedHistoricComputeEpoch,
    );
  }

  private assertHistoricCursorState(
    expected: HistoricCursorState,
    persisted: {
      computeMapDate?: string | Date | null;
      computeStatsDate?: string | Date | null;
      computeMapGeneration?: string | number | null;
      computeStatsGeneration?: string | number | null;
      historicComputeEpoch?: string | number | null;
    },
    expectedHistoricComputeEpoch?: string,
  ): void {
    const actual = this.toHistoricCursorState(persisted);
    if (
      actual.mapCursor !== expected.mapCursor ||
      actual.statsCursor !== expected.statsCursor ||
      actual.mapGeneration !== expected.mapGeneration ||
      actual.statsGeneration !== expected.statsGeneration ||
      (expectedHistoricComputeEpoch !== undefined &&
        String(persisted.historicComputeEpoch ?? 0) !==
          expectedHistoricComputeEpoch)
    ) {
      throw new Error(
        `Historic cursors changed after worker completion: expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
      );
    }
  }

  private toHistoricCursorState(persisted: {
    computeMapDate?: string | Date | null;
    computeStatsDate?: string | Date | null;
    computeMapGeneration?: string | number | null;
    computeStatsGeneration?: string | number | null;
  }): HistoricCursorState {
    const dateString = (value: string | Date | null | undefined) =>
      value instanceof Date
        ? value.toISOString().slice(0, 10)
        : value
          ? String(value).slice(0, 10)
          : null;
    return {
      mapCursor: dateString(persisted.computeMapDate),
      statsCursor: dateString(persisted.computeStatsDate),
      mapGeneration: String(persisted.computeMapGeneration ?? 0),
      statsGeneration: String(persisted.computeStatsGeneration ?? 0),
    };
  }

  async getZonesAlerteComputedByDepartement(
    departement: Departement,
  ): Promise<ZoneAlerteComputed[]> {
    const zonesDepartement = await this.zoneAlerteComputedRepository
      .createQueryBuilder('zone_alerte_computed')
      .select(
        'ST_AsGeoJSON(ST_TRANSFORM(zone_alerte_computed.geom, 4326))',
        'geom',
      )
      .addSelect('zone_alerte_computed.id', 'id')
      .addSelect('zone_alerte_computed.idSandre', 'idSandre')
      .addSelect('zone_alerte_computed.nom', 'nom')
      .addSelect('zone_alerte_computed.code', 'code')
      .addSelect('zone_alerte_computed.type', 'type')
      .addSelect(
        'zone_alerte_computed.ressourceInfluencee',
        'ressourceInfluencee',
      )
      .addSelect('departement.id', 'departement_id')
      .addSelect('"niveauGravite"')
      .leftJoin('zone_alerte_computed.departement', 'departement')
      .where('departement.id = :id', { id: departement.id })
      .getRawMany();
    await Promise.all(
      zonesDepartement.map(async (z) => {
        z.restriction =
          await this.restrictionService.findOneByZoneAlerteComputed(z.id);
        z.departement = {
          id: z.departement_id,
        };
        return z;
      }),
    );
    return zonesDepartement;
  }

  computeNewZone(zone: any) {
    const qb = this.zoneAlerteComputedRepository.createQueryBuilder(
      'zone_alerte_computed',
    );
    let sqlString = `ST_AsGeoJSON(ST_TRANSFORM(`;
    if (zone.remove && zone.remove.length > 0) {
      sqlString += `ST_DIFFERENCE(zone_alerte_computed.geom, `;
      sqlString += `(SELECT ST_UNION(zaBis.geom) FROM zone_alerte_computed as zaBis WHERE zaBis.id IN (${zone.remove.join(', ')}))`;
      sqlString += `)`;
    } else {
      sqlString += `zone_alerte_computed.geom`;
    }
    sqlString += `, 4326))`;
    return qb
      .select(sqlString, 'geom')
      .where('zone_alerte_computed.id = :id', { id: zone.id })
      .getRawOne();
  }

  getIntersect(zoneId: number, otherZonesId: number[]) {
    return this.zoneAlerteComputedRepository
      .createQueryBuilder('zone_alerte_computed')
      .select('zone_alerte_computed.id', 'id')
      .addSelect('zone_alerte_computed.idSandre', 'idSandre')
      .addSelect('zone_alerte_computed.code', 'code')
      .addSelect('zone_alerte_computed.nom', 'nom')
      .addSelect('zone_alerte_computed.type', 'type')
      .addSelect(
        'zone_alerte_computed.ressourceInfluencee',
        'ressourceInfluencee',
      )
      .where('zone_alerte_computed.id != :id', { id: zoneId })
      .andWhere('zone_alerte_computed.id IN(:...ids)', { ids: otherZonesId })
      .andWhere(
        'ST_INTERSECTS(zone_alerte_computed.geom, (SELECT zaBis.geom FROM zone_alerte_computed as zaBis WHERE zaBis.id = :id))',
        { id: zoneId },
      )
      .getRawMany();
  }

  getZonesIntersectedWithCommune(
    zones: ZoneAlerteComputed[],
    communeId: number,
  ) {
    return (
      this.zoneAlerteComputedRepository
        .createQueryBuilder('zone_alerte_computed')
        .select('zone_alerte_computed.id', 'id')
        .addSelect('zone_alerte_computed.code', 'code')
        .addSelect('zone_alerte_computed.nom', 'nom')
        .addSelect('zone_alerte_computed.type', 'type')
        .where('zone_alerte_computed.id IN(:...zonesId)', {
          zonesId: zones.map((z) => z.id),
        })
        .andWhere(
          `ST_GeometryType(zone_alerte_computed.geom) IN ('ST_Polygon', 'ST_MultiPolygon')`,
        )
        .andWhere(
          'ST_INTERSECTS(zone_alerte_computed.geom, (SELECT c.geom FROM commune as c WHERE c.id = :communeId))',
          { communeId },
        )
        // Au moins 1% de la surface en commun
        .andWhere(
          'ST_Area(ST_Intersection(zone_alerte_computed.geom, (SELECT c.geom FROM commune as c WHERE c.id = :communeId))) / ST_Area((SELECT c.geom FROM commune as c WHERE c.id = :communeId)) > 0.01',
          { communeId },
        )
        .getRawMany()
    );
  }

  async findDatagouv(): Promise<ZoneAlerteComputed[]> {
    return this.zoneAlerteComputedRepository.find(<FindManyOptions>{
      select: {
        id: true,
        idSandre: true,
        code: true,
        nom: true,
        type: true,
        niveauGravite: true,
        restriction: {
          id: true,
          arreteRestriction: {
            id: true,
            numero: true,
          },
          usages: {
            id: true,
            nom: true,
            thematique: {
              nom: true,
            },
            concerneParticulier: true,
            concerneEntreprise: true,
            concerneCollectivite: true,
            concerneExploitation: true,
            concerneEsu: true,
            concerneEso: true,
            concerneAep: true,
            descriptionVigilance: true,
            descriptionAlerte: true,
            descriptionAlerteRenforcee: true,
            descriptionCrise: true,
          },
        },
        departement: {
          id: true,
          code: true,
        },
      },
      relations: [
        'restriction',
        'restriction.arreteRestriction',
        'restriction.usages',
        'restriction.usages.thematique',
        'departement',
      ],
    });
  }

  async getZonesArea(zones: ZoneAlerteComputed[]) {
    return this.zoneAlerteComputedRepository
      .createQueryBuilder('zone_alerte_computed')
      .select(
        'SUM(ST_Area(zone_alerte_computed.geom::geography)/1000000)',
        'area',
      )
      .where('zone_alerte_computed.id IN(:...ids)', {
        ids: zones.map((z) => z.id),
      })
      .getRawOne();
  }
}
