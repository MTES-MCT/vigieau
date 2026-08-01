import { HttpService } from '@nestjs/axios';
import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CronExpression } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { BassinVersant } from '@shared/entities/bassin_versant.entity';
import { Departement } from '@shared/entities/departement.entity';
import { SandreZoneAlias } from '@shared/entities/sandre_zone_alias.entity';
import { SandreZoneSyncState } from '@shared/entities/sandre_zone_sync_state.entity';
import { User } from '@shared/entities/user.entity';
import { ZoneAlerte } from '@shared/entities/zone_alerte.entity';
import { firstValueFrom } from 'rxjs';
import {
  DataSource,
  EntityManager,
  FindManyOptions,
  FindOptionsWhere,
  In,
  IsNull,
  Repository,
  QueryRunner,
} from 'typeorm';
import { isMainThread } from 'worker_threads';
import { ArreteCadreService } from '../arrete_cadre/arrete_cadre.service';
import { BassinVersantService } from '../bassin_versant/bassin_versant.service';
import { BusinessCron } from '../core/scheduling/business-cron';
import { DepartementService } from '../departement/departement.service';
import { RegleauLogger } from '../logger/regleau.logger';
import { MailService } from '../shared/services/mail.service';
import { runCurrentZoneComputeWorker } from '../worker_threads/run-current-zone-compute';
import { unwrapTypeOrmDmlReturningRows } from '../zone_publication/typeorm-query-result';
import {
  buildReconciliationResults,
  discoverGenealogyCsvUrl,
  mappingsFromResults,
  parseGenealogyCsv,
  SANDRE_GENEALOGY_METADATA_URL,
  SandreGenealogyRelation,
  ZoneReferenceCounts,
} from './sandre-zone-reconciliation';
import {
  fetchSandreZoneSnapshot,
  hashSandreZoneFeatures,
  SandreZoneFeature,
  SandreZoneSnapshot,
} from './sandre-zone-sync';
import {
  isSandreBlockedRetryDue,
  parseSandreZoneSyncMode,
  SandreDepartmentBlockedError,
  SandreOperatorStatus,
  SandreSyncDecisionDraft,
  SandreZoneSyncMode,
} from './sandre-zone-governance';

const SANDRE_FULL_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SANDRE_HTTP_TIMEOUT_MS = 30 * 1000;
const SANDRE_GENEALOGY_CACHE_MS = 10 * 60 * 1000;
const SANDRE_GENEALOGY_METADATA_MAX_BYTES = 1024 * 1024;
const SANDRE_GENEALOGY_CSV_MAX_BYTES = 20 * 1024 * 1024;
const SANDRE_VALID_STATUS = 'Validé';
const SANDRE_ZONE_SELECT = {
  id: true,
  idSandre: true,
  codeSandre: true,
  statutSandre: true,
  dateMajSandre: true,
  codesAlternatifs: true,
  sandrePayloadHash: true,
  nom: true,
  code: true,
  type: true,
  ressourceInfluencee: true,
  numeroVersionSandre: true,
  disabled: true,
  departement: {
    id: true,
    code: true,
  },
  bassinVersant: {
    id: true,
    code: true,
  },
  geom: true,
} as const;

function sameStringArrays(left: string[], right: string[]): boolean {
  return JSON.stringify([...(left ?? [])].sort()) === JSON.stringify(right);
}

function samePolygonGeometry(left: any, right: any): boolean {
  if (!left || !right) {
    return left === right;
  }
  return (
    JSON.stringify({
      type: left.type,
      coordinates: left.coordinates,
    }) ===
    JSON.stringify({
      type: right.type,
      coordinates: right.coordinates,
    })
  );
}

interface SandreSyncResult {
  added: number;
  updated: number;
  disabled: number;
  unchanged: number;
}

interface SandreZoneMatch {
  matchType: 'canonical' | 'alias' | 'legacy_gid';
  zone: ZoneAlerte;
}

interface SandreSnapshotApplication {
  result: SandreSyncResult;
  recomputeRequired: boolean;
  decisions: SandreSyncDecisionDraft[];
}

@Injectable()
export class ZoneAlerteService {
  private readonly logger = new RegleauLogger('ZoneAlerteService');
  private sandreSyncRunning = false;
  private sandreGlobalLockHeld = false;
  private sandreSyncConfigurationWarned = false;
  private sandreGenealogyCache: {
    expiresAt: number;
    relations: SandreGenealogyRelation[];
  } | null = null;
  private sandreGenealogyFetch: Promise<SandreGenealogyRelation[]> | null =
    null;

  constructor(
    @InjectRepository(ZoneAlerte)
    private readonly zoneAlerteRepository: Repository<ZoneAlerte>,
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly departementService: DepartementService,
    private readonly bassinVersantService: BassinVersantService,
    private readonly mailService: MailService,
    @Inject(forwardRef(() => ArreteCadreService))
    private readonly arreteCadreService: ArreteCadreService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async findOne(id: number, acIds?: number[]): Promise<any> {
    const za = await this.zoneAlerteRepository
      .createQueryBuilder('zone_alerte')
      .select('zone_alerte.id', 'id')
      .addSelect('zone_alerte.idSandre', 'idSandre')
      .addSelect('zone_alerte.code', 'code')
      .addSelect('zone_alerte.nom', 'nom')
      .addSelect('zone_alerte.type', 'type')
      .addSelect('zone_alerte.ressourceInfluencee', 'ressourceInfluencee')
      .addSelect('ST_AsGeoJSON(ST_TRANSFORM(zone_alerte.geom, 4326))', 'geom')
      .where('zone_alerte.id = :id', { id })
      .getRawOne();

    za.arreteCadreZoneAlerteCommunes = (
      await this.zoneAlerteRepository
        .createQueryBuilder('zone_alerte')
        .select(['zone_alerte.id'])
        .addSelect(['aczac.id', 'communes.id'])
        .leftJoin(
          'zone_alerte.arreteCadreZoneAlerteCommunes',
          'aczac',
          'aczac.arreteCadreId IN(:...acIds)',
          { acIds: acIds },
        )
        .leftJoin('aczac.communes', 'communes')
        .where('zone_alerte.id = :id', { id })
        .getOne()
    ).arreteCadreZoneAlerteCommunes;

    return za;
  }

  findByDepartement(departementCode: string): Promise<ZoneAlerte[]> {
    return this.zoneAlerteRepository.find(<FindManyOptions>{
      relations: ['departement'],
      where: {
        departement: {
          code: departementCode,
        },
        disabled: false,
      },
    });
  }

  findByArreteCadre(acId: number): Promise<ZoneAlerte[]> {
    return this.zoneAlerteRepository
      .createQueryBuilder('zone_alerte')
      .select('zone_alerte.id', 'id')
      .addSelect('zone_alerte.code', 'code')
      .addSelect('zone_alerte.nom', 'nom')
      .addSelect('zone_alerte.type', 'type')
      .addSelect(
        'ST_AsGeoJSON(ST_TRANSFORM(zone_alerte.geom, 4326), 3)',
        'geom',
      )
      .leftJoin('zone_alerte.arretesCadre', 'arrete_cadre')
      .where('arrete_cadre.id = :acId', { acId })
      .getRawMany();
  }

  findByArreteRestriction(arIds: number[]): Promise<ZoneAlerte[]> | any[] {
    if (!arIds || arIds.length < 1) {
      return [];
    }
    return this.zoneAlerteRepository.find(<FindManyOptions>{
      select: {
        id: true,
        idSandre: true,
        code: true,
        nom: true,
        type: true,
        ressourceInfluencee: true,
        departement: {
          code: true,
          nom: true,
        },
        restrictions: {
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
        'restrictions',
        'restrictions.usages',
        'restrictions.usages.thematique',
        'restrictions.arreteRestriction',
        'restrictions.arreteRestriction.fichier',
      ],
      where: {
        restrictions: {
          arreteRestriction: {
            id: In(arIds),
          },
        },
      },
    });
  }

  async getMaxUpdatedDate(currentUser: User): Promise<string> {
    if (currentUser.role === 'commune') {
      return null;
    }

    const whereClause: FindOptionsWhere<ZoneAlerte> | null =
      !currentUser || currentUser.role === 'mte'
        ? {}
        : {
            departement: {
              code: In(currentUser.role_departements),
            },
          };

    const result = await this.zoneAlerteRepository
      .createQueryBuilder('zone_alerte')
      .select('MAX(zone_alerte.updatedAt)', 'maxDate')
      .leftJoin('zone_alerte.departement', 'departement')
      .where(whereClause)
      .getRawOne();
    return result?.maxDate || null;
  }

  async getSandreOperatorStatus(): Promise<SandreOperatorStatus> {
    const generatedAt = new Date();
    const [latestBatch] = await this.dataSource.query(`
      SELECT id, mode, status, "startedAt", "finishedAt"
      FROM sandre_zone_sync_batch
      WHERE kind = 'snapshot'
      ORDER BY "startedAt" DESC, id DESC
      LIMIT 1
    `);
    const departmentRows = await this.dataSource.query(`
      SELECT
        departement.code AS "departmentCode",
        state."observedSourceUpdatedAt",
        state."appliedSourceUpdatedAt",
        state."lastObservedAt",
        state."lastAppliedAt",
        state."blockedAt",
        CASE
          WHEN state."blockedAt" IS NULL THEN NULL
          WHEN state."blockedReason" LIKE '%non-abrogated framework order%'
            THEN 'NON_ABROGATED_AC_REFERENCE'
          WHEN state."blockedReason" LIKE '%operational reference%'
            THEN 'OPERATIONAL_ZONE_REFERENCE'
          ELSE 'DEPARTMENT_VALIDATION_FAILED'
        END AS "blockCode"
      FROM sandre_zone_sync_state state
      JOIN departement ON departement.id = state."departementId"
      ORDER BY departement.code
    `);
    const ageSeconds = (value: Date | string | null): number | null => {
      if (!value) {
        return null;
      }
      return Math.max(
        0,
        Math.floor((generatedAt.getTime() - new Date(value).getTime()) / 1000),
      );
    };
    const departments = departmentRows.map((row) => ({
      departmentCode: row.departmentCode,
      observedSourceUpdatedAt: row.observedSourceUpdatedAt ?? null,
      appliedSourceUpdatedAt: row.appliedSourceUpdatedAt ?? null,
      lastObservedAt: row.lastObservedAt
        ? new Date(row.lastObservedAt).toISOString()
        : null,
      lastAppliedAt: row.lastAppliedAt
        ? new Date(row.lastAppliedAt).toISOString()
        : null,
      observedAgeSeconds: ageSeconds(row.lastObservedAt),
      appliedAgeSeconds: ageSeconds(row.lastAppliedAt),
      blocked: Boolean(row.blockedAt),
      blockedAt: row.blockedAt ? new Date(row.blockedAt).toISOString() : null,
      blockCode: row.blockCode ?? null,
    }));
    const mode = parseSandreZoneSyncMode(
      this.configService.get<string>('SANDRE_ZONE_SYNC_MODE'),
    );
    const batchStartedAt = latestBatch?.startedAt
      ? new Date(latestBatch.startedAt)
      : null;
    const batchFinishedAt = latestBatch?.finishedAt
      ? new Date(latestBatch.finishedAt)
      : null;

    return {
      mode: mode ?? 'invalid',
      generatedAt: generatedAt.toISOString(),
      latestBatch: latestBatch
        ? {
            id: String(latestBatch.id),
            mode: latestBatch.mode,
            status: latestBatch.status,
            startedAt: batchStartedAt.toISOString(),
            finishedAt: batchFinishedAt?.toISOString() ?? null,
            ageSeconds: ageSeconds(batchFinishedAt ?? batchStartedAt) ?? 0,
            durationSeconds: batchFinishedAt
              ? Math.max(
                  0,
                  Math.floor(
                    (batchFinishedAt.getTime() - batchStartedAt.getTime()) /
                      1000,
                  ),
                )
              : null,
          }
        : null,
      summary: {
        trackedDepartments: departments.length,
        blockedDepartments: departments.filter((item) => item.blocked).length,
      },
      departments,
    };
  }

  @BusinessCron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeSandreSyncHistory(): Promise<number> {
    const configuredRetention = Number(
      this.configService.get<string>('SANDRE_SYNC_RETENTION_DAYS'),
    );
    const retentionDays =
      Number.isInteger(configuredRetention) && configuredRetention >= 7
        ? configuredRetention
        : 90;
    const deleted = unwrapTypeOrmDmlReturningRows<{ id: string }>(
      await this.dataSource.query(
        `
        WITH retained AS (
          SELECT DISTINCT ON (
            COALESCE("departementId", 0), "kind", "mode"
          ) "id"
          FROM sandre_zone_sync_batch
          ORDER BY COALESCE("departementId", 0), "kind", "mode",
                   "startedAt" DESC, "id" DESC
        )
        DELETE FROM sandre_zone_sync_batch batch
        WHERE batch."startedAt" < now() - ($1 * interval '1 day')
          AND batch."status" <> 'started'
          AND NOT EXISTS (
            SELECT 1 FROM retained WHERE retained."id" = batch."id"
          )
        RETURNING batch."id"
      `,
        [retentionDays],
      ),
    );
    if (deleted.length > 0) {
      this.logger.log(`PURGED ${deleted.length} SANDRE SYNC BATCHES`);
    }
    return deleted.length;
  }

  /**
   * Vérification régulière s'il n'y a pas de nouvelles zones
   */
  @BusinessCron(CronExpression.EVERY_10_MINUTES)
  async updateZones() {
    const configuredMode = this.configService.get<string>(
      'SANDRE_ZONE_SYNC_MODE',
    );
    const syncMode = parseSandreZoneSyncMode(configuredMode);
    if (!syncMode || syncMode === 'paused') {
      if (!this.sandreSyncConfigurationWarned) {
        if (syncMode === 'paused') {
          this.logger.warn(
            'SYNCHRONISATION SANDRE EN PAUSE: SANDRE_ZONE_SYNC_MODE=audit OU safe REQUIS',
          );
        } else {
          this.logger.error(
            `SANDRE_ZONE_SYNC_MODE INVALIDE: ${configuredMode}`,
            '',
          );
        }
        this.sandreSyncConfigurationWarned = true;
      }
      return;
    }
    if (!isMainThread || this.sandreSyncRunning) {
      return;
    }

    this.sandreSyncRunning = true;
    this.logger.log("MISE A JOUR DES ZONES D'ALERTE - DEBUT");
    let globalLock: QueryRunner | null = null;
    try {
      globalLock = await this.acquireSandreGlobalLock();
      if (!globalLock) {
        this.logger.warn(
          'SYNCHRONISATION SANDRE IGNOREE: UNE AUTRE EXECUTION DETIENT LE VERROU GLOBAL',
        );
        return;
      }
      this.sandreGlobalLockHeld = true;
      const departements = await this.departementService.findAllLight();

      for (const d of departements) {
        let recomputeWasPending = false;
        try {
          const state = await this.dataSource
            .getRepository(SandreZoneSyncState)
            .findOne({
              where: {
                departement: {
                  id: d.id,
                },
              },
            });
          recomputeWasPending = Boolean(state?.needsRecompute);
          const lastFullSyncAt = (
            state?.lastObservedAt ?? state?.lastFullSyncAt
          )?.getTime();
          const fullSyncExpired =
            !lastFullSyncAt ||
            Date.now() - lastFullSyncAt >= SANDRE_FULL_SYNC_INTERVAL_MS;
          const blockedRetryDue =
            syncMode === 'safe' && isSandreBlockedRetryDue(state?.blockedAt);
          const applicationPending =
            syncMode === 'safe' &&
            (!state?.lastAppliedAt ||
              state.observedSnapshotHash !== state.appliedSnapshotHash ||
              state.observedSourceUpdatedAt !== state.appliedSourceUpdatedAt);
          const sourceChanged =
            !fullSyncExpired &&
            !blockedRetryDue &&
            !applicationPending &&
            (await this.hasSandreChanges(d.code, state));

          if (
            fullSyncExpired ||
            blockedRetryDue ||
            applicationPending ||
            sourceChanged
          ) {
            await this.updateDepartementZones(d.code);
          }
        } catch (error) {
          this.logger.error(
            `ERREUR LORS DE LA MISE A JOUR DES ZONES D'ALERTES DU DEPARTEMENT ${d.code}`,
            error,
          );
        }
        if (syncMode === 'safe' && recomputeWasPending) {
          try {
            await this.recomputeSandreDepartment(d.code);
          } catch (error) {
            this.logger.error(
              `ERREUR LORS DU RECALCUL DES ZONES D'ALERTES DU DEPARTEMENT ${d.code}`,
              error,
            );
          }
        }
      }
    } catch (error) {
      this.logger.error(
        "ERREUR LORS DE LA MISE A JOUR DES ZONES D'ALERTES",
        error,
      );
    } finally {
      this.sandreGlobalLockHeld = false;
      try {
        if (globalLock) {
          await this.releaseSandreGlobalLock(globalLock);
        }
      } catch (error) {
        this.logger.error(
          'ERREUR LORS DE LA LIBERATION DU VERROU GLOBAL SANDRE',
          error,
        );
      } finally {
        this.sandreSyncRunning = false;
        this.logger.log("MISE A JOUR DES ZONES D'ALERTE - FIN");
      }
    }
  }

  async updateDepartementZones(depCode: string): Promise<SandreSyncResult> {
    const configuredMode = this.configService.get<string>(
      'SANDRE_ZONE_SYNC_MODE',
    );
    const syncMode = parseSandreZoneSyncMode(configuredMode);
    if (!syncMode) {
      throw new Error(`Invalid SANDRE_ZONE_SYNC_MODE: ${configuredMode}`);
    }
    if (syncMode === 'paused') {
      return { added: 0, updated: 0, disabled: 0, unchanged: 0 };
    }

    if (this.sandreGlobalLockHeld) {
      return this.updateDepartementZonesWithMode(depCode, syncMode);
    }
    const globalLock = await this.acquireSandreGlobalLock();
    if (!globalLock) {
      throw new Error('Another Sandre synchronization is already running');
    }
    let operationError: unknown;
    try {
      return await this.updateDepartementZonesWithMode(depCode, syncMode);
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      try {
        await this.releaseSandreGlobalLock(globalLock);
      } catch (cleanupError) {
        if (!operationError) {
          throw cleanupError;
        }
        this.logger.error(
          'ERREUR LORS DE LA LIBERATION DU VERROU GLOBAL SANDRE',
          cleanupError,
        );
      }
    }
  }

  private async updateDepartementZonesWithMode(
    depCode: string,
    syncMode: Exclude<SandreZoneSyncMode, 'paused'>,
  ): Promise<SandreSyncResult> {
    this.logger.log(`MISE A JOUR DES ZONES D'ALERTE DU DEPARTEMENT ${depCode}`);

    const [{ syncStartedAt }] = await this.dataSource.query(
      'SELECT clock_timestamp() AS "syncStartedAt"',
    );
    const startedAt = new Date(syncStartedAt);
    const batchId = await this.startSandreBatch(depCode, syncMode, startedAt);
    let snapshot: SandreZoneSnapshot;
    try {
      snapshot = await this.fetchSandreDepartmentSnapshot(depCode);
    } catch (error) {
      await this.finishSandreBatch(batchId, 'failed', null, error);
      throw error;
    }
    await this.recordSandreObservation(depCode, snapshot, startedAt);

    if (syncMode === 'audit') {
      const decisions = this.createAuditDecisions(snapshot);
      await this.persistSandreDecisions(
        this.dataSource,
        depCode,
        batchId,
        decisions,
      );
      await this.finishSandreBatch(batchId, 'observed', snapshot);
      return {
        added: 0,
        updated: 0,
        disabled: 0,
        unchanged: snapshot.featureCount,
      };
    }

    let application: SandreSnapshotApplication;
    try {
      application = await this.applySandreSnapshot(
        depCode,
        snapshot,
        startedAt,
        batchId,
      );
    } catch (error) {
      const decisions =
        error instanceof SandreDepartmentBlockedError
          ? error.decisions
          : this.createBlockedDecisions(snapshot, error);
      await this.persistSandreDecisions(
        this.dataSource,
        depCode,
        batchId,
        decisions,
      );
      await this.markSandreDepartmentBlocked(depCode, snapshot, error);
      await this.finishSandreBatch(batchId, 'blocked', snapshot, error);
      throw error;
    }
    try {
      await this.finishSandreBatch(batchId, 'applied', snapshot);
    } catch (error) {
      this.logger.error(
        `SYNCHRONISATION SANDRE APPLIQUEE MAIS LOT ${batchId} NON FINALISE`,
        error,
      );
    }

    const { result, recomputeRequired } = application;

    this.logger.log(`${result.updated} ZONES D'ALERTES MISES A JOUR`);
    this.logger.log(`${result.added} ZONES D'ALERTES AJOUTEES`);
    this.logger.log(`${result.disabled} ZONES D'ALERTES DESACTIVEES`);

    try {
      await this.departementService.getAll();
    } catch (error) {
      this.logger.error(
        `SYNCHRONISATION SANDRE REUSSIE MAIS CACHE NON RAFRAICHI POUR LE DEPARTEMENT ${depCode}`,
        error,
      );
    }

    if (recomputeRequired) {
      try {
        await this.recomputeSandreDepartment(depCode);
      } catch (error) {
        this.logger.error(
          `SYNCHRONISATION SANDRE REUSSIE MAIS RECALCUL NON TERMINE POUR LE DEPARTEMENT ${depCode}`,
          error,
        );
      }
    }

    if (result.added > 0) {
      try {
        const arretesCadre =
          await this.arreteCadreService.findByDepartement(depCode);
        await this.mailService.sendEmailsByDepartement(
          depCode,
          `Vos nouvelles zones d’alerte ont été intégrées`,
          'maj_za',
          {
            arretesCadre,
          },
          true,
        );
      } catch (error) {
        this.logger.error(
          `SYNCHRONISATION SANDRE REUSSIE MAIS NOTIFICATION NON ENVOYEE POUR LE DEPARTEMENT ${depCode}`,
          error,
        );
      }
    }

    return result;
  }

  private async acquireSandreGlobalLock(): Promise<QueryRunner | null> {
    const queryRunner = this.dataSource.createQueryRunner();
    let connected = false;
    let lockAcquired = false;
    let operationError: unknown;
    try {
      await queryRunner.connect();
      connected = true;
      const [lock] = await queryRunner.query(
        "SELECT pg_try_advisory_lock(hashtext('vigieau'), hashtext('sandre-zone-sync')) AS locked",
      );
      if (lock?.locked !== true) {
        return null;
      }
      lockAcquired = true;
      return queryRunner;
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      if (connected && !lockAcquired) {
        try {
          await queryRunner.release();
        } catch (cleanupError) {
          if (!operationError) {
            throw cleanupError;
          }
          this.logger.error(
            'ERREUR LORS DE LA LIBERATION DE LA CONNEXION SANDRE',
            cleanupError,
          );
        }
      }
    }
  }

  private async releaseSandreGlobalLock(
    queryRunner: QueryRunner,
  ): Promise<void> {
    let cleanupError: unknown;
    try {
      const [unlock] = await queryRunner.query(
        "SELECT pg_advisory_unlock(hashtext('vigieau'), hashtext('sandre-zone-sync')) AS unlocked",
      );
      if (unlock?.unlocked !== true) {
        throw new Error('Unable to release the global Sandre lock');
      }
    } catch (error) {
      cleanupError = error;
      try {
        await queryRunner.query('SELECT pg_advisory_unlock_all()');
      } catch {
        // Releasing a broken connection is the final lock cleanup fallback.
      }
    }
    try {
      await queryRunner.release();
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError) {
      throw cleanupError;
    }
  }

  private async startSandreBatch(
    depCode: string,
    mode: Exclude<SandreZoneSyncMode, 'paused'>,
    startedAt: Date,
  ): Promise<string> {
    const [batch] = unwrapTypeOrmDmlReturningRows<{ id: string }>(
      await this.dataSource.query(
        `
        INSERT INTO sandre_zone_sync_batch (
          kind, mode, status, "startedAt", "departementId"
        )
        SELECT 'snapshot', $2, 'started', $3, departement.id
        FROM departement
        WHERE departement.code = $1
        RETURNING id
      `,
        [depCode, mode, startedAt],
      ),
    );
    if (!batch?.id) {
      throw new Error(`Unknown department ${depCode}`);
    }
    return String(batch.id);
  }

  private async finishSandreBatch(
    batchId: string,
    status: 'observed' | 'applied' | 'blocked' | 'failed',
    snapshot: SandreZoneSnapshot | null,
    error?: unknown,
  ): Promise<void> {
    await this.dataSource.query(
      `
        UPDATE sandre_zone_sync_batch
        SET
          status = $2,
          "snapshotHash" = $3,
          "sourceUpdatedAt" = $4,
          "featureCount" = $5,
          "failureReason" = $6,
          "finishedAt" = clock_timestamp()
        WHERE id = $1
      `,
      [
        batchId,
        status,
        snapshot?.snapshotHash ?? null,
        snapshot?.sourceUpdatedAt ?? null,
        snapshot?.featureCount ?? null,
        error ? this.sandreFailureReason(error) : null,
      ],
    );
  }

  private async recordSandreObservation(
    depCode: string,
    snapshot: SandreZoneSnapshot,
    observedAt: Date,
  ): Promise<void> {
    await this.dataSource.query(
      `
        INSERT INTO sandre_zone_sync_state (
          "departementId",
          "observedSourceUpdatedAt",
          "observedSnapshotHash",
          "observedLatestFeaturesHash",
          "observedFeatureCount",
          "lastObservedAt",
          "createdAt",
          "updatedAt"
        )
        SELECT
          departement.id, $2, $3, $4, $5, $6, now(), now()
        FROM departement
        WHERE departement.code = $1
        ON CONFLICT ("departementId") DO UPDATE
        SET
          "observedSourceUpdatedAt" = EXCLUDED."observedSourceUpdatedAt",
          "observedSnapshotHash" = EXCLUDED."observedSnapshotHash",
          "observedLatestFeaturesHash" = EXCLUDED."observedLatestFeaturesHash",
          "observedFeatureCount" = EXCLUDED."observedFeatureCount",
          "lastObservedAt" = EXCLUDED."lastObservedAt",
          "updatedAt" = now()
      `,
      [
        depCode,
        snapshot.sourceUpdatedAt,
        snapshot.snapshotHash,
        this.getLatestSandreFeaturesHash(snapshot),
        snapshot.featureCount,
        observedAt,
      ],
    );
  }

  private async markSandreDepartmentBlocked(
    depCode: string,
    snapshot: SandreZoneSnapshot,
    error: unknown,
  ): Promise<void> {
    await this.dataSource.query(
      `
        UPDATE sandre_zone_sync_state state
        SET
          "blockedAt" = clock_timestamp(),
          "blockedReason" = $2,
          "blockedSnapshotHash" = $3,
          "updatedAt" = now()
        FROM departement
        WHERE state."departementId" = departement.id
          AND departement.code = $1
      `,
      [depCode, this.sandreFailureReason(error), snapshot.snapshotHash],
    );
  }

  private createAuditDecisions(
    snapshot: SandreZoneSnapshot,
  ): SandreSyncDecisionDraft[] {
    return snapshot.features.map((feature) =>
      feature.status === SANDRE_VALID_STATUS
        ? {
            decisionKey: `${feature.codeSandre}:active`,
            zoneType: feature.type,
            sourceCode: feature.codeSandre,
            action: 'UPSERT_ACTIVE',
            outcome: 'observed',
            reason: 'AUDIT_MODE_NO_WRITE',
            evidence: {
              status: feature.status,
              payloadHash: feature.payloadHash,
            },
          }
        : {
            decisionKey: `${feature.codeSandre}:inactive`,
            zoneType: feature.type,
            sourceCode: feature.codeSandre,
            action: 'REVIEW_INACTIVE',
            outcome: 'deferred',
            reason: 'AUDIT_MODE_NO_WRITE',
            evidence: {
              status: feature.status,
              payloadHash: feature.payloadHash,
            },
          },
    );
  }

  private createBlockedDecisions(
    snapshot: SandreZoneSnapshot,
    error: unknown,
  ): SandreSyncDecisionDraft[] {
    const feature = snapshot.features[0];
    if (!feature) {
      return [];
    }
    return [
      {
        decisionKey: `department:${snapshot.snapshotHash}`,
        zoneType: feature.type,
        sourceCode: feature.codeSandre,
        action: 'BLOCK_DEPARTMENT',
        outcome: 'blocked',
        reason: 'DEPARTMENT_VALIDATION_FAILED',
        evidence: { error: this.sandreFailureReason(error) },
      },
    ];
  }

  private async persistSandreDecisions(
    executor: Pick<DataSource | EntityManager, 'query'>,
    depCode: string,
    batchId: string,
    decisions: SandreSyncDecisionDraft[],
  ): Promise<void> {
    if (decisions.length === 0) {
      return;
    }
    await executor.query(
      `
        INSERT INTO sandre_zone_sync_decision (
          "batchId", "departementId", "zoneAlerteId",
          "candidateZoneAlerteId", "decisionKey", "zoneType",
          "sourceCode", "targetCode", action, outcome, reason, evidence
        )
        SELECT
          $1::bigint,
          departement.id,
          decision."zoneAlerteId",
          decision."candidateZoneAlerteId",
          decision."decisionKey",
          decision."zoneType",
          decision."sourceCode",
          decision."targetCode",
          decision.action,
          decision.outcome,
          decision.reason,
          decision.evidence
        FROM departement
        CROSS JOIN jsonb_to_recordset($3::jsonb) AS decision(
          "zoneAlerteId" integer,
          "candidateZoneAlerteId" integer,
          "decisionKey" text,
          "zoneType" text,
          "sourceCode" text,
          "targetCode" text,
          action text,
          outcome text,
          reason text,
          evidence jsonb
        )
        WHERE departement.code = $2
        ON CONFLICT ("batchId", "decisionKey") DO NOTHING
      `,
      [batchId, depCode, JSON.stringify(decisions)],
    );
  }

  private sandreFailureReason(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(
      0,
      2000,
    );
  }

  private async hasSandreChanges(
    depCode: string,
    state: SandreZoneSyncState,
  ): Promise<boolean> {
    const observedFeatureCount =
      state.observedSnapshotHash === null ||
      state.observedSnapshotHash === undefined
        ? state.featureCount
        : state.observedFeatureCount;
    if (observedFeatureCount === 0) {
      return (await this.fetchSandreFeatureCount(depCode)) > 0;
    }
    const observedSourceUpdatedAt =
      state.observedSourceUpdatedAt ?? state.sourceUpdatedAt;
    const observedLatestFeaturesHash =
      state.observedLatestFeaturesHash ?? state.latestFeaturesHash;
    if (!observedSourceUpdatedAt || !observedLatestFeaturesHash) {
      return false;
    }

    const latestFeatures = await this.fetchSandreDepartmentSnapshot(
      depCode,
      observedSourceUpdatedAt,
      true,
    );
    return latestFeatures.snapshotHash !== observedLatestFeaturesHash;
  }

  private async fetchSandreFeatureCount(
    depCode: string,
    updatedAfter?: string,
    includeUpdateDate = false,
  ): Promise<number> {
    return (
      await this.fetchSandreDepartmentSnapshot(
        depCode,
        updatedAfter,
        includeUpdateDate,
      )
    ).featureCount;
  }

  async fetchSandreDepartmentSnapshot(
    depCode: string,
    updatedAfter?: string,
    includeUpdateDate = false,
  ): Promise<SandreZoneSnapshot> {
    return fetchSandreZoneSnapshot(
      this.configService.getOrThrow<string>('API_SANDRE'),
      depCode,
      {
        getJson: async (url) => {
          const { data } = await firstValueFrom(
            this.httpService.get(url, {
              timeout: SANDRE_HTTP_TIMEOUT_MS,
            }),
          );
          return data;
        },
        getText: async (url) => {
          const { data } = await firstValueFrom(
            this.httpService.get(url, {
              responseType: 'text',
              timeout: SANDRE_HTTP_TIMEOUT_MS,
            }),
          );
          return data;
        },
      },
      updatedAfter,
      includeUpdateDate,
    );
  }

  private async applySandreSnapshot(
    depCode: string,
    snapshot: SandreZoneSnapshot,
    snapshotStartedAt: Date,
    batchId: string | null = null,
  ): Promise<SandreSnapshotApplication> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const departementRepository =
        queryRunner.manager.getRepository(Departement);
      const stateRepository =
        queryRunner.manager.getRepository(SandreZoneSyncState);
      const departement = await departementRepository.findOne({
        where: { code: depCode },
      });
      if (!departement) {
        throw new Error(`Unknown department ${depCode}`);
      }
      await queryRunner.manager.query(
        "SELECT pg_advisory_xact_lock(hashtext('vigieau:sandre-zone-sync'), $1)",
        [departement.id],
      );

      let state = await stateRepository.findOne({
        where: {
          departement: {
            id: departement.id,
          },
        },
      });
      const now = new Date();
      const staleByStart =
        state?.snapshotStartedAt &&
        state.snapshotStartedAt.getTime() >= snapshotStartedAt.getTime();
      const appliedSourceUpdatedAt =
        state?.appliedSourceUpdatedAt ?? state?.sourceUpdatedAt;
      const staleBySourceDate =
        appliedSourceUpdatedAt &&
        snapshot.sourceUpdatedAt &&
        appliedSourceUpdatedAt > snapshot.sourceUpdatedAt;
      if (staleByStart || staleBySourceDate) {
        this.logger.warn(
          `INSTANTANE SANDRE IGNORE CAR PLUS ANCIEN POUR LE DEPARTEMENT ${depCode}`,
        );
        const decisions = snapshot.features.map(
          (feature): SandreSyncDecisionDraft => ({
            decisionKey: `${feature.codeSandre}:stale`,
            zoneType: feature.type,
            sourceCode: feature.codeSandre,
            action: 'IGNORE_SNAPSHOT',
            outcome: 'deferred',
            reason: 'STALE_SNAPSHOT',
          }),
        );
        if (batchId) {
          await this.persistSandreDecisions(
            queryRunner.manager,
            depCode,
            batchId,
            decisions,
          );
        }
        await queryRunner.commitTransaction();
        return {
          result: {
            added: 0,
            updated: 0,
            disabled: 0,
            unchanged: snapshot.featureCount,
          },
          recomputeRequired: false,
          decisions,
        };
      }

      const result: SandreSyncResult = {
        added: 0,
        updated: 0,
        disabled: 0,
        unchanged: 0,
      };
      const activeZoneIds = new Set<number>();
      const decisions: SandreSyncDecisionDraft[] = [];
      let recomputeRequired = false;
      const activeFeatures = snapshot.features.filter(
        (feature) => feature.status === SANDRE_VALID_STATUS,
      );
      const inactiveFeatures = snapshot.features.filter(
        (feature) => feature.status === 'Gelé',
      );
      await this.assertValidSandreGeometries(
        queryRunner.manager,
        activeFeatures,
      );

      const resolvedActiveFeatures: Array<{
        feature: SandreZoneFeature;
        match: SandreZoneMatch | null;
      }> = [];
      for (const feature of activeFeatures) {
        const match = await this.findSandreZoneMatch(
          queryRunner.manager,
          departement,
          feature,
        );
        if (match && activeZoneIds.has(match.zone.id)) {
          throw new Error(
            `Multiple active Sandre codes resolve to local zone ${match.zone.id}`,
          );
        }
        if (match) {
          activeZoneIds.add(match.zone.id);
        }
        resolvedActiveFeatures.push({ feature, match });
      }

      const resolvedInactiveFeatures: Array<{
        feature: SandreZoneFeature;
        match: SandreZoneMatch | null;
      }> = [];
      for (const feature of inactiveFeatures) {
        const match = await this.findSandreZoneMatch(
          queryRunner.manager,
          departement,
          feature,
        );
        resolvedInactiveFeatures.push({ feature, match });
      }

      const activeZonesByCode = new Map<string, ZoneAlerte>();
      for (const { feature, match } of resolvedActiveFeatures) {
        const countersBefore = { ...result };
        const upsert = await this.upsertActiveSandreZone(
          queryRunner.manager,
          departement,
          feature,
          match,
          result,
        );
        activeZoneIds.add(upsert.zone.id);
        activeZonesByCode.set(feature.codeSandre, upsert.zone);
        recomputeRequired ||= upsert.recomputeRequired;
        const reason =
          result.added > countersBefore.added
            ? 'ACTIVE_ZONE_CREATED'
            : result.updated > countersBefore.updated
              ? 'ACTIVE_ZONE_UPDATED'
              : 'ACTIVE_ZONE_UNCHANGED';
        decisions.push({
          decisionKey: `${feature.codeSandre}:active`,
          zoneType: feature.type,
          sourceCode: feature.codeSandre,
          zoneAlerteId: upsert.zone.id,
          action: 'UPSERT_ACTIVE',
          outcome: 'applied',
          reason,
          evidence: { matchType: match?.matchType ?? null },
        });
      }

      await this.reconcileOperationalFrozenZones(
        queryRunner.manager,
        departement,
        snapshot,
        resolvedInactiveFeatures,
        activeZoneIds,
        activeZonesByCode,
        decisions,
      );

      // A local zone is disabled only when Sandre explicitly returns it as frozen.
      for (const { feature, match } of resolvedInactiveFeatures) {
        if (!match || activeZoneIds.has(match.zone.id)) {
          result.unchanged++;
          decisions.push({
            decisionKey: `${feature.codeSandre}:inactive`,
            zoneType: feature.type,
            sourceCode: feature.codeSandre,
            zoneAlerteId: match?.zone.id ?? null,
            action: 'KEEP_ZONE_STATE',
            outcome: 'applied',
            reason: match
              ? 'ACTIVE_CANONICAL_MATCH_TAKES_PRECEDENCE'
              : 'INACTIVE_ZONE_NOT_LOCAL',
          });
          continue;
        }

        const zone = match.zone;
        const zoneWasActive = zone.disabled !== true;
        const changed =
          zoneWasActive ||
          zone.statutSandre !== feature.status ||
          zone.dateMajSandre !== feature.sourceUpdatedAt ||
          zone.sandrePayloadHash !== feature.payloadHash;
        if (!changed) {
          result.unchanged++;
          decisions.push({
            decisionKey: `${feature.codeSandre}:inactive`,
            zoneType: feature.type,
            sourceCode: feature.codeSandre,
            zoneAlerteId: zone.id,
            action: 'KEEP_ZONE_STATE',
            outcome: 'applied',
            reason: 'FROZEN_ZONE_UNCHANGED',
          });
          continue;
        }

        zone.disabled = true;
        zone.statutSandre = feature.status;
        zone.dateMajSandre = feature.sourceUpdatedAt;
        zone.codesAlternatifs = feature.alternateCodes;
        zone.sandrePayloadHash = feature.payloadHash;
        if (match.matchType === 'legacy_gid' && !zone.codeSandre) {
          zone.codeSandre = feature.codeSandre;
        }
        await queryRunner.manager.getRepository(ZoneAlerte).save(zone);
        result.disabled++;
        recomputeRequired ||= zoneWasActive;
        decisions.push({
          decisionKey: `${feature.codeSandre}:inactive`,
          zoneType: feature.type,
          sourceCode: feature.codeSandre,
          zoneAlerteId: zone.id,
          action: 'DISABLE_EXPLICITLY_FROZEN',
          outcome: 'applied',
          reason: 'EXPLICIT_SANDRE_FROZEN_STATUS',
        });
      }

      state ??= stateRepository.create({ departement });
      state.sourceUpdatedAt = snapshot.sourceUpdatedAt;
      state.snapshotHash = snapshot.snapshotHash;
      state.latestFeaturesHash = this.getLatestSandreFeaturesHash(snapshot);
      state.snapshotStartedAt = snapshotStartedAt;
      state.lastFullSyncAt = now;
      state.lastSuccessAt = now;
      state.featureCount = snapshot.featureCount;
      state.appliedSourceUpdatedAt = snapshot.sourceUpdatedAt;
      state.appliedSnapshotHash = snapshot.snapshotHash;
      state.appliedFeatureCount = snapshot.featureCount;
      state.lastAppliedAt = now;
      state.blockedAt = null;
      state.blockedReason = null;
      state.blockedSnapshotHash = null;
      state.needsRecompute = Boolean(state.needsRecompute) || recomputeRequired;
      if (recomputeRequired) {
        state.recomputeRevision = (state.recomputeRevision ?? 0) + 1;
      }
      await stateRepository.save(state);
      if (batchId) {
        await this.persistSandreDecisions(
          queryRunner.manager,
          depCode,
          batchId,
          decisions,
        );
      }
      await queryRunner.commitTransaction();

      return { result, recomputeRequired, decisions };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async getZoneReferenceCounts(
    manager: EntityManager,
    zoneAlerteId: number,
  ): Promise<ZoneReferenceCounts> {
    const rows =
      (await manager.query(
        `
          SELECT
            (
              SELECT count(*) FROM arrete_cadre_zone_alerte link
              WHERE link."zoneAlerteId" = $1
            )::integer AS "arreteCadre",
            (
              SELECT count(*)
              FROM arrete_cadre_zone_alerte link
              JOIN arrete_cadre ac ON ac.id = link."arreteCadreId"
              WHERE link."zoneAlerteId" = $1 AND ac.statut <> 'abroge'
            )::integer AS "nonAbrogeArreteCadre",
            (
              SELECT count(*)
              FROM restriction reference
              JOIN arrete_restriction ar
                ON ar.id = reference."arreteRestrictionId"
              WHERE reference."zoneAlerteId" = $1 AND ar.statut <> 'abroge'
            )::integer AS restrictions,
            (
              SELECT count(*)
              FROM arrete_cadre_zone_alerte_communes reference
              JOIN arrete_cadre ac ON ac.id = reference."arreteCadreId"
              WHERE reference."zoneAlerteId" = $1 AND ac.statut <> 'abroge'
            )::integer AS customizations
        `,
        [zoneAlerteId],
      )) ?? [];
    return {
      arreteCadre: Number(rows[0]?.arreteCadre ?? 0),
      nonAbrogeArreteCadre: Number(rows[0]?.nonAbrogeArreteCadre ?? 0),
      restrictions: Number(rows[0]?.restrictions ?? 0),
      customizations: Number(rows[0]?.customizations ?? 0),
    };
  }

  private async reconcileOperationalFrozenZones(
    manager: EntityManager,
    departement: Departement,
    snapshot: SandreZoneSnapshot,
    resolvedInactiveFeatures: Array<{
      feature: SandreZoneFeature;
      match: SandreZoneMatch | null;
    }>,
    activeZoneIds: Set<number>,
    activeZonesByCode: Map<string, ZoneAlerte>,
    decisions: SandreSyncDecisionDraft[],
  ): Promise<void> {
    const referencedSources: Array<{
      feature: SandreZoneFeature;
      zone: ZoneAlerte;
      references: ZoneReferenceCounts;
    }> = [];

    for (const { feature, match } of resolvedInactiveFeatures) {
      if (
        !match ||
        match.zone.disabled === true ||
        activeZoneIds.has(match.zone.id)
      ) {
        continue;
      }
      const references = await this.getZoneReferenceCounts(
        manager,
        match.zone.id,
      );
      const operationalReferenceCount =
        references.nonAbrogeArreteCadre +
        references.restrictions +
        references.customizations;
      if (operationalReferenceCount > 0) {
        referencedSources.push({ feature, zone: match.zone, references });
      }
    }

    if (referencedSources.length === 0) {
      return;
    }

    let relations: SandreGenealogyRelation[];
    try {
      relations = await this.getSandreGenealogyRelations();
    } catch (error) {
      throw new SandreDepartmentBlockedError(
        `Official Sandre genealogy is unavailable: ${this.sandreFailureReason(error)}`,
        referencedSources.map(({ feature, zone, references }) => ({
          decisionKey: `${feature.codeSandre}:reconciliation`,
          zoneType: feature.type,
          sourceCode: feature.codeSandre,
          zoneAlerteId: zone.id,
          action: 'RECONCILE_OFFICIAL_SUCCESSOR',
          outcome: 'blocked',
          reason: 'GENEALOGY_SOURCE_UNAVAILABLE',
          evidence: { references },
        })),
      );
    }

    const localZonesById = new Map<
      number,
      Parameters<typeof buildReconciliationResults>[2][number]
    >();
    const activeTargetsById = new Map<number, ZoneAlerte>();
    for (const [codeSandre, zone] of activeZonesByCode) {
      activeTargetsById.set(zone.id, zone);
      localZonesById.set(zone.id, {
        id: zone.id,
        idSandre: zone.idSandre ?? null,
        codeSandre,
        disabled: false,
        departmentId: departement.id,
        departmentCode: departement.code,
        type: zone.type as 'SOU' | 'SUP',
        sandrePayloadHash: zone.sandrePayloadHash ?? null,
      });
    }

    const referenceCounts = new Map<number, ZoneReferenceCounts>();
    for (const { feature, zone, references } of referencedSources) {
      localZonesById.set(zone.id, {
        id: zone.id,
        idSandre: zone.idSandre ?? feature.gid,
        codeSandre: zone.codeSandre ?? feature.codeSandre,
        // The official snapshot is authoritative for this transaction.
        disabled: true,
        departmentId: departement.id,
        departmentCode: departement.code,
        type: feature.type,
        sandrePayloadHash: zone.sandrePayloadHash ?? null,
      });
      referenceCounts.set(zone.id, references);
    }

    const officialZones = snapshot.features.map((feature) => ({
      code: feature.codeSandre,
      gid: feature.gid,
      status: feature.status,
      departmentCode: departement.code,
      type: feature.type,
      payloadHash: feature.payloadHash,
    }));
    const localZones = [...localZonesById.values()];
    const results = buildReconciliationResults(
      relations,
      officialZones,
      localZones,
      referenceCounts,
      { requireNonAbrogeArreteCadreReference: false },
    );
    const blockedResults = results.filter(
      (result) => result.status !== 'APPLICABLE',
    );
    if (blockedResults.length > 0) {
      throw new SandreDepartmentBlockedError(
        `Official Sandre reconciliation blocked for ${blockedResults.map((result) => `${result.oldCodeSandre}:${result.reason}`).join(', ')}`,
        results.map((result) => ({
          decisionKey: `${result.oldCodeSandre}:reconciliation`,
          zoneType: localZonesById.get(result.oldZoneId)?.type ?? 'SUP',
          sourceCode: result.oldCodeSandre,
          targetCode: result.newCodeSandre,
          zoneAlerteId: result.oldZoneId,
          candidateZoneAlerteId: result.newZoneId,
          action: 'RECONCILE_OFFICIAL_SUCCESSOR',
          outcome: result.status === 'APPLICABLE' ? 'deferred' : 'blocked',
          reason: result.reason,
          evidence: {
            genealogyPath: result.genealogyPath,
            references: result.references,
          },
        })),
      );
    }

    let mappings;
    try {
      mappings = mappingsFromResults(results, localZones);
    } catch (error) {
      throw new SandreDepartmentBlockedError(
        `Official Sandre reconciliation is not one-to-one: ${this.sandreFailureReason(error)}`,
        results.map((result) => ({
          decisionKey: `${result.oldCodeSandre}:reconciliation`,
          zoneType: localZonesById.get(result.oldZoneId)?.type ?? 'SUP',
          sourceCode: result.oldCodeSandre,
          targetCode: result.newCodeSandre,
          zoneAlerteId: result.oldZoneId,
          candidateZoneAlerteId: result.newZoneId,
          action: 'RECONCILE_OFFICIAL_SUCCESSOR',
          outcome: 'blocked',
          reason: 'NOT_STRICT_ONE_TO_ONE',
          evidence: { genealogyPath: result.genealogyPath },
        })),
      );
    }
    if (mappings.length !== referencedSources.length) {
      throw new SandreDepartmentBlockedError(
        'Official Sandre reconciliation did not cover every operational zone',
      );
    }

    const resultsByOldZoneId = new Map(
      results.map((result) => [result.oldZoneId, result]),
    );
    for (const mapping of mappings) {
      const target = activeTargetsById.get(mapping.newZoneId);
      if (!target) {
        throw new SandreDepartmentBlockedError(
          `Active Sandre successor ${mapping.newZoneId} disappeared during reconciliation`,
        );
      }
      await this.ensureSandreAlias(
        manager,
        departement,
        target,
        mapping.oldCodeSandre,
        'sandre_genealogy',
      );
      const reconciliation = resultsByOldZoneId.get(mapping.oldZoneId);
      decisions.push({
        decisionKey: `${mapping.oldCodeSandre}:reconciliation`,
        zoneType: mapping.zoneType,
        sourceCode: mapping.oldCodeSandre,
        targetCode: mapping.newCodeSandre,
        zoneAlerteId: mapping.oldZoneId,
        candidateZoneAlerteId: mapping.newZoneId,
        action: 'RECONCILE_OFFICIAL_SUCCESSOR',
        outcome: 'applied',
        reason: 'OFFICIAL_LINEAR_SUCCESSOR',
        evidence: { genealogyPath: reconciliation?.genealogyPath ?? [] },
      });
    }
  }

  private async getSandreGenealogyRelations(): Promise<
    SandreGenealogyRelation[]
  > {
    if (
      this.sandreGenealogyCache &&
      this.sandreGenealogyCache.expiresAt > Date.now()
    ) {
      return this.sandreGenealogyCache.relations;
    }
    if (!this.sandreGenealogyFetch) {
      this.sandreGenealogyFetch = this.fetchSandreGenealogyRelations().finally(
        () => {
          this.sandreGenealogyFetch = null;
        },
      );
    }
    const relations = await this.sandreGenealogyFetch;
    this.sandreGenealogyCache = {
      expiresAt: Date.now() + SANDRE_GENEALOGY_CACHE_MS,
      relations,
    };
    return relations;
  }

  private async fetchSandreGenealogyRelations(): Promise<
    SandreGenealogyRelation[]
  > {
    const { data: metadata } = await firstValueFrom(
      this.httpService.get(SANDRE_GENEALOGY_METADATA_URL, {
        responseType: 'text',
        timeout: SANDRE_HTTP_TIMEOUT_MS,
        maxContentLength: SANDRE_GENEALOGY_METADATA_MAX_BYTES,
        maxBodyLength: SANDRE_GENEALOGY_METADATA_MAX_BYTES,
      }),
    );
    const csvUrl = discoverGenealogyCsvUrl(
      String(metadata),
      SANDRE_GENEALOGY_METADATA_URL,
    );
    const { data: csv } = await firstValueFrom(
      this.httpService.get(csvUrl, {
        responseType: 'text',
        timeout: SANDRE_HTTP_TIMEOUT_MS,
        maxContentLength: SANDRE_GENEALOGY_CSV_MAX_BYTES,
        maxBodyLength: SANDRE_GENEALOGY_CSV_MAX_BYTES,
      }),
    );
    return parseGenealogyCsv(String(csv));
  }

  private getLatestSandreFeaturesHash(
    snapshot: SandreZoneSnapshot,
  ): string | null {
    if (!snapshot.sourceUpdatedAt) {
      return null;
    }
    return hashSandreZoneFeatures(
      snapshot.features.filter(
        (feature) => feature.sourceUpdatedAt === snapshot.sourceUpdatedAt,
      ),
    );
  }

  private async assertValidSandreGeometries(
    manager: EntityManager,
    features: SandreZoneFeature[],
  ): Promise<void> {
    if (features.length === 0) {
      return;
    }
    const invalidFeatures =
      (await manager.query(
        `
          WITH input AS (
            SELECT
              item->>'code' AS code,
              ST_SetSRID(
                ST_GeomFromGeoJSON((item->'geometry')::text),
                4326
              ) AS geom
            FROM jsonb_array_elements($1::jsonb) AS item
          )
          SELECT code
          FROM input
          WHERE ST_IsEmpty(geom)
            OR NOT ST_IsValid(geom)
            OR GeometryType(geom) NOT IN ('POLYGON', 'MULTIPOLYGON')
            OR ST_XMin(Box3D(geom)) < -180
            OR ST_XMax(Box3D(geom)) > 180
            OR ST_YMin(Box3D(geom)) < -90
            OR ST_YMax(Box3D(geom)) > 90
        `,
        [
          JSON.stringify(
            features.map((feature) => ({
              code: feature.codeSandre,
              geometry: feature.geometry,
            })),
          ),
        ],
      )) ?? [];
    if (invalidFeatures.length > 0) {
      throw new Error(
        `Invalid Sandre geometry for zone ${invalidFeatures[0].code}`,
      );
    }
  }

  private async findSandreZoneMatch(
    manager: EntityManager,
    departement: Departement,
    feature: SandreZoneFeature,
  ): Promise<SandreZoneMatch | null> {
    const zoneRepository = manager.getRepository(ZoneAlerte);
    const canonicalMatches = await zoneRepository.find({
      select: SANDRE_ZONE_SELECT,
      where: {
        codeSandre: feature.codeSandre,
      },
      relations: {
        bassinVersant: true,
        departement: true,
      },
      take: 2,
    });
    if (canonicalMatches.length > 1) {
      throw new Error(`Duplicate Sandre code ${feature.codeSandre}`);
    }
    if (canonicalMatches.length === 1) {
      this.assertSandreZoneScope(canonicalMatches[0], departement, feature);
      return {
        matchType: 'canonical',
        zone: canonicalMatches[0],
      };
    }

    const alias = await manager.getRepository(SandreZoneAlias).findOne({
      select: {
        id: true,
        zoneAlerte: SANDRE_ZONE_SELECT,
      },
      where: {
        departement: {
          id: departement.id,
        },
        zoneType: feature.type,
        aliasType: 'cd_zas',
        aliasValue: feature.codeSandre,
      },
      relations: {
        zoneAlerte: {
          bassinVersant: true,
          departement: true,
        },
      },
    });
    if (alias) {
      this.assertSandreZoneScope(alias.zoneAlerte, departement, feature);
      return {
        matchType: 'alias',
        zone: alias.zoneAlerte,
      };
    }

    const legacyMatches = await zoneRepository.find({
      select: SANDRE_ZONE_SELECT,
      where: {
        idSandre: feature.gid,
        codeSandre: IsNull(),
        departement: {
          id: departement.id,
        },
        type: feature.type,
      },
      relations: {
        bassinVersant: true,
        departement: true,
      },
      take: 2,
    });
    if (legacyMatches.length > 1) {
      throw new Error(
        `Duplicate legacy Sandre gid ${feature.gid} for department ${departement.code}`,
      );
    }

    return legacyMatches.length === 1
      ? {
          matchType: 'legacy_gid',
          zone: legacyMatches[0],
        }
      : null;
  }

  private assertSandreZoneScope(
    zone: ZoneAlerte,
    departement: Departement,
    feature: SandreZoneFeature,
  ): void {
    if (zone.departement?.id !== departement.id || zone.type !== feature.type) {
      throw new Error(
        `Sandre zone ${feature.codeSandre} conflicts with local zone ${zone.id}`,
      );
    }
  }

  private async upsertActiveSandreZone(
    manager: EntityManager,
    departement: Departement,
    feature: SandreZoneFeature,
    match: SandreZoneMatch | null,
    result: SandreSyncResult,
  ): Promise<{ zone: ZoneAlerte; recomputeRequired: boolean }> {
    const zoneRepository = manager.getRepository(ZoneAlerte);
    const bassinVersant = await manager.getRepository(BassinVersant).findOne({
      where: {
        code: feature.basinCode,
      },
    });
    if (!bassinVersant) {
      throw new Error(
        `Unknown basin ${feature.basinCode} for Sandre zone ${feature.codeSandre}`,
      );
    }

    const zone = match?.zone ?? zoneRepository.create();
    const isNew = !match;
    const displayCode =
      zone.code || feature.preferredAlternateCode || feature.codeSandre;
    const recomputeRequired =
      isNew ||
      zone.idSandre !== feature.gid ||
      zone.nom !== feature.name ||
      zone.type !== feature.type ||
      zone.ressourceInfluencee !== feature.influencedResource ||
      zone.disabled !== false ||
      zone.bassinVersant?.id !== bassinVersant.id ||
      !samePolygonGeometry(zone.geom, feature.geometry);
    const changed =
      isNew ||
      zone.idSandre !== feature.gid ||
      zone.codeSandre !== feature.codeSandre ||
      zone.nom !== feature.name ||
      zone.type !== feature.type ||
      zone.numeroVersionSandre !== feature.version ||
      zone.ressourceInfluencee !== feature.influencedResource ||
      zone.disabled !== false ||
      zone.statutSandre !== feature.status ||
      zone.dateMajSandre !== feature.sourceUpdatedAt ||
      zone.sandrePayloadHash !== feature.payloadHash ||
      zone.bassinVersant?.id !== bassinVersant.id ||
      !sameStringArrays(zone.codesAlternatifs, feature.alternateCodes) ||
      !samePolygonGeometry(zone.geom, feature.geometry);

    if (!changed) {
      result.unchanged++;
      return { zone, recomputeRequired: false };
    }

    if (
      match?.matchType === 'alias' &&
      zone.codeSandre &&
      zone.codeSandre !== feature.codeSandre
    ) {
      await this.ensureSandreAlias(
        manager,
        departement,
        zone,
        zone.codeSandre,
        'sandre_genealogy',
      );
    }

    zone.departement = departement;
    zone.bassinVersant = bassinVersant;
    zone.idSandre = feature.gid;
    zone.codeSandre = feature.codeSandre;
    zone.nom = feature.name;
    zone.code = displayCode;
    zone.type = feature.type;
    zone.numeroVersionSandre = feature.version;
    zone.geom = feature.geometry;
    zone.ressourceInfluencee = feature.influencedResource;
    zone.disabled = false;
    zone.statutSandre = feature.status;
    zone.dateMajSandre = feature.sourceUpdatedAt;
    zone.codesAlternatifs = feature.alternateCodes;
    zone.sandrePayloadHash = feature.payloadHash;

    const savedZone = await zoneRepository.save(zone);
    if (isNew) {
      result.added++;
    } else {
      result.updated++;
    }
    return { zone: savedZone, recomputeRequired };
  }

  private async ensureSandreAlias(
    manager: EntityManager,
    departement: Departement,
    zone: ZoneAlerte,
    aliasValue: string,
    source: 'sandre_genealogy' | 'manual_reconciliation',
  ): Promise<void> {
    const aliasRepository = manager.getRepository(SandreZoneAlias);
    const existingAlias = await aliasRepository.findOne({
      where: {
        departement: {
          id: departement.id,
        },
        zoneType: zone.type,
        aliasType: 'cd_zas',
        aliasValue,
      },
      relations: {
        zoneAlerte: true,
      },
    });
    if (existingAlias?.zoneAlerte.id === zone.id) {
      return;
    }
    if (existingAlias) {
      throw new Error(
        `Sandre alias ${aliasValue} is already assigned to zone ${existingAlias.zoneAlerte.id}`,
      );
    }

    await aliasRepository.save(
      aliasRepository.create({
        departement,
        zoneAlerte: zone,
        zoneType: zone.type,
        aliasType: 'cd_zas',
        aliasValue,
        source,
      }),
    );
  }

  private async recomputeSandreDepartment(depCode: string): Promise<void> {
    const departement = await this.dataSource
      .getRepository(Departement)
      .findOne({ where: { code: depCode } });
    if (!departement) {
      throw new Error(`Unknown department ${depCode}`);
    }

    const state = await this.dataSource
      .getRepository(SandreZoneSyncState)
      .findOne({
        where: {
          departement: {
            id: departement.id,
          },
        },
      });
    if (!state?.needsRecompute) {
      return;
    }
    const recomputeRevision = state.recomputeRevision ?? 0;
    const result = await this.runCurrentZoneComputeWorker([departement.id]);
    if (result?.success !== true) {
      throw new Error(result?.error || 'Zone recomputation did not complete');
    }

    await this.dataSource.query(
      `
        UPDATE sandre_zone_sync_state
        SET "needsRecompute" = false, "updatedAt" = now()
        WHERE "departementId" = $1
          AND "recomputeRevision" = $2
          AND "needsRecompute" = true
      `,
      [departement.id, recomputeRevision],
    );
  }

  private runCurrentZoneComputeWorker(departmentIds: number[]) {
    return runCurrentZoneComputeWorker(departmentIds);
  }

  async getZonesArea(zones: any[]) {
    return this.zoneAlerteRepository
      .createQueryBuilder('zone_alerte')
      .select(
        'SUM(ST_Area(ST_TRANSFORM(zone_alerte.geom, 4326)::geography)/1000000)',
        'area',
      )
      .where('zone_alerte.id IN(:...ids)', { ids: zones.map((z) => z.id) })
      .getRawOne();
  }

  getZonesIntersectedWithCommune(zones: ZoneAlerte[], communeId: number) {
    return (
      this.zoneAlerteRepository
        .createQueryBuilder('zone_alerte')
        .select('zone_alerte.id', 'id')
        .addSelect('zone_alerte.code', 'code')
        .addSelect('zone_alerte.nom', 'nom')
        .addSelect('zone_alerte.type', 'type')
        .where('zone_alerte.id IN(:...zonesId)', {
          zonesId: zones.map((z) => z.id),
        })
        .andWhere(
          `ST_GeometryType(zone_alerte.geom) IN ('ST_Polygon', 'ST_MultiPolygon')`,
        )
        .andWhere(
          'ST_INTERSECTS(ST_TRANSFORM(zone_alerte.geom, 4326), (SELECT ST_TRANSFORM(c.geom, 4326) FROM commune as c WHERE c.id = :communeId))',
          { communeId },
        )
        // Au moins 1% de la surface en commun
        .andWhere(
          'ST_Area(ST_Intersection(ST_TRANSFORM(zone_alerte.geom, 4326), (SELECT ST_TRANSFORM(c.geom, 4326) FROM commune as c WHERE c.id = :communeId))) / ST_Area((SELECT ST_TRANSFORM(c.geom, 4326) FROM commune as c WHERE c.id = :communeId)) > 0.01',
          { communeId },
        )
        .getRawMany()
    );
  }

  async getUnionGeomOfZoneAndCommunes(
    zoneId: number,
    communesId: number[],
  ): Promise<any> {
    const result = await this.dataSource.query(
      `
        SELECT ST_AsGeoJSON(ST_Union(zone.geom, communes.geom)) AS combined_geom
        FROM (
            SELECT ST_TRANSFORM(geom, 4326) AS geom
            FROM zone_alerte
            WHERE id = $1
        ) AS zone,
        (
            SELECT ST_Union(ST_TRANSFORM(geom, 4326)) AS geom
            FROM commune
            WHERE id = ANY($2)
        ) AS communes;
        `,
      [zoneId, communesId],
    );

    return result[0]?.combined_geom;
  }
}
