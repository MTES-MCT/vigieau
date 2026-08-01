import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ConfigService as NestConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Departement } from '@shared/entities/departement.entity';
import { ZoneAlerteComputed } from '@shared/entities/zone_alerte_computed.entity';
import { exec } from 'child_process';
import * as fs from 'fs';
import moment from 'moment';
import { writeFile } from 'node:fs/promises';
import { DataSource, FindManyOptions, IsNull, Repository } from 'typeorm';
import * as util from 'util';
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
import { ZonePublicationService } from '../zone_publication/zone_publication.service';
import { isZonePublicationEnabled } from '../zone_publication/zone_publication.config';
import { generateEmptyPmtiles } from './empty-pmtiles';
import { shouldRunWebScheduledJobs } from '../core/scheduling/business-cron';

export const ZONE_COMPUTE_WORKER_TIMEOUT_MS = 60 * 60 * 1000;
const ZONE_PUBLICATION_WATCHDOG_INTERVAL_MS = 30 * 1000;
const HISTORIC_COMPUTE_LOCK_TIMEOUT_MS = 60 * 60 * 1000;
export const HISTORIC_COMPUTE_WORKER_TIMEOUT_MS = 4 * 60 * 60 * 1000;

interface QueuedComputeWaiter {
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
}

@Injectable()
export class ZoneAlerteComputedService {
  private readonly logger = new RegleauLogger('ZoneAlerteComputedService');
  private isComputing = false;
  private askForCompute = false;
  private departementsToUpdate: number[] = [];
  private pendingComputeHistoric = false;
  private pendingNormalCompute = false;
  private activeComputeWorker: Worker | null = null;
  private computeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private queuedComputeWaiters: QueuedComputeWaiter[] = [];
  private publicationWatchdogInProgress = false;
  private readonly historicComputedStartDate = '2024-04-29';
  // Promisifier exec
  private execPromise = util.promisify(exec);

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
    computeHistoric = false,
    skipIfBusy = false,
  ) {
    this.departementsToUpdate = this.departementsToUpdate.concat(depsIds ?? []);
    this.pendingComputeHistoric ||= computeHistoric;
    this.pendingNormalCompute ||= !skipIfBusy;
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

      const uniqueDepsIds = [...new Set(this.departementsToUpdate)];
      this.departementsToUpdate = [];
      const effectiveComputeHistoric = this.pendingComputeHistoric;
      const effectiveSkipIfBusy = !this.pendingNormalCompute;
      this.pendingComputeHistoric = false;
      this.pendingNormalCompute = false;
      queuedWaiters = this.queuedComputeWaiters.splice(0);

      const resolveQueuedWaiters = (result: unknown) => {
        queuedWaiters.splice(0).forEach(({ resolve }) => resolve(result));
      };
      const rejectQueuedWaiters = (error: unknown) => {
        queuedWaiters.splice(0).forEach(({ reject }) => reject(error));
      };

      const worker = new Worker(workerThreadFilePath, {
        workerData: {
          depsIds: uniqueDepsIds,
          computeHistoric: effectiveComputeHistoric,
          skipIfBusy: effectiveSkipIfBusy,
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
      if (await this.zonePublicationService.isRecomputeRequired()) {
        await this.askCompute([], false, false, true);
      }
    } catch (error) {
      this.logger.error('ZONE PUBLICATION WATCHDOG ERROR', error);
    } finally {
      this.publicationWatchdogInProgress = false;
    }
  }

  async computeAll(depsId?: number[], computeHistoric?: boolean) {
    this.logger.log(`COMPUTING ZONES D'ALERTES - BEGIN`);
    const sourceRevision =
      !depsId?.length && isZonePublicationEnabled()
        ? await this.zonePublicationService.getSourceRevision()
        : undefined;
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
    return this.computeGeoJson(computeHistoric, sourceRevision);
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
            const za = await this.zoneAlerteService.findOne(
              restriction.zoneAlerte.id,
              [restriction.arreteCadre.id],
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

  async computeGeoJson(computeHistoric?: boolean, sourceRevision?: string) {
    const publicationEnabled = isZonePublicationEnabled();
    const allZonesComputed: any = await this.zoneAlerteComputedRepository.find(<
      FindManyOptions
    >{
      select: {
        id: true,
        idSandre: true,
        code: true,
        nom: true,
        type: true,
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
        return {
          type: 'Feature',
          geometry: z.geom,
          properties: {
            id: z.id,
            idSandre: z.idSandre,
            nom: z.nom,
            code: z.code,
            type: z.type,
            niveauGravite: z.restriction?.niveauGravite,
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
              let d;
              switch (z.restriction.niveauGravite) {
                case 'vigilance':
                  d = u.descriptionVigilance;
                  break;
                case 'alerte':
                  d = u.descriptionAlerte;
                  break;
                case 'alerte_renforcee':
                  d = u.descriptionAlerteRenforcee;
                  break;
                case 'crise':
                  d = u.descriptionCrise;
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
                description: d,
              };
            }),
          },
        };
      }),
    );

    const geojson = {
      type: 'FeatureCollection',
      features: allZones,
    };

    const path = this.nestConfigService.get('PATH_TO_WRITE_FILE');

    const date = new Date();
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
    if (!publicationEnabled) {
      await this.publishLegacyArtifact(
        fileToTransferGeojson,
        date,
        'geojson',
        'Carte des zones et arrêtés en vigueur - GeoJSON',
      );
    }
    let pmtilesChecksum: string | undefined;
    let fileToTransferPmtiles:
      | { originalname: string; buffer: Buffer }
      | undefined;
    try {
      if (allZones.length === 0) {
        await generateEmptyPmtiles({
          workingDirectory: path,
          outputPath: `${path}/zones_arretes_en_vigueur.pmtiles`,
        });
      } else {
        await this.execPromise(
          `${path}/tippecanoe_program/bin/tippecanoe \
          -Z4 \
          -zg \
          --maximum-tile-byte=1000000 \
          --force \
          --read-parallel \
          --detect-shared-borders \
          --coalesce-densest-as-needed \
          --simplification=28 \
          --layer=zones_arretes_en_vigueur \
          --output="${path}/zones_arretes_en_vigueur.pmtiles" \
          "${path}/zones_arretes_en_vigueur.geojson"
          `,
        );
      }
      const data = fs.readFileSync(`${path}/zones_arretes_en_vigueur.pmtiles`);
      pmtilesChecksum = createHash('sha256').update(data).digest('hex');
      fileToTransferPmtiles = {
        originalname: 'zones_arretes_en_vigueur.pmtiles',
        buffer: data,
      };
    } catch (e) {
      this.logger.error('ERROR GENERATING PMTILES', e);
      if (publicationEnabled && sourceRevision !== undefined) {
        throw e;
      }
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
    } else if (fileToTransferPmtiles) {
      await this.publishLegacyArtifact(
        fileToTransferPmtiles,
        date,
        'pmtiles',
        'Carte des zones et arrêtés en vigueur - PMTILES',
      );
    }
    await this.zoneAlerteComputedRepository
      .createQueryBuilder()
      .update()
      .set({ enabled: true })
      .where('1 = 1')
      .execute();
    await this.markLegacyComputationAvailable(new Date(), publicationEnabled);
    await this.statisticDepartementService.computeDepartementStatisticsRestrictions(
      allZonesComputed,
      date,
    );
    await this.statisticCommuneService.computeCommuneStatisticsRestrictions(
      allZonesComputed,
      date,
    );
    await this.statisticCommuneService.computeCommuneStatisticsRestrictionsByMonth(
      date,
    );
    await this.statisticService.computeDepartementsSituation(allZonesComputed);
    if (computeHistoric) {
      if (publicationEnabled && sourceRevision !== undefined) {
        await this.computeHistoric(true);
      } else {
        void this.computeHistoric();
      }
    }
    const publicationId = await this.buildVersionedPublicationIfNational({
      sourceRevision,
      sourceComputedAt: date,
      artifactZoneCount: allZones.length,
      geojsonUrl: immutableArtifacts.geojsonUrl,
      geojsonChecksum,
      pmtilesUrl: immutableArtifacts.pmtilesUrl,
      pmtilesChecksum,
    });
    return { publicationId, sourceRevision };
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

  private async publishLegacyArtifact(
    file: { originalname: string; buffer: Buffer },
    date: Date,
    kind: 'geojson' | 'pmtiles',
    dataGouvTitle: string,
  ): Promise<void> {
    let stableUrl: string | undefined;
    let datedCopySucceeded = false;
    try {
      const stableResponse = await this.s3Service.uploadFile(
        file as Express.Multer.File,
        `${kind}/`,
        { cacheControl: 'public, max-age=0, must-revalidate' },
      );
      stableUrl = stableResponse?.Location;
      if (!stableUrl) {
        throw new Error(`Stable ${kind} upload returned no URL`);
      }
      const datedFileName = `zones_arretes_en_vigueur_${date.toISOString().split('T')[0]}.${kind}`;
      await this.s3Service.copyFile(
        file.originalname,
        datedFileName,
        `${kind}/`,
        {
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

    if (stableUrl && (kind === 'pmtiles' || datedCopySucceeded)) {
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
    const configuredTimeoutMs = Number(
      this.nestConfigService.get('ZONE_PUBLICATION_S3_TIMEOUT_MS'),
    );
    const timeoutMs =
      Number.isInteger(configuredTimeoutMs) && configuredTimeoutMs > 0
        ? configuredTimeoutMs
        : 60_000;
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

  async computeHistoric(rethrowWorkerError = false, requiredThrough?: string) {
    const config = await this.configService.getConfig();
    const dirtyDates = [config.computeMapDate, config.computeStatsDate]
      .filter(Boolean)
      .map((date) => moment(date, 'YYYY-MM-DD'));
    const dirtyDate = dirtyDates.reduce((minDate, date) => {
      return date.isBefore(minDate, 'day') ? date : minDate;
    }, dirtyDates[0]);

    if (dirtyDate && moment().diff(dirtyDate, 'days') >= 1) {
      try {
        const computedStartDate = moment(
          this.historicComputedStartDate,
          'YYYY-MM-DD',
        );
        const dirtyDateString = dirtyDate.format('YYYY-MM-DD');

        if (dirtyDate.isBefore(computedStartDate, 'day')) {
          const legacyState = await this.runHistoricWorker(
            'maps',
            dirtyDateString,
            config.computeStatsDate,
            config.computeMapDate,
            config.computeStatsDate,
            String(config.computeMapGeneration ?? 0),
            String(config.computeStatsGeneration ?? 0),
          );
          const resumedConfig = await this.configService.getConfig();
          this.assertHistoricCursorState(legacyState, resumedConfig);

          if (moment().diff(computedStartDate, 'days') >= 1) {
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
            const computedState = await this.runHistoricWorker(
              'mapsComputed',
              this.historicComputedStartDate,
              resumedConfig.computeStatsDate,
              resumedConfig.computeMapDate,
              resumedConfig.computeStatsDate,
              String(resumedConfig.computeMapGeneration ?? 0),
              String(resumedConfig.computeStatsGeneration ?? 0),
            );
            await this.assertCurrentHistoricCursorState(computedState);
          }
        } else {
          const computedState = await this.runHistoricWorker(
            'mapsComputed',
            dirtyDateString,
            config.computeStatsDate,
            config.computeMapDate,
            config.computeStatsDate,
            String(config.computeMapGeneration ?? 0),
            String(config.computeStatsGeneration ?? 0),
          );
          await this.assertCurrentHistoricCursorState(computedState);
        }
      } catch (error) {
        this.logger.error('Error in computeHistoric', error.toString());
        if (rethrowWorkerError) {
          throw error;
        }
      }
    }
    const statsMonthDate =
      config.computeStatsDate || dirtyDate?.format('YYYY-MM-DD');
    if (statsMonthDate) {
      await this.statisticCommuneService.computeByMonth(
        moment(statsMonthDate, 'YYYY-MM-DD'),
      );
    }
    if (requiredThrough) {
      await this.assertHistoricCatchUpComplete(requiredThrough);
    }
  }

  async computeHistoricPersistently(requiredThrough: string): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    let locked = false;
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
      await this.computeHistoric(true, requiredThrough);
    } finally {
      try {
        if (locked) {
          await queryRunner.query(
            "SELECT pg_advisory_unlock(hashtext('vigieau'), hashtext('zone-compute-historic')) AS unlocked",
          );
        }
      } finally {
        await queryRunner.release();
      }
    }
  }

  private async assertHistoricCatchUpComplete(
    requiredThrough: string,
  ): Promise<void> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requiredThrough)) {
      throw new Error(`Invalid historic catch-up date: ${requiredThrough}`);
    }
    const startDate = `${requiredThrough.slice(0, 4)}-01-01`;
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
      await this.configService.setConfig(startDate, startDate);
      throw new Error(
        `Historic catch-up incomplete through ${requiredThrough}: map=${mapDate || 'null'}, stats=${statsDate || 'null'}`,
      );
    }

    const [incompleteSnapshot] = await this.dataSource.query(
      `
        SELECT "snapshotDate"
        FROM "statistic_commune_snapshot"
        WHERE "status" <> 'completed'
          AND "snapshotDate" <= $1::date
        ORDER BY "snapshotDate" ASC
        LIMIT 1
      `,
      [requiredThrough],
    );
    if (incompleteSnapshot) {
      const snapshotDate = toDateString(incompleteSnapshot.snapshotDate);
      if (!snapshotDate) {
        throw new Error('Incomplete commune snapshot has no date');
      }
      await this.configService.setConfig(snapshotDate, snapshotDate);
      throw new Error(
        `Historic catch-up blocked by incomplete commune snapshot ${snapshotDate}`,
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
      await this.configService.setConfig(null, startDate);
      throw new Error(
        `Historic commune coverage incomplete through ${requiredThrough}: ${Number(coverage.incompleteCommuneCount)} communes do not contain ${Number(coverage.expectedDayCount)} daily entries`,
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
  ): Promise<HistoricCursorState> {
    const worker = new Worker(historicWorkerThreadFilePath, {
      workerData: {
        dateMin,
        dateStats,
        expectedMapCursor,
        expectedStatsCursor,
        expectedMapGeneration,
        expectedStatsGeneration,
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
  ): Promise<void> {
    this.assertHistoricCursorState(
      expected,
      await this.configService.getConfig(),
    );
  }

  private assertHistoricCursorState(
    expected: HistoricCursorState,
    persisted: {
      computeMapDate?: string | Date | null;
      computeStatsDate?: string | Date | null;
      computeMapGeneration?: string | number | null;
      computeStatsGeneration?: string | number | null;
    },
  ): void {
    const dateString = (value: string | Date | null | undefined) =>
      value instanceof Date
        ? value.toISOString().slice(0, 10)
        : value
          ? String(value).slice(0, 10)
          : null;
    const actual: HistoricCursorState = {
      mapCursor: dateString(persisted.computeMapDate),
      statsCursor: dateString(persisted.computeStatsDate),
      mapGeneration: String(persisted.computeMapGeneration ?? 0),
      statsGeneration: String(persisted.computeStatsGeneration ?? 0),
    };
    if (
      actual.mapCursor !== expected.mapCursor ||
      actual.statsCursor !== expected.statsCursor ||
      actual.mapGeneration !== expected.mapGeneration ||
      actual.statsGeneration !== expected.statsGeneration
    ) {
      throw new Error(
        `Historic cursors changed after worker completion: expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
      );
    }
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
