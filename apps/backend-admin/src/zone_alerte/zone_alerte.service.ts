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
  Not,
  Repository,
  QueryRunner,
} from 'typeorm';
import { isMainThread } from 'worker_threads';
import { ArreteCadreService } from '../arrete_cadre/arrete_cadre.service';
import { BassinVersantService } from '../bassin_versant/bassin_versant.service';
import { BusinessCron } from '../core/scheduling/business-cron';
import { invalidateHistoricComputationsFromWithManager } from '../config/historic-computation-invalidation';
import { DepartementService } from '../departement/departement.service';
import { RegleauLogger } from '../logger/regleau.logger';
import { getCurrentParisCivilDate } from '../shared/arrete-date-continuity';
import { MailService } from '../shared/services/mail.service';
import { runCurrentZoneComputeWorker } from '../worker_threads/run-current-zone-compute';
import { recordPublicMutation } from '../zone_publication/public-mutation';
import { unwrapTypeOrmDmlReturningRows } from '../zone_publication/typeorm-query-result';
import {
  buildReconciliationResults,
  discoverGenealogyCsvUrl,
  mappingsFromResults,
  parseGenealogyCsv,
  ReconciliationMapping,
  SANDRE_GENEALOGY_METADATA_URL,
  SANDRE_GENEALOGY_REQUEST_HEADERS,
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
  parseSandreForceFullAuditAfter,
  parseSandreZoneSyncMode,
  SandreDepartmentBlockedError,
  SandreOperatorStatus,
  SandreSyncDecisionDraft,
  SandreZoneSyncMode,
} from './sandre-zone-governance';
import {
  normalizeSandreZoneGeometries,
  SandreGeometryAudit,
} from './sandre-zone-geometry';
import {
  fetchSandreMdmNomenclatureEvidence,
  fetchSandreMdmZoneRecordEvidence,
  loadSandreMdmProofWithRetry,
  SandreMdmNomenclatureEvidence,
  SandreMdmProofBudget,
  SandreMdmProofDeadlineExceededError,
  SandreMdmTransportResponse,
  SandreMdmTransientError,
  SandreMdmZoneRecordEvidence,
} from './sandre-mdm-evidence';
import {
  applySandreApprovedPartitionReferences,
  assertSandreApprovedOneToOneApplied,
  loadSandreApprovedReferenceEvidence,
  lockSandreApprovedSyncReferences,
  parseSandreApprovedReferenceEvidence,
  SandreApprovedReferenceEvidence,
} from './sandre-zone-sync-approved-references';
import {
  assertSandreApprovedMaterializedTargets,
  auditSandreApprovedSyncGeometry,
  findSandreApprovedSyncSnapshot,
  SandreApprovedSyncSnapshot,
} from './sandre-zone-sync-approvals';
import { fingerprint } from './sandre-zone-reconciliation';

const SANDRE_FULL_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SANDRE_HTTP_TIMEOUT_MS = 30 * 1000;
const SANDRE_GENEALOGY_CACHE_MS = 10 * 60 * 1000;
const SANDRE_GENEALOGY_METADATA_MAX_BYTES = 1024 * 1024;
const SANDRE_GENEALOGY_CSV_MAX_BYTES = 20 * 1024 * 1024;
const SANDRE_MDM_REQUEST_ATTEMPTS = 3;
const SANDRE_MDM_REQUEST_TIMEOUT_MS = 60_000;
const SANDRE_MDM_REQUEST_RETRY_BASE_MS = 250;
const SANDRE_MDM_PROOF_RETRY_BASE_MS = 2_000;
const SANDRE_MDM_PROOF_RETRY_MAX_MS = 10_000;
const SANDRE_MDM_TRANSIENT_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const SANDRE_VALID_STATUS = 'Validé';
const SANDRE_ZONE_SELECT = {
  id: true,
  idSandre: true,
  codeSandre: true,
  statutSandre: true,
  dateMajSandre: true,
  codesAlternatifs: true,
  sandrePayloadHash: true,
  sandreProvenance: true,
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

interface SandreRolloutAuditCoverage {
  observedDepartmentIds: Set<number>;
  attemptedDepartmentIds: Set<number>;
}

interface SandreSnapshotPreflight {
  departement: Departement;
  resolvedActiveFeatures: Array<{
    feature: SandreZoneFeature;
    match: SandreZoneMatch | null;
    bassinVersant: BassinVersant;
    basinResolution: SandreBasinResolution;
    geometryAudit: SandreGeometryAudit;
  }>;
  resolvedInactiveFeatures: Array<{
    feature: SandreZoneFeature;
    match: SandreZoneMatch | null;
  }>;
  activeZoneIds: Set<number>;
}

interface SandreBasinResolution {
  officialBasinCode: number;
  localBasinCode: number;
  mappingSource: string;
  mapped: boolean;
}

interface SandreSnapshotApplication {
  result: SandreSyncResult;
  recomputeRequired: boolean;
  decisions: SandreSyncDecisionDraft[];
  stale: boolean;
}

interface SandreApprovedAuditEvidence {
  batchId: string;
  decisions: Map<string, Record<string, unknown>>;
}

interface SandreApprovedMdmEvidence {
  approvalId: string;
  zoneRecords: SandreMdmZoneRecordEvidence[];
  nomenclature: SandreMdmNomenclatureEvidence | null;
}

interface SandreApprovedMdmEvidenceAccumulator {
  zoneRecords: Array<SandreMdmZoneRecordEvidence | undefined>;
  nomenclature: SandreMdmNomenclatureEvidence | null | undefined;
}

interface SandreApprovedSourceIdentityEvidence {
  matchType: 'canonical' | 'legacy_gid';
  idSandre: number;
  codeSandre: string | null;
  provenance: 'official' | 'legacy_unverified';
  disabled: boolean;
  statutSandre: string | null;
  dateMajSandre: string | null;
  numeroVersionSandre: number | null;
  sandrePayloadHash: string | null;
}

interface OperationalDisabledZoneSource {
  id: number;
  idSandre: number | null;
  codeSandre: string | null;
  legacyCode: string;
  type: 'SOU' | 'SUP';
}

interface ReferencedFrozenSandreSource {
  feature: SandreZoneFeature;
  matchType: SandreZoneMatch['matchType'];
  zone: ZoneAlerte;
  references: ZoneReferenceInventory;
  operationalReferenceCount: number;
}

interface ZoneReferenceInventory extends ZoneReferenceCounts {
  allRestrictions: number;
  allCustomizations: number;
}

type SandreGenealogyLoad =
  | { relations: SandreGenealogyRelation[]; error?: never }
  | { relations?: never; error: unknown };

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

    za.arreteCadreZoneAlerteCommunes = [];
    if (acIds?.length) {
      za.arreteCadreZoneAlerteCommunes = (
        await this.zoneAlerteRepository
          .createQueryBuilder('zone_alerte')
          .select(['zone_alerte.id'])
          .addSelect(['aczac.id', 'communes.id'])
          .leftJoin(
            'zone_alerte.arreteCadreZoneAlerteCommunes',
            'aczac',
            'aczac.arreteCadreId IN(:...acIds)',
            { acIds },
          )
          .leftJoin('aczac.communes', 'communes')
          .where('zone_alerte.id = :id', { id })
          .getOne()
      ).arreteCadreZoneAlerteCommunes;
    }

    return za;
  }

  async findGeometriesByIds(
    ids: readonly number[],
  ): Promise<ReadonlyMap<number, string>> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) {
      return new Map();
    }

    const rows: Array<{ id: number; geom: string | null }> =
      await this.dataSource.query(
        `
          WITH transformed AS MATERIALIZED (
            SELECT
              zone.id,
              ST_Transform(zone.geom, 4326) AS geom
            FROM "zone_alerte" zone
            WHERE zone.id = ANY($1::int[])
          ), normalized AS MATERIALIZED (
            SELECT
              transformed.id,
              CASE
                WHEN ST_IsValid(transformed.geom, 0) THEN transformed.geom
                ELSE ST_CollectionExtract(
                  ST_MakeValid(
                    transformed.geom,
                    'method=structure keepcollapsed=false'
                  ),
                  3
                )
              END AS geom
            FROM transformed
          )
          SELECT
            normalized.id AS "id",
            CASE
              WHEN normalized.geom IS NULL
                OR ST_IsEmpty(normalized.geom)
                OR ST_GeometryType(normalized.geom) NOT IN ('ST_Polygon', 'ST_MultiPolygon')
                OR NOT ST_IsValid(normalized.geom, 0)
              THEN NULL
              ELSE ST_AsGeoJSON(normalized.geom)
            END AS "geom"
          FROM normalized
          ORDER BY normalized.id
        `,
        [uniqueIds],
      );
    const geometries = new Map<number, string>();
    for (const row of rows) {
      if (row.geom) {
        geometries.set(Number(row.id), row.geom);
      }
    }

    const missingIds = uniqueIds.filter((id) => !geometries.has(id));
    if (missingIds.length > 0) {
      throw new Error(
        `Missing geometry for alert zone(s): ${missingIds.join(', ')}`,
      );
    }
    return geometries;
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
    const forceFullAuditAfter = this.getRequiredSandreAuditCutoff(syncMode);
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
      const auditCoverage =
        await this.getRolloutAuditCoverage(forceFullAuditAfter);
      if (syncMode === 'safe') {
        this.assertSafeRolloutAuditComplete(
          departements,
          auditCoverage.observedDepartmentIds,
        );
      }

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
          const forcedAuditDue =
            syncMode === 'audit' &&
            !auditCoverage.attemptedDepartmentIds.has(d.id);
          const blockedRetryDue = isSandreBlockedRetryDue(state?.blockedAt);
          const applicationPending =
            syncMode === 'safe' &&
            (!state?.lastAppliedAt ||
              state.observedSnapshotHash !== state.appliedSnapshotHash ||
              state.observedSourceUpdatedAt !== state.appliedSourceUpdatedAt);
          const sourceChanged =
            !fullSyncExpired &&
            !forcedAuditDue &&
            !blockedRetryDue &&
            !applicationPending &&
            (await this.hasSandreChanges(d.code, state));

          if (
            fullSyncExpired ||
            forcedAuditDue ||
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
    const forceFullAuditAfter = this.getRequiredSandreAuditCutoff(syncMode);

    if (this.sandreGlobalLockHeld) {
      return this.updateDepartementZonesWithMode(depCode, syncMode);
    }
    const globalLock = await this.acquireSandreGlobalLock();
    if (!globalLock) {
      throw new Error('Another Sandre synchronization is already running');
    }
    let operationError: unknown;
    try {
      if (syncMode === 'safe') {
        const departements = await this.departementService.findAllLight();
        const auditCoverage =
          await this.getRolloutAuditCoverage(forceFullAuditAfter);
        this.assertSafeRolloutAuditComplete(
          departements,
          auditCoverage.observedDepartmentIds,
        );
      }
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
    if (syncMode === 'audit') {
      await this.recordSandreObservation(depCode, snapshot, startedAt);
      try {
        const approvedSnapshot = findSandreApprovedSyncSnapshot(
          depCode,
          snapshot,
        );
        const approvedMdmEvidence = approvedSnapshot
          ? await this.fetchApprovedSandreMdmEvidence(approvedSnapshot)
          : undefined;
        const preflight = await this.createSandreSnapshotPreflight(
          this.dataSource.manager,
          depCode,
          snapshot,
        );
        const decisions = await this.createAuditDecisions(
          snapshot,
          preflight,
          approvedMdmEvidence,
        );
        await this.persistSandreDecisions(
          this.dataSource,
          depCode,
          batchId,
          decisions,
        );
        await this.clearSandreDepartmentBlocked(depCode);
        await this.finishSandreBatch(batchId, 'observed', snapshot);
        return {
          added: 0,
          updated: 0,
          disabled: 0,
          unchanged: snapshot.featureCount,
        };
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
    }

    let application: SandreSnapshotApplication;
    try {
      const approvedSnapshot = findSandreApprovedSyncSnapshot(
        depCode,
        snapshot,
      );
      const approvedMdmEvidence = approvedSnapshot
        ? await this.fetchApprovedSandreMdmEvidence(approvedSnapshot)
        : undefined;
      application = await this.applySandreSnapshot(
        depCode,
        snapshot,
        startedAt,
        batchId,
        approvedMdmEvidence,
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
      await this.finishSandreBatch(
        batchId,
        application.stale ? 'observed' : 'applied',
        snapshot,
      );
    } catch (error) {
      this.logger.error(
        `SYNCHRONISATION SANDRE ${application.stale ? 'IGNOREE' : 'APPLIQUEE'} MAIS LOT ${batchId} NON FINALISE`,
        error,
      );
    }

    const { result, recomputeRequired } = application;
    if (application.stale) {
      return result;
    }

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

  private getRequiredSandreAuditCutoff(
    syncMode: Exclude<SandreZoneSyncMode, 'paused'>,
  ): Date {
    const cutoff = parseSandreForceFullAuditAfter(
      this.configService.get<string>('SANDRE_FORCE_FULL_AUDIT_AFTER'),
    );
    if (!cutoff) {
      throw new Error(
        `SANDRE_FORCE_FULL_AUDIT_AFTER is required in ${syncMode} mode`,
      );
    }
    return cutoff;
  }

  private async getRolloutAuditCoverage(
    forceFullAuditAfter: Date,
  ): Promise<SandreRolloutAuditCoverage> {
    const rows = await this.dataSource.query(
      `
        SELECT latest."departementId", latest.status
        FROM (
          SELECT DISTINCT ON (batch."departementId")
            batch."departementId", batch.status
          FROM sandre_zone_sync_batch batch
          WHERE batch.kind = 'snapshot'
            AND batch.mode = 'audit'
            AND batch."startedAt" >= $1
          ORDER BY batch."departementId", batch."startedAt" DESC, batch.id DESC
        ) latest
      `,
      [forceFullAuditAfter],
    );
    const observedDepartmentIds = new Set<number>();
    const attemptedDepartmentIds = new Set<number>();
    for (const row of rows) {
      const id = Number(row.departementId);
      if (!Number.isInteger(id)) {
        continue;
      }
      if (row.status === 'observed') {
        observedDepartmentIds.add(id);
        attemptedDepartmentIds.add(id);
      } else if (row.status === 'blocked') {
        attemptedDepartmentIds.add(id);
      }
    }
    return { observedDepartmentIds, attemptedDepartmentIds };
  }

  private async loadExactSandreAuditEvidenceForSafe(
    manager: EntityManager,
    departmentId: number,
    snapshot: SandreZoneSnapshot,
    cutoff: Date,
  ): Promise<SandreApprovedAuditEvidence> {
    const [batch] = await manager.query(
      `
        SELECT
          batch.id,
          batch.status,
          batch."snapshotHash",
          batch."sourceUpdatedAt"::text AS "sourceUpdatedAt",
          batch."featureCount"
        FROM sandre_zone_sync_batch batch
        WHERE batch."departementId" = $1
          AND batch.kind = 'snapshot'
          AND batch.mode = 'audit'
          AND batch."startedAt" >= $2
        ORDER BY batch."startedAt" DESC, batch.id DESC
        LIMIT 1
        FOR SHARE
      `,
      [departmentId, cutoff],
    );
    if (
      !batch ||
      batch.status !== 'observed' ||
      batch.snapshotHash !== snapshot.snapshotHash ||
      batch.sourceUpdatedAt !== snapshot.sourceUpdatedAt ||
      Number(batch.featureCount) !== snapshot.featureCount
    ) {
      throw new Error(
        'SANDRE safe mode requires a successful exact-snapshot audit',
      );
    }
    const rows = await manager.query(
      `
        SELECT "decisionKey", evidence
        FROM sandre_zone_sync_decision
        WHERE "batchId" = $1
        ORDER BY "decisionKey"
      `,
      [batch.id],
    );
    return {
      batchId: String(batch.id),
      decisions: new Map(
        rows.map((row) => [
          String(row.decisionKey),
          (row.evidence ?? {}) as Record<string, unknown>,
        ]),
      ),
    };
  }

  private assertSafeRolloutAuditComplete(
    departements: Array<{ id: number; code: string }>,
    observedDepartmentIds: Set<number>,
  ): void {
    const missingDepartments = departements.filter(
      (departement) => !observedDepartmentIds.has(departement.id),
    );
    if (missingDepartments.length > 0) {
      throw new Error(
        `SANDRE safe mode requires a successful rollout audit for every department; missing ${missingDepartments
          .map((departement) => departement.code)
          .join(', ')}`,
      );
    }
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

  private async clearSandreDepartmentBlocked(depCode: string): Promise<void> {
    await this.dataSource.query(
      `
        UPDATE sandre_zone_sync_state state
        SET
          "blockedAt" = NULL,
          "blockedReason" = NULL,
          "blockedSnapshotHash" = NULL,
          "updatedAt" = now()
        FROM departement
        WHERE state."departementId" = departement.id
          AND departement.code = $1
          AND state."blockedAt" IS NOT NULL
      `,
      [depCode],
    );
  }

  private async createSandreSnapshotPreflight(
    manager: EntityManager,
    depCode: string,
    snapshot: SandreZoneSnapshot,
    lockedDepartement?: Departement,
  ): Promise<SandreSnapshotPreflight> {
    const departement =
      lockedDepartement ??
      (await manager.getRepository(Departement).findOne({
        where: { code: depCode },
      }));
    if (!departement) {
      throw new Error(`Unknown department ${depCode}`);
    }

    const rawActiveFeatures = snapshot.features.filter(
      (feature) => feature.status === SANDRE_VALID_STATUS,
    );
    const normalizedGeometry = await normalizeSandreZoneGeometries(
      manager,
      rawActiveFeatures,
      {
        departmentCode: depCode,
        snapshotHash: snapshot.snapshotHash,
        sourceUpdatedAt: snapshot.sourceUpdatedAt,
        featureCount: snapshot.featureCount,
      },
    );
    const activeFeatures = normalizedGeometry.features;

    const basinRepository = manager.getRepository(BassinVersant);
    const basinsByCode = new Map<
      number,
      { bassinVersant: BassinVersant; resolution: SandreBasinResolution }
    >();
    for (const feature of activeFeatures) {
      if (basinsByCode.has(feature.basinCode)) {
        continue;
      }
      const [mapping] = await manager.query(
        `
          SELECT "localBasinCode", source
          FROM sandre_basin_mapping
          WHERE "officialBasinCode" = $1
        `,
        [feature.basinCode],
      );
      const localBasinCode = mapping
        ? Number(mapping.localBasinCode)
        : feature.basinCode;
      const basinCandidates = await basinRepository.find({
        where: { code: localBasinCode },
        order: { id: 'ASC' },
        take: 2,
      });
      if (basinCandidates.length !== 1) {
        throw new Error(
          `Expected one local basin ${localBasinCode}, found ${basinCandidates.length}, ` +
            `for Sandre basin ${feature.basinCode} ` +
            `and zone ${feature.codeSandre}`,
        );
      }
      const [bassinVersant] = basinCandidates;
      basinsByCode.set(feature.basinCode, {
        bassinVersant,
        resolution: {
          officialBasinCode: feature.basinCode,
          localBasinCode,
          mappingSource: mapping?.source ?? 'identity',
          mapped: localBasinCode !== feature.basinCode,
        },
      });
    }

    const activeZoneIds = new Set<number>();
    const resolvedActiveFeatures: SandreSnapshotPreflight['resolvedActiveFeatures'] =
      [];
    for (const feature of activeFeatures) {
      const { bassinVersant, resolution: basinResolution } = basinsByCode.get(
        feature.basinCode,
      )!;
      const geometryAudit = normalizedGeometry.audits.get(feature.codeSandre)!;
      const match = await this.findSandreZoneMatch(
        manager,
        departement,
        feature,
      );
      if (!match) {
        resolvedActiveFeatures.push({
          feature,
          match,
          bassinVersant,
          basinResolution,
          geometryAudit,
        });
        continue;
      }
      if (activeZoneIds.has(match.zone.id)) {
        throw new Error(
          `Multiple active Sandre codes resolve to local zone ${match.zone.id}`,
        );
      }
      activeZoneIds.add(match.zone.id);
      if (
        match.matchType === 'alias' &&
        match.zone.codeSandre &&
        match.zone.codeSandre !== feature.codeSandre
      ) {
        await this.assertSandreAliasAvailable(
          manager,
          departement,
          match.zone,
          match.zone.codeSandre,
        );
      }
      resolvedActiveFeatures.push({
        feature,
        match,
        bassinVersant,
        basinResolution,
        geometryAudit,
      });
    }

    const resolvedInactiveFeatures: SandreSnapshotPreflight['resolvedInactiveFeatures'] =
      [];
    for (const feature of snapshot.features.filter(
      (item) => item.status === 'Gelé',
    )) {
      resolvedInactiveFeatures.push({
        feature,
        match: await this.findSandreZoneMatch(manager, departement, feature),
      });
    }

    return {
      departement,
      resolvedActiveFeatures,
      resolvedInactiveFeatures,
      activeZoneIds,
    };
  }

  private async assertSandreAliasAvailable(
    manager: EntityManager,
    departement: Departement,
    zone: ZoneAlerte,
    aliasValue: string,
  ): Promise<void> {
    const existingAlias = await manager.getRepository(SandreZoneAlias).findOne({
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
    if (existingAlias && existingAlias.zoneAlerte.id !== zone.id) {
      throw new Error(
        `Sandre alias ${aliasValue} is already assigned to zone ${existingAlias.zoneAlerte.id}`,
      );
    }
  }

  private async createAuditDecisions(
    snapshot: SandreZoneSnapshot,
    preflight: SandreSnapshotPreflight,
    approvedMdmEvidence?: SandreApprovedMdmEvidence,
  ): Promise<SandreSyncDecisionDraft[]> {
    const decisions: SandreSyncDecisionDraft[] = snapshot.features.map(
      (feature) =>
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
    const decisionsByKey = new Map(
      decisions.map((decision) => [decision.decisionKey, decision]),
    );

    const manager = this.dataSource.manager;
    const { departement, resolvedInactiveFeatures } = preflight;
    const activeZoneIds = new Set(preflight.activeZoneIds);
    const activeZonesByCode = new Map<string, ZoneAlerte>();
    let virtualZoneId = -1;
    for (const {
      feature,
      match,
      basinResolution,
      geometryAudit,
    } of preflight.resolvedActiveFeatures) {
      const decision = decisionsByKey.get(`${feature.codeSandre}:active`);
      if (decision) {
        decision.zoneAlerteId = match?.zone.id ?? null;
        decision.evidence = {
          ...decision.evidence,
          matchType: match?.matchType ?? null,
          basinResolution,
          geometry: geometryAudit,
        };
      }
      activeZonesByCode.set(
        feature.codeSandre,
        match?.zone ??
          ({
            id: virtualZoneId--,
            idSandre: feature.gid,
            codeSandre: feature.codeSandre,
            disabled: false,
            type: feature.type,
            departement,
          } as ZoneAlerte),
      );
    }

    for (const { feature, match } of resolvedInactiveFeatures) {
      const decision = decisionsByKey.get(`${feature.codeSandre}:inactive`);
      if (decision) {
        decision.zoneAlerteId = match?.zone.id ?? null;
        decision.evidence = {
          ...decision.evidence,
          matchType: match?.matchType ?? null,
        };
      }
    }

    try {
      await this.reconcileOperationalFrozenZones(
        manager,
        departement,
        snapshot,
        resolvedInactiveFeatures,
        activeZoneIds,
        activeZonesByCode,
        decisions,
        false,
        undefined,
        undefined,
        undefined,
        approvedMdmEvidence,
      );
    } catch (error) {
      if (error instanceof SandreDepartmentBlockedError) {
        throw new SandreDepartmentBlockedError(error.reason, [
          ...decisions,
          ...error.decisions,
        ]);
      }
      throw error;
    }
    return decisions;
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
    approvedMdmEvidence?: SandreApprovedMdmEvidence,
  ): Promise<SandreSnapshotApplication> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

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
          stale: true,
        };
      }

      const approvedAuditEvidence =
        await this.loadExactSandreAuditEvidenceForSafe(
          queryRunner.manager,
          departement.id,
          snapshot,
          this.getRequiredSandreAuditCutoff('safe'),
        );

      const result: SandreSyncResult = {
        added: 0,
        updated: 0,
        disabled: 0,
        unchanged: 0,
      };
      const decisions: SandreSyncDecisionDraft[] = [];
      let recomputeRequired = false;
      const preflight = await this.createSandreSnapshotPreflight(
        queryRunner.manager,
        depCode,
        snapshot,
        departement,
      );
      const {
        activeZoneIds,
        resolvedActiveFeatures,
        resolvedInactiveFeatures,
      } = preflight;

      let genealogyLoad: SandreGenealogyLoad | undefined;
      if (
        resolvedInactiveFeatures.some(
          ({ match }) => match && !activeZoneIds.has(match.zone.id),
        )
      ) {
        try {
          genealogyLoad = {
            relations: await this.getSandreGenealogyRelations(),
          };
        } catch (error) {
          genealogyLoad = { error };
        }
      }

      const operationalDisabledSources =
        await this.getOperationalDisabledZoneSources(
          queryRunner.manager,
          departement.id,
        );
      await this.lockOperationalParentsForSandreSources(queryRunner.manager, [
        ...resolvedInactiveFeatures.flatMap(({ match }) =>
          match ? [match.zone.id] : [],
        ),
        ...operationalDisabledSources.map((source) => source.id),
      ]);

      const activeZonesByCode = new Map<string, ZoneAlerte>();
      for (const {
        feature,
        match,
        bassinVersant,
        basinResolution,
        geometryAudit,
      } of resolvedActiveFeatures) {
        const countersBefore = { ...result };
        const upsert = await this.upsertActiveSandreZone(
          queryRunner.manager,
          departement,
          feature,
          match,
          bassinVersant,
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
          evidence: {
            matchType: match?.matchType ?? null,
            basinResolution,
            geometry: geometryAudit,
          },
        });
      }

      const operationalReferencesReconciled =
        await this.reconcileOperationalFrozenZones(
          queryRunner.manager,
          departement,
          snapshot,
          resolvedInactiveFeatures,
          activeZoneIds,
          activeZonesByCode,
          decisions,
          true,
          operationalDisabledSources,
          genealogyLoad,
          approvedAuditEvidence,
          approvedMdmEvidence,
        );
      recomputeRequired ||= operationalReferencesReconciled;

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
        const missingVerifiedIdentity =
          !zone.codeSandre &&
          ['alias', 'legacy_gid'].includes(match.matchType) &&
          (zone.idSandre === null ||
            zone.idSandre === undefined ||
            zone.idSandre === feature.gid);
        const changed =
          zoneWasActive ||
          missingVerifiedIdentity ||
          zone.statutSandre !== feature.status ||
          zone.dateMajSandre !== feature.sourceUpdatedAt ||
          zone.numeroVersionSandre !== feature.version ||
          !sameStringArrays(zone.codesAlternatifs, feature.alternateCodes) ||
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
        zone.numeroVersionSandre = feature.version;
        zone.codesAlternatifs = feature.alternateCodes;
        zone.sandrePayloadHash = feature.payloadHash;
        if (missingVerifiedIdentity) {
          zone.idSandre = feature.gid;
          zone.codeSandre = feature.codeSandre;
          zone.sandreProvenance = 'official';
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
      state.observedSourceUpdatedAt = snapshot.sourceUpdatedAt;
      state.observedSnapshotHash = snapshot.snapshotHash;
      state.observedLatestFeaturesHash =
        this.getLatestSandreFeaturesHash(snapshot);
      state.observedFeatureCount = snapshot.featureCount;
      state.lastObservedAt = snapshotStartedAt;
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
      if (recomputeRequired) {
        const businessDate = getCurrentParisCivilDate();
        const [historicBoundary] = (await queryRunner.manager.query(
          `
            SELECT MIN(restriction_order."dateDebut")::text AS "dirtyFrom"
            FROM "arrete_restriction" restriction_order
            WHERE restriction_order."departementId" = $1
              AND restriction_order."statut" <> 'a_valider'
              AND restriction_order."dateDebut" IS NOT NULL
              AND restriction_order."dateDebut" < $2::date
          `,
          [departement.id, businessDate],
        )) as Array<{ dirtyFrom: string | null }>;
        if (historicBoundary?.dirtyFrom) {
          await invalidateHistoricComputationsFromWithManager(
            queryRunner.manager,
            historicBoundary.dirtyFrom,
          );
        }
        await recordPublicMutation(
          queryRunner.manager,
          [departement.id],
          'SYNCHRONISATION SANDRE',
        );
      }
      if (batchId) {
        await this.persistSandreDecisions(
          queryRunner.manager,
          depCode,
          batchId,
          decisions,
        );
      }
      await queryRunner.commitTransaction();

      return { result, recomputeRequired, decisions, stale: false };
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
  ): Promise<ZoneReferenceInventory> {
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
              WHERE link."zoneAlerteId" = $1
                AND ac.statut IN ('a_venir', 'publie')
            )::integer AS "nonAbrogeArreteCadre",
            (
              SELECT count(*)
              FROM restriction reference
              WHERE reference."zoneAlerteId" = $1
            )::integer AS "allRestrictions",
            (
              SELECT count(*)
              FROM restriction reference
              JOIN arrete_restriction ar
                ON ar.id = reference."arreteRestrictionId"
              WHERE reference."zoneAlerteId" = $1
                AND ar.statut IN ('a_venir', 'publie')
            )::integer AS restrictions,
            (
              SELECT count(*)
              FROM arrete_cadre_zone_alerte_communes reference
              WHERE reference."zoneAlerteId" = $1
            )::integer AS "allCustomizations",
            (
              SELECT count(*)
              FROM arrete_cadre_zone_alerte_communes reference
              JOIN arrete_cadre ac ON ac.id = reference."arreteCadreId"
              WHERE reference."zoneAlerteId" = $1
                AND ac.statut IN ('a_venir', 'publie')
            )::integer AS customizations
        `,
        [zoneAlerteId],
      )) ?? [];
    return {
      arreteCadre: Number(rows[0]?.arreteCadre ?? 0),
      nonAbrogeArreteCadre: Number(rows[0]?.nonAbrogeArreteCadre ?? 0),
      allRestrictions: Number(rows[0]?.allRestrictions ?? 0),
      restrictions: Number(rows[0]?.restrictions ?? 0),
      allCustomizations: Number(rows[0]?.allCustomizations ?? 0),
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
    apply = true,
    operationalDisabledSources?: OperationalDisabledZoneSource[],
    genealogyLoad?: SandreGenealogyLoad,
    approvedAuditEvidence?: SandreApprovedAuditEvidence,
    approvedMdmEvidence?: SandreApprovedMdmEvidence,
  ): Promise<boolean> {
    const resolvedInactiveZoneIds = new Set(
      resolvedInactiveFeatures.flatMap(({ match }) =>
        match ? [match.zone.id] : [],
      ),
    );
    const unidentifiedSources = (
      operationalDisabledSources ??
      (await this.getOperationalDisabledZoneSources(manager, departement.id))
    ).filter(
      (source) =>
        !resolvedInactiveZoneIds.has(source.id) &&
        !activeZoneIds.has(source.id),
    );
    if (unidentifiedSources.length > 0) {
      throw new SandreDepartmentBlockedError(
        `${unidentifiedSources.length} operational disabled zone(s) have no unambiguous Sandre identity`,
        unidentifiedSources.map((source) => ({
          decisionKey: `zone:${source.id}:reconciliation`,
          zoneType: source.type,
          sourceCode: source.codeSandre,
          zoneAlerteId: source.id,
          action: 'RECONCILE_OFFICIAL_SUCCESSOR',
          outcome: 'blocked',
          reason: 'SOURCE_IDENTITY_UNRESOLVED',
          evidence: {
            idSandre: source.idSandre,
            legacyCode: source.legacyCode,
          },
        })),
      );
    }

    let referencedSources: ReferencedFrozenSandreSource[] = [];

    for (const { feature, match } of resolvedInactiveFeatures) {
      if (!match || activeZoneIds.has(match.zone.id)) {
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
      const potentialReferenceCount =
        references.arreteCadre +
        references.allRestrictions +
        references.allCustomizations;
      if (potentialReferenceCount > 0) {
        referencedSources.push({
          feature,
          matchType: match.matchType,
          zone: match.zone,
          references,
          operationalReferenceCount,
        });
      }
    }

    const sourcesWithUnverifiedIdentity = referencedSources.flatMap(
      (source) => {
        const canonicalConflict =
          source.matchType === 'alias' &&
          Boolean(source.zone.codeSandre) &&
          source.zone.codeSandre !== source.feature.codeSandre;
        const missingVerifiedIdentity =
          !source.zone.codeSandre &&
          (!['alias', 'legacy_gid'].includes(source.matchType) ||
            (source.zone.idSandre !== null &&
              source.zone.idSandre !== undefined &&
              source.zone.idSandre !== source.feature.gid));
        return canonicalConflict || missingVerifiedIdentity
          ? [
              {
                source,
                reason: canonicalConflict
                  ? 'SOURCE_CANONICAL_IDENTITY_CONFLICT'
                  : 'SOURCE_IDENTITY_UNRESOLVED',
              },
            ]
          : [];
      },
    );
    const identityDecisions = sourcesWithUnverifiedIdentity.map(
      ({ source, reason }) => ({
        decisionKey: `zone:${source.zone.id}:reconciliation`,
        zoneType: source.feature.type,
        sourceCode: source.feature.codeSandre,
        zoneAlerteId: source.zone.id,
        action: 'RECONCILE_OFFICIAL_SUCCESSOR',
        outcome: source.operationalReferenceCount > 0 ? 'blocked' : 'deferred',
        reason,
        evidence: {
          idSandre: source.zone.idSandre ?? null,
          matchedCode: source.feature.codeSandre,
          matchedCanonicalCode: source.zone.codeSandre ?? null,
          matchType: source.matchType,
        },
      }),
    );
    if (
      sourcesWithUnverifiedIdentity.some(
        ({ source }) => source.operationalReferenceCount > 0,
      )
    ) {
      throw new SandreDepartmentBlockedError(
        sourcesWithUnverifiedIdentity.some(
          ({ reason }) => reason === 'SOURCE_CANONICAL_IDENTITY_CONFLICT',
        )
          ? 'Operational frozen Sandre alias conflicts with canonical zone identity'
          : 'Operational frozen Sandre source identity is unresolved',
        identityDecisions as SandreSyncDecisionDraft[],
      );
    }
    decisions.push(...(identityDecisions as SandreSyncDecisionDraft[]));
    const unverifiedSourceIds = new Set(
      sourcesWithUnverifiedIdentity.map(({ source }) => source.zone.id),
    );
    referencedSources = referencedSources.filter(
      (source) => !unverifiedSourceIds.has(source.zone.id),
    );

    let approvedReferencesReconciled = false;
    const approvedSnapshot = findSandreApprovedSyncSnapshot(
      departement.code,
      snapshot,
    );
    if (approvedSnapshot) {
      approvedReferencesReconciled =
        await this.reconcileApprovedSandreSnapshotMappings(
          manager,
          departement,
          snapshot,
          approvedSnapshot,
          resolvedInactiveFeatures,
          activeZonesByCode,
          decisions,
          apply,
          approvedAuditEvidence,
          approvedMdmEvidence,
        );
      const approvedCodes = new Set(
        approvedSnapshot.mappings.map((mapping) => mapping.sourceCode),
      );
      referencedSources = referencedSources.filter(
        (source) => !approvedCodes.has(source.feature.codeSandre),
      );
    }

    if (referencedSources.length === 0) {
      return approvedReferencesReconciled;
    }

    let relations: SandreGenealogyRelation[];
    try {
      if (genealogyLoad && 'error' in genealogyLoad) {
        throw genealogyLoad.error;
      }
      relations =
        genealogyLoad?.relations ?? (await this.getSandreGenealogyRelations());
    } catch (error) {
      const unavailableDecisions = referencedSources.map(
        ({ feature, zone, references, operationalReferenceCount }) => ({
          decisionKey: `${feature.codeSandre}:reconciliation`,
          zoneType: feature.type,
          sourceCode: feature.codeSandre,
          zoneAlerteId: zone.id,
          action: 'RECONCILE_OFFICIAL_SUCCESSOR',
          outcome: operationalReferenceCount > 0 ? 'blocked' : 'deferred',
          reason: 'GENEALOGY_SOURCE_UNAVAILABLE',
          evidence: { references },
        }),
      );
      if (
        referencedSources.some((source) => source.operationalReferenceCount > 0)
      ) {
        throw new SandreDepartmentBlockedError(
          `Official Sandre genealogy is unavailable: ${this.sandreFailureReason(error)}`,
          unavailableDecisions as SandreSyncDecisionDraft[],
        );
      }
      decisions.push(...(unavailableDecisions as SandreSyncDecisionDraft[]));
      return false;
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
        codeSandre: feature.codeSandre,
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
    const genealogyLatestDate = relations
      .map((relation) => relation.modificationDate)
      .filter(
        (value): value is string =>
          typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value),
      )
      .sort()
      .at(-1);
    const featuresByCode = new Map(
      snapshot.features.map((feature) => [feature.codeSandre, feature]),
    );
    const decisionReason = (result: (typeof results)[number]): string => {
      const sourceFeature = result.oldCodeSandre
        ? featuresByCode.get(result.oldCodeSandre)
        : null;
      return result.reason === 'NO_TYPE_2_SUCCESSOR' &&
        (!genealogyLatestDate ||
          Boolean(
            sourceFeature &&
            sourceFeature.sourceUpdatedAt > genealogyLatestDate,
          ))
        ? 'GENEALOGY_STALE_OR_MISSING'
        : result.reason;
    };
    const targetCounts = new Map<number, number>();
    for (const result of results) {
      if (result.status === 'APPLICABLE' && result.newZoneId !== null) {
        targetCounts.set(
          result.newZoneId,
          (targetCounts.get(result.newZoneId) ?? 0) + 1,
        );
      }
    }
    const effectiveReason = (result: (typeof results)[number]): string =>
      result.status === 'APPLICABLE' &&
      result.newZoneId !== null &&
      (targetCounts.get(result.newZoneId) ?? 0) > 1
        ? 'NOT_STRICT_ONE_TO_ONE'
        : decisionReason(result);
    const isStrictlyApplicable = (result: (typeof results)[number]): boolean =>
      result.status === 'APPLICABLE' &&
      result.newZoneId !== null &&
      (targetCounts.get(result.newZoneId) ?? 0) === 1;
    const referencedSourcesByZoneId = new Map(
      referencedSources.map((source) => [source.zone.id, source]),
    );
    const nonApplicableResults = results.filter(
      (result) => !isStrictlyApplicable(result),
    );
    const blockingResults = nonApplicableResults.filter(
      (result) =>
        (referencedSourcesByZoneId.get(result.oldZoneId)
          ?.operationalReferenceCount ?? 0) > 0,
    );
    if (blockingResults.length > 0) {
      throw new SandreDepartmentBlockedError(
        `Official Sandre reconciliation blocked for ${blockingResults.map((result) => `${result.oldCodeSandre}:${effectiveReason(result)}`).join(', ')}`,
        results.map((result) => ({
          decisionKey: `${result.oldCodeSandre}:reconciliation`,
          zoneType: localZonesById.get(result.oldZoneId)?.type ?? 'SUP',
          sourceCode: result.oldCodeSandre,
          targetCode: result.newCodeSandre,
          zoneAlerteId: result.oldZoneId,
          candidateZoneAlerteId:
            result.newZoneId && result.newZoneId > 0 ? result.newZoneId : null,
          action: 'RECONCILE_OFFICIAL_SUCCESSOR',
          outcome:
            !isStrictlyApplicable(result) &&
            (referencedSourcesByZoneId.get(result.oldZoneId)
              ?.operationalReferenceCount ?? 0) > 0
              ? 'blocked'
              : 'deferred',
          reason: effectiveReason(result),
          evidence: {
            genealogyPath: result.genealogyPath,
            genealogyLatestDate: genealogyLatestDate ?? null,
            sourceUpdatedAt: result.oldCodeSandre
              ? (featuresByCode.get(result.oldCodeSandre)?.sourceUpdatedAt ??
                null)
              : null,
            references: result.references,
          },
        })),
      );
    }

    for (const result of nonApplicableResults) {
      decisions.push({
        decisionKey: `${result.oldCodeSandre}:reconciliation`,
        zoneType: localZonesById.get(result.oldZoneId)?.type ?? 'SUP',
        sourceCode: result.oldCodeSandre,
        targetCode: result.newCodeSandre,
        zoneAlerteId: result.oldZoneId,
        candidateZoneAlerteId:
          result.newZoneId && result.newZoneId > 0 ? result.newZoneId : null,
        action: 'RECONCILE_OFFICIAL_SUCCESSOR',
        outcome: 'deferred',
        reason: effectiveReason(result),
        evidence: {
          genealogyPath: result.genealogyPath,
          references: result.references,
        },
      });
    }

    let mappings;
    try {
      mappings = mappingsFromResults(
        results.filter(isStrictlyApplicable),
        localZones,
      );
    } catch (error) {
      throw new SandreDepartmentBlockedError(
        `Official Sandre reconciliation is not one-to-one: ${this.sandreFailureReason(error)}`,
        results.map((result) => ({
          decisionKey: `${result.oldCodeSandre}:reconciliation`,
          zoneType: localZonesById.get(result.oldZoneId)?.type ?? 'SUP',
          sourceCode: result.oldCodeSandre,
          targetCode: result.newCodeSandre,
          zoneAlerteId: result.oldZoneId,
          candidateZoneAlerteId:
            result.newZoneId && result.newZoneId > 0 ? result.newZoneId : null,
          action: 'RECONCILE_OFFICIAL_SUCCESSOR',
          outcome: 'blocked',
          reason: 'NOT_STRICT_ONE_TO_ONE',
          evidence: { genealogyPath: result.genealogyPath },
        })),
      );
    }
    const mappedSourceIds = new Set(
      mappings.map((mapping) => mapping.oldZoneId),
    );
    if (
      referencedSources.some(
        (source) =>
          source.operationalReferenceCount > 0 &&
          !mappedSourceIds.has(source.zone.id),
      )
    ) {
      throw new SandreDepartmentBlockedError(
        'Official Sandre reconciliation did not cover every operational zone',
      );
    }

    const resultsByOldZoneId = new Map(
      results.map((result) => [result.oldZoneId, result]),
    );
    let operationalReferencesReconciled = false;
    for (const mapping of mappings) {
      const target = activeTargetsById.get(mapping.newZoneId);
      if (!target) {
        throw new SandreDepartmentBlockedError(
          `Active Sandre successor ${mapping.newZoneId} disappeared during reconciliation`,
        );
      }
      const source = referencedSourcesByZoneId.get(mapping.oldZoneId);
      if (!source) {
        throw new SandreDepartmentBlockedError(
          `Referenced Sandre source ${mapping.oldZoneId} disappeared during reconciliation`,
        );
      }
      try {
        await this.assertNoOperationalReferenceCollision(manager, mapping);
      } catch (error) {
        if (source.operationalReferenceCount > 0) {
          throw error;
        }
        decisions.push({
          decisionKey: `${mapping.oldCodeSandre}:reconciliation`,
          zoneType: mapping.zoneType,
          sourceCode: mapping.oldCodeSandre,
          targetCode: mapping.newCodeSandre,
          zoneAlerteId: mapping.oldZoneId,
          candidateZoneAlerteId: mapping.newZoneId,
          action: 'RECONCILE_OFFICIAL_SUCCESSOR',
          outcome: 'deferred',
          reason: 'REFERENCE_OR_ALIAS_COLLISION',
          evidence: { error: this.sandreFailureReason(error) },
        });
        continue;
      }
      if (apply) {
        if (!source.zone.codeSandre) {
          source.zone.idSandre = source.feature.gid;
          source.zone.codeSandre = source.feature.codeSandre;
          await manager.getRepository(ZoneAlerte).save(source.zone);
        }
        await this.ensureSandreAlias(
          manager,
          departement,
          target,
          mapping.oldCodeSandre,
          'sandre_genealogy',
          mapping.oldZoneId,
        );
        if (source.operationalReferenceCount > 0) {
          try {
            await manager.query(
              'SELECT remap_operational_sandre_zone_references($1, $2)',
              [mapping.oldZoneId, mapping.newZoneId],
            );
            operationalReferencesReconciled = true;
          } catch (error) {
            throw new SandreDepartmentBlockedError(
              `Operational Sandre reference remap blocked for ${mapping.oldCodeSandre}: ${this.sandreFailureReason(error)}`,
              [
                {
                  decisionKey: `${mapping.oldCodeSandre}:reconciliation`,
                  zoneType: mapping.zoneType,
                  sourceCode: mapping.oldCodeSandre,
                  targetCode: mapping.newCodeSandre,
                  zoneAlerteId: mapping.oldZoneId,
                  candidateZoneAlerteId: mapping.newZoneId,
                  action: 'RECONCILE_OFFICIAL_SUCCESSOR',
                  outcome: 'blocked',
                  reason: 'OPERATIONAL_REFERENCE_REMAP_BLOCKED',
                  evidence: {
                    error: this.sandreFailureReason(error),
                  },
                },
              ],
            );
          }
        }
      }
      const reconciliation = resultsByOldZoneId.get(mapping.oldZoneId);
      decisions.push({
        decisionKey: `${mapping.oldCodeSandre}:reconciliation`,
        zoneType: mapping.zoneType,
        sourceCode: mapping.oldCodeSandre,
        targetCode: mapping.newCodeSandre,
        zoneAlerteId: mapping.oldZoneId,
        candidateZoneAlerteId: mapping.newZoneId > 0 ? mapping.newZoneId : null,
        action: 'RECONCILE_OFFICIAL_SUCCESSOR',
        outcome: apply ? 'applied' : 'deferred',
        reason: 'OFFICIAL_LINEAR_SUCCESSOR',
        evidence: {
          genealogyPath: reconciliation?.genealogyPath ?? [],
          operationalReferencesRemapped:
            apply && source.operationalReferenceCount > 0,
        },
      });
    }
    return (
      approvedReferencesReconciled || (apply && operationalReferencesReconciled)
    );
  }

  private async getOperationalDisabledZoneSources(
    manager: EntityManager,
    departmentId: number,
  ): Promise<OperationalDisabledZoneSource[]> {
    const rows =
      (await manager.query(
        `
          SELECT
            zone.id,
            zone."idSandre",
            zone."codeSandre",
            zone.code AS "legacyCode",
            zone.type
          FROM zone_alerte zone
          WHERE zone."departementId" = $1
            AND zone.disabled = true
            AND zone."sandreProvenance" <> 'local_preserved'
            AND (
              EXISTS (
                SELECT 1
                FROM arrete_cadre_zone_alerte reference
                JOIN arrete_cadre parent
                  ON parent.id = reference."arreteCadreId"
                WHERE reference."zoneAlerteId" = zone.id
                  AND parent.statut IN ('a_venir', 'publie')
              )
              OR EXISTS (
                SELECT 1
                FROM restriction reference
                JOIN arrete_restriction parent
                  ON parent.id = reference."arreteRestrictionId"
                WHERE reference."zoneAlerteId" = zone.id
                  AND parent.statut IN ('a_venir', 'publie')
              )
              OR EXISTS (
                SELECT 1
                FROM arrete_cadre_zone_alerte_communes reference
                JOIN arrete_cadre parent
                  ON parent.id = reference."arreteCadreId"
                WHERE reference."zoneAlerteId" = zone.id
                  AND parent.statut IN ('a_venir', 'publie')
              )
            )
          ORDER BY zone.id
        `,
        [departmentId],
      )) ?? [];
    return rows.map((row) => ({
      id: Number(row.id),
      idSandre:
        row.idSandre === null || row.idSandre === undefined
          ? null
          : Number(row.idSandre),
      codeSandre: row.codeSandre ?? null,
      legacyCode: String(row.legacyCode),
      type: row.type as 'SOU' | 'SUP',
    }));
  }

  private async reconcileApprovedSandreSnapshotMappings(
    manager: EntityManager,
    departement: Departement,
    snapshot: SandreZoneSnapshot,
    approval: SandreApprovedSyncSnapshot,
    resolvedInactiveFeatures: Array<{
      feature: SandreZoneFeature;
      match: SandreZoneMatch | null;
    }>,
    activeZonesByCode: Map<string, ZoneAlerte>,
    decisions: SandreSyncDecisionDraft[],
    apply: boolean,
    approvedAuditEvidence?: SandreApprovedAuditEvidence,
    approvedMdmEvidence?: SandreApprovedMdmEvidence,
  ): Promise<boolean> {
    if (apply && !approvedAuditEvidence) {
      throw new Error('Missing exact Sandre audit evidence for safe mode');
    }
    const inactiveByCode = new Map(
      resolvedInactiveFeatures.map((item) => [item.feature.codeSandre, item]),
    );
    const featuresByCode = new Map(
      snapshot.features.map((feature) => [feature.codeSandre, feature]),
    );
    const resolved = approval.mappings.map((mapping) => {
      const source = inactiveByCode.get(mapping.sourceCode);
      const targets = mapping.targetCodes.map((codeSandre) => ({
        feature: featuresByCode.get(codeSandre),
        zone: activeZonesByCode.get(codeSandre),
      }));
      const canonicalSourceIdentity =
        source?.match?.matchType === 'canonical' &&
        source.match.zone.codeSandre === source.feature.codeSandre &&
        source.match.zone.sandreProvenance === 'official';
      const legacySourceIdentity =
        source?.match?.matchType === 'legacy_gid' &&
        source.match.zone.codeSandre === null &&
        source.match.zone.idSandre === source.feature.gid &&
        source.match.zone.sandreProvenance === 'legacy_unverified';
      if (
        !source?.match ||
        source.match.zone.id !== mapping.sourceZoneId ||
        source.feature.status !== 'Gelé' ||
        source.feature.type !== 'SUP' ||
        source.match.zone.idSandre !== source.feature.gid ||
        (!canonicalSourceIdentity && !legacySourceIdentity) ||
        source.match.zone.type !== source.feature.type ||
        targets.some(
          (target) =>
            !target.feature ||
            !target.zone ||
            target.feature.status !== 'Validé' ||
            target.feature.type !== source.feature.type ||
            target.zone.idSandre !== target.feature.gid ||
            target.zone.codeSandre !== target.feature.codeSandre,
        )
      ) {
        throw new SandreDepartmentBlockedError(
          `Approved Sandre mapping identity changed for ${mapping.sourceCode}`,
        );
      }
      return {
        mapping,
        source: source as {
          feature: SandreZoneFeature;
          match: SandreZoneMatch;
        },
        targets: targets as Array<{
          feature: SandreZoneFeature;
          zone: ZoneAlerte;
        }>,
      };
    });

    if (
      !approvedMdmEvidence ||
      approvedMdmEvidence.approvalId !== approval.approvalId
    ) {
      throw new SandreDepartmentBlockedError(
        `Missing preloaded MDM evidence for ${approval.approvalId}`,
      );
    }
    if (apply) {
      await lockSandreApprovedSyncReferences(
        manager,
        resolved.map((item) => item.source.match.zone.id),
        resolved.flatMap((item) =>
          item.targets
            .map((target) => target.zone.id)
            .filter((id) => Number.isInteger(id) && id > 0),
        ),
      );
      await assertSandreApprovedMaterializedTargets(
        manager,
        departement.id,
        resolved.flatMap((item) =>
          item.targets.map((target) => ({
            feature: target.feature,
            zoneAlerteId: target.zone.id,
          })),
        ),
      );
    }
    const stableMdmEvidence = approvedMdmEvidence.zoneRecords.map((record) => ({
      codeSandre: record.codeSandre,
      projection: record.projection,
      projectionSha256: record.projectionSha256,
      requiredEvolution: record.requiredEvolution,
    }));
    const stableMdmNomenclature = approvedMdmEvidence.nomenclature
      ? {
          projection: approvedMdmEvidence.nomenclature.projection,
          projectionSha256: approvedMdmEvidence.nomenclature.projectionSha256,
        }
      : null;

    let referencesReconciled = false;
    for (const item of resolved) {
      const targetZoneIds = item.targets.map((target) => target.zone.id);
      const geometry = await auditSandreApprovedSyncGeometry(
        manager,
        item.mapping,
        item.targets.map((target) => target.feature),
      );
      const observedSourceIdentity: SandreApprovedSourceIdentityEvidence = {
        matchType:
          item.source.match.matchType === 'canonical'
            ? 'canonical'
            : 'legacy_gid',
        idSandre: item.source.match.zone.idSandre!,
        codeSandre: item.source.match.zone.codeSandre ?? null,
        provenance: item.source.match.zone.sandreProvenance as
          | 'official'
          | 'legacy_unverified',
        disabled: item.source.match.zone.disabled,
        statutSandre: item.source.match.zone.statutSandre ?? null,
        dateMajSandre: item.source.match.zone.dateMajSandre ?? null,
        numeroVersionSandre: item.source.match.zone.numeroVersionSandre ?? null,
        sandrePayloadHash: item.source.match.zone.sandrePayloadHash ?? null,
      };
      const staticEvidence = {
        approvalId: approval.approvalId,
        snapshotHash: approval.snapshotHash,
        sourceUpdatedAt: approval.sourceUpdatedAt,
        featureCount: approval.featureCount,
        featureEvidenceFingerprint: approval.featureEvidenceFingerprint,
        sourceCode: item.mapping.sourceCode,
        sourceZoneId: item.mapping.sourceZoneId,
        sourceIdentityPolicy: 'canonical_or_strict_legacy_gid',
        mapping: item.mapping,
        geometry,
        mdmRecords: stableMdmEvidence,
        mdmNomenclature: stableMdmNomenclature,
      };
      const staticFingerprint = fingerprint(staticEvidence);
      const decisionKey = `${item.mapping.sourceCode}:approved-snapshot`;
      let expectedReferences: SandreApprovedReferenceEvidence;
      let migrationLineage: SandreApprovedReferenceEvidence | undefined;
      let currentReferences: SandreApprovedReferenceEvidence;
      let alreadyApplied = false;
      let auditedSourceIdentity = observedSourceIdentity;

      if (apply) {
        const audited = approvedAuditEvidence!.decisions.get(decisionKey);
        if (
          audited?.approvalId !== approval.approvalId ||
          audited?.staticFingerprint !== staticFingerprint ||
          audited?.approvalFingerprint !==
            fingerprint({
              staticFingerprint,
              referenceEvidence: audited?.referenceEvidence,
              migrationLineage: audited?.migrationLineage ?? null,
              observedSourceIdentity: audited?.observedSourceIdentity,
            })
        ) {
          throw new SandreDepartmentBlockedError(
            `Approved Sandre audit evidence changed for ${item.mapping.sourceCode}`,
          );
        }
        expectedReferences = parseSandreApprovedReferenceEvidence(
          audited.referenceEvidence,
        );
        migrationLineage = audited.migrationLineage
          ? parseSandreApprovedReferenceEvidence(audited.migrationLineage)
          : undefined;
        currentReferences = await loadSandreApprovedReferenceEvidence(
          manager,
          item.source.match.zone.id,
          targetZoneIds,
          migrationLineage ??
            (expectedReferences.lifecycle === 'pre_apply'
              ? expectedReferences
              : undefined),
        );
        auditedSourceIdentity = parseSandreApprovedSourceIdentityEvidence(
          audited.observedSourceIdentity,
        );
        const sourceZone = item.source.match.zone;
        if (
          currentReferences.fingerprint === expectedReferences.fingerprint &&
          (sourceZone.idSandre !== item.source.feature.gid ||
            sourceZone.codeSandre !== item.source.feature.codeSandre ||
            sourceZone.sandreProvenance !== 'official')
        ) {
          sourceZone.idSandre = item.source.feature.gid;
          sourceZone.codeSandre = item.source.feature.codeSandre;
          sourceZone.sandreProvenance = 'official';
          await manager.getRepository(ZoneAlerte).save(sourceZone);
        }
        if (currentReferences.fingerprint === expectedReferences.fingerprint) {
          if (
            fingerprint(observedSourceIdentity) !==
            fingerprint(auditedSourceIdentity)
          ) {
            throw new SandreDepartmentBlockedError(
              `Approved Sandre source identity changed for ${item.mapping.sourceCode}`,
            );
          }
          if (expectedReferences.lifecycle === 'post_apply') {
            if (item.targets.length === 1) {
              await this.assertSandreApprovedAlias(
                manager,
                departement,
                item.targets[0].zone,
                item.source.feature.codeSandre,
              );
            }
            alreadyApplied = true;
          }
        } else {
          try {
            if (expectedReferences.lifecycle !== 'pre_apply') {
              throw new Error('approved post-apply evidence drifted');
            }
            if (
              item.source.match.zone.idSandre !== item.source.feature.gid ||
              item.source.match.zone.codeSandre !==
                item.source.feature.codeSandre
            ) {
              throw new Error('approved source identity is not canonical');
            }
            if (currentReferences.lifecycle !== 'post_apply') {
              throw new Error('approved pre-apply state drifted');
            }
            this.assertSandreApprovedSourcePostState(
              item.source.match.zone,
              item.source.feature,
            );
            if (item.targets.length === 1) {
              await this.assertSandreApprovedAlias(
                manager,
                departement,
                item.targets[0].zone,
                item.source.feature.codeSandre,
              );
            }
            alreadyApplied = true;
          } catch (error) {
            throw new SandreDepartmentBlockedError(
              `Approved Sandre state drifted for ${item.mapping.sourceCode}: ${this.sandreFailureReason(error)}`,
            );
          }
        }
      } else {
        migrationLineage = await this.loadLatestAppliedSandreMigrationLineage(
          manager,
          departement.id,
          decisionKey,
          approval.approvalId,
        );
        currentReferences = await loadSandreApprovedReferenceEvidence(
          manager,
          item.source.match.zone.id,
          targetZoneIds,
          migrationLineage,
        );
        expectedReferences = currentReferences;
        if (
          currentReferences.lifecycle === 'post_apply' &&
          item.targets.length === 1
        ) {
          await this.assertSandreApprovedAlias(
            manager,
            departement,
            item.targets[0].zone,
            item.source.feature.codeSandre,
          );
        }
      }

      if (apply && !alreadyApplied) {
        const sourceZone = item.source.match.zone;
        if (
          sourceZone.idSandre !== item.source.feature.gid ||
          sourceZone.codeSandre !== item.source.feature.codeSandre ||
          sourceZone.sandreProvenance !== 'official'
        ) {
          sourceZone.idSandre = item.source.feature.gid;
          sourceZone.codeSandre = item.source.feature.codeSandre;
          sourceZone.sandreProvenance = 'official';
          await manager.getRepository(ZoneAlerte).save(sourceZone);
        }
        if (item.targets.length === 1) {
          const targetZone = item.targets[0].zone;
          const mapping: ReconciliationMapping = {
            departmentId: departement.id,
            departmentCode: departement.code,
            zoneType: item.source.feature.type,
            oldZoneId: sourceZone.id,
            oldCodeSandre: item.source.feature.codeSandre,
            newZoneId: targetZone.id,
            newCodeSandre: item.targets[0].feature.codeSandre,
          };
          await this.assertNoOperationalReferenceCollision(manager, mapping);
          await this.ensureSandreAlias(
            manager,
            departement,
            targetZone,
            item.source.feature.codeSandre,
            'sandre_genealogy',
            sourceZone.id,
          );
          if (
            expectedReferences.arreteCadreLinks.length > 0 ||
            expectedReferences.restrictions.length > 0 ||
            expectedReferences.customizationCount > 0
          ) {
            await manager.query(
              'SELECT remap_operational_sandre_zone_references($1, $2)',
              [sourceZone.id, targetZone.id],
            );
            await assertSandreApprovedOneToOneApplied(
              manager,
              expectedReferences,
              targetZone.id,
            );
            referencesReconciled = true;
          }
        } else {
          const result = await applySandreApprovedPartitionReferences(
            manager,
            expectedReferences,
            item.targets.map((target) => ({
              codeSandre: target.feature.codeSandre,
              zoneAlerteId: target.zone.id,
            })),
            item.mapping.effectiveDate!,
          );
          referencesReconciled ||= result.applied;
        }
      }

      if (apply && !migrationLineage) {
        migrationLineage = await loadSandreApprovedReferenceEvidence(
          manager,
          item.source.match.zone.id,
          targetZoneIds,
          expectedReferences,
        );
      }

      const approvalFingerprint = fingerprint({
        staticFingerprint,
        referenceEvidence: expectedReferences,
        migrationLineage: migrationLineage ?? null,
        observedSourceIdentity: auditedSourceIdentity,
      });
      decisions.push({
        decisionKey,
        zoneType: item.source.feature.type,
        sourceCode: item.mapping.sourceCode,
        targetCode: item.mapping.targetCodes.join(','),
        zoneAlerteId: item.source.match.zone.id,
        candidateZoneAlerteId:
          item.targets.length === 1 && item.targets[0].zone.id > 0
            ? item.targets[0].zone.id
            : null,
        action: 'RECONCILE_APPROVED_SNAPSHOT',
        outcome: apply ? 'applied' : 'observed',
        reason: alreadyApplied
          ? 'APPROVED_MAPPING_ALREADY_APPLIED'
          : 'APPROVED_EXACT_SNAPSHOT_MAPPING',
        evidence: {
          approvalId: approval.approvalId,
          approvedAuditBatchId: approvedAuditEvidence?.batchId ?? null,
          staticFingerprint,
          referenceEvidence: expectedReferences,
          migrationLineage: migrationLineage ?? null,
          observedSourceIdentity: auditedSourceIdentity,
          approvalFingerprint,
          mdmTransportEvidence: approvedMdmEvidence,
        },
      });
    }
    return apply && referencesReconciled;
  }

  private async loadLatestAppliedSandreMigrationLineage(
    manager: EntityManager,
    departmentId: number,
    decisionKey: string,
    approvalId: string,
  ): Promise<SandreApprovedReferenceEvidence | undefined> {
    const [row] = await manager.query(
      `
        SELECT decision.evidence -> 'migrationLineage' AS lineage
        FROM sandre_zone_sync_decision decision
        JOIN sandre_zone_sync_batch batch ON batch.id = decision."batchId"
        WHERE decision."departementId" = $1
          AND decision."decisionKey" = $2
          AND decision.action = 'RECONCILE_APPROVED_SNAPSHOT'
          AND decision.outcome = 'applied'
          AND batch.mode = 'safe'
          AND batch.status IN ('started', 'applied')
          AND decision.evidence ->> 'approvalId' = $3
          AND decision.evidence ? 'migrationLineage'
        ORDER BY batch."startedAt" DESC, batch.id DESC
        LIMIT 1
      `,
      [departmentId, decisionKey, approvalId],
    );
    return row?.lineage
      ? parseSandreApprovedReferenceEvidence(row.lineage)
      : undefined;
  }

  private async fetchApprovedSandreMdmEvidence(
    approval: SandreApprovedSyncSnapshot,
  ): Promise<SandreApprovedMdmEvidence> {
    // A proof call validates each resource once; retries only fill missing slots.
    const accumulatedEvidence: SandreApprovedMdmEvidenceAccumulator = {
      zoneRecords: approval.mdmRecords.map(() => undefined),
      nomenclature: approval.mdmNomenclature ? undefined : null,
    };
    return loadSandreMdmProofWithRetry(
      (budget) =>
        this.fetchApprovedSandreMdmEvidenceAttempt(
          approval,
          budget,
          accumulatedEvidence,
        ),
      (attempt, budget) => this.waitForSandreMdmProofRetry(attempt, budget),
    );
  }

  private async fetchApprovedSandreMdmEvidenceAttempt(
    approval: SandreApprovedSyncSnapshot,
    budget: SandreMdmProofBudget,
    accumulatedEvidence: SandreApprovedMdmEvidenceAccumulator = {
      zoneRecords: approval.mdmRecords.map(() => undefined),
      nomenclature: approval.mdmNomenclature ? undefined : null,
    },
  ): Promise<SandreApprovedMdmEvidence> {
    budget.assertRemaining('before loading the approved resources');
    const controller = new AbortController();
    const attemptCancellation = new Error('Sandre MDM proof attempt cancelled');
    const cancelAttemptAtProofDeadline = () => {
      controller.abort(this.sandreMdmCancellationError(budget.signal));
    };
    if (budget.signal.aborted) {
      cancelAttemptAtProofDeadline();
    } else {
      budget.signal.addEventListener('abort', cancelAttemptAtProofDeadline, {
        once: true,
      });
    }
    const abortSiblingsOnNonRetryableFailure = <T>(
      resource: Promise<T>,
    ): Promise<T> =>
      resource.catch((error) => {
        if (
          error !== attemptCancellation &&
          !(error instanceof SandreMdmTransientError) &&
          !budget.signal.aborted
        ) {
          controller.abort(attemptCancellation);
        }
        throw error;
      });
    const zoneRecordPromises = approval.mdmRecords.flatMap(
      (expectation, index) =>
        accumulatedEvidence.zoneRecords[index] !== undefined
          ? []
          : [
              abortSiblingsOnNonRetryableFailure(
                fetchSandreMdmZoneRecordEvidence(expectation, (url) =>
                  this.fetchSandreMdmTransport(
                    url,
                    'application/json',
                    2 * 1024 * 1024,
                    budget,
                    controller.signal,
                  ),
                ).then((evidence) => {
                  if (accumulatedEvidence.zoneRecords[index] !== undefined) {
                    throw new Error(
                      `Sandre MDM zone ${expectation.codeSandre} was validated more than once`,
                    );
                  }
                  accumulatedEvidence.zoneRecords[index] = evidence;
                  return evidence;
                }),
              ),
            ],
    );
    const nomenclaturePromises =
      approval.mdmNomenclature && accumulatedEvidence.nomenclature === undefined
        ? [
            abortSiblingsOnNonRetryableFailure(
              fetchSandreMdmNomenclatureEvidence(
                approval.mdmNomenclature,
                (url) =>
                  this.fetchSandreMdmTransport(
                    url,
                    'text/html,application/xhtml+xml;q=0.9',
                    512 * 1024,
                    budget,
                    controller.signal,
                  ),
              ).then((evidence) => {
                if (accumulatedEvidence.nomenclature !== undefined) {
                  throw new Error(
                    'Sandre MDM nomenclature was validated more than once',
                  );
                }
                accumulatedEvidence.nomenclature = evidence;
                return evidence;
              }),
            ),
          ]
        : [];
    const resourcePromises = [...zoneRecordPromises, ...nomenclaturePromises];
    try {
      await Promise.all(resourcePromises);
      budget.assertRemaining('after validating the approved resources');
      const zoneRecords = accumulatedEvidence.zoneRecords.filter(
        (record): record is SandreMdmZoneRecordEvidence => record !== undefined,
      );
      if (zoneRecords.length !== approval.mdmRecords.length) {
        throw new Error('Incomplete accumulated Sandre MDM zone evidence');
      }
      if (
        approval.mdmNomenclature &&
        accumulatedEvidence.nomenclature === undefined
      ) {
        throw new Error('Incomplete accumulated Sandre MDM nomenclature');
      }
      return {
        approvalId: approval.approvalId,
        zoneRecords,
        nomenclature: accumulatedEvidence.nomenclature ?? null,
      };
    } catch (error) {
      if (!(error instanceof SandreMdmTransientError)) {
        controller.abort(attemptCancellation);
      }
      const settledResources = await Promise.allSettled(resourcePromises);
      const nonRetryableFailure = settledResources.find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected' &&
          result.reason !== attemptCancellation &&
          !(result.reason instanceof SandreMdmTransientError),
      );
      if (nonRetryableFailure) {
        throw nonRetryableFailure.reason;
      }
      throw error;
    } finally {
      budget.signal.removeEventListener('abort', cancelAttemptAtProofDeadline);
    }
  }

  private async fetchSandreMdmTransport(
    url: string,
    accept: string,
    maximumBytes: number,
    budget: SandreMdmProofBudget,
    signal: AbortSignal,
  ): Promise<SandreMdmTransportResponse> {
    for (let attempt = 1; attempt <= SANDRE_MDM_REQUEST_ATTEMPTS; attempt++) {
      if (signal.aborted) {
        throw this.sandreMdmCancellationError(signal);
      }
      const timeout = Math.min(
        SANDRE_MDM_REQUEST_TIMEOUT_MS,
        budget.assertRemaining(`before requesting ${url}`),
      );
      let response;
      try {
        response = await firstValueFrom(
          this.httpService.get(url, {
            headers: { accept, 'accept-language': 'fr' },
            responseType: 'text',
            timeout,
            signal,
            maxRedirects: 0,
            maxContentLength: maximumBytes,
            maxBodyLength: maximumBytes,
            transformResponse: [(body) => body],
            validateStatus: () => true,
          }),
        );
      } catch (error) {
        if (signal.aborted) {
          throw this.sandreMdmCancellationError(signal);
        }
        budget.assertRemaining(`while requesting ${url}`, error);
        const code =
          error && typeof error === 'object' && 'code' in error
            ? String(error.code)
            : '';
        const transient = [
          'ECONNABORTED',
          'ECONNRESET',
          'ECONNREFUSED',
          'EAI_AGAIN',
          'ENETUNREACH',
          'ETIMEDOUT',
        ].includes(code);
        if (!transient) {
          throw error;
        }
        if (attempt === SANDRE_MDM_REQUEST_ATTEMPTS) {
          throw new SandreMdmTransientError(
            `Transient Sandre MDM transport failure for ${url}`,
            error,
          );
        }
        await this.waitForSandreMdmRequestRetry(attempt, budget, signal);
        continue;
      }
      budget.assertRemaining(`after requesting ${url}`);
      if (SANDRE_MDM_TRANSIENT_HTTP_STATUSES.has(response.status)) {
        if (attempt === SANDRE_MDM_REQUEST_ATTEMPTS) {
          throw new SandreMdmTransientError(
            `Transient Sandre MDM HTTP ${response.status} for ${url}`,
          );
        }
        await this.waitForSandreMdmRequestRetry(attempt, budget, signal);
        continue;
      }
      return {
        status: response.status,
        contentType:
          typeof response.headers?.['content-type'] === 'string'
            ? response.headers['content-type']
            : null,
        finalUrl:
          response.request?.res?.responseUrl ??
          response.request?.responseURL ??
          url,
        body: typeof response.data === 'string' ? response.data : '',
      };
    }
    throw new Error('Sandre MDM request retry budget exhausted');
  }

  private async waitForSandreMdmRequestRetry(
    attempt: number,
    budget: SandreMdmProofBudget,
    signal: AbortSignal,
  ): Promise<void> {
    await this.waitForSandreMdmDelay(
      SANDRE_MDM_REQUEST_RETRY_BASE_MS * 2 ** (attempt - 1),
      budget,
      signal,
    );
  }

  private async waitForSandreMdmProofRetry(
    attempt: number,
    budget: SandreMdmProofBudget,
  ): Promise<void> {
    await this.waitForSandreMdmDelay(
      Math.min(
        SANDRE_MDM_PROOF_RETRY_BASE_MS *
          2 ** Math.min(Math.max(0, attempt - 1), 3),
        SANDRE_MDM_PROOF_RETRY_MAX_MS,
      ),
      budget,
      budget.signal,
      true,
    );
  }

  private async waitForSandreMdmDelay(
    delayMs: number,
    budget: SandreMdmProofBudget,
    signal?: AbortSignal,
    fitWithinBudget = false,
  ): Promise<void> {
    if (signal?.aborted) {
      throw this.sandreMdmCancellationError(signal);
    }
    const remainingMs = budget.assertRemaining('before retry backoff');
    let effectiveDelayMs = delayMs;
    if (effectiveDelayMs >= remainingMs) {
      if (!fitWithinBudget) {
        throw new SandreMdmProofDeadlineExceededError(
          'Sandre MDM proof deadline leaves no room for the required backoff',
        );
      }
      effectiveDelayMs = Math.max(0, remainingMs - 1);
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(this.sandreMdmCancellationError(signal!));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, effectiveDelayMs);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    budget.assertRemaining('after retry backoff');
  }

  private sandreMdmCancellationError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
      ? signal.reason
      : new Error('Sandre MDM proof attempt cancelled');
  }

  private async lockOperationalParentsForSandreSources(
    manager: EntityManager,
    sourceZoneIds: number[],
  ): Promise<void> {
    const uniqueSourceZoneIds = [...new Set(sourceZoneIds)].sort(
      (left, right) => left - right,
    );
    if (uniqueSourceZoneIds.length === 0) {
      return;
    }

    await manager.query(
      `
        SELECT parent.id
        FROM arrete_cadre parent
        WHERE parent.statut IN ('a_venir', 'publie')
          AND (
            EXISTS (
              SELECT 1
              FROM arrete_cadre_zone_alerte reference
              WHERE reference."arreteCadreId" = parent.id
                AND reference."zoneAlerteId" = ANY($1::integer[])
            )
            OR EXISTS (
              SELECT 1
              FROM arrete_cadre_zone_alerte_communes reference
              WHERE reference."arreteCadreId" = parent.id
                AND reference."zoneAlerteId" = ANY($1::integer[])
            )
          )
        ORDER BY parent.id
        FOR SHARE OF parent
      `,
      [uniqueSourceZoneIds],
    );
    await manager.query(
      `
        SELECT parent.id
        FROM arrete_restriction parent
        WHERE parent.statut IN ('a_venir', 'publie')
          AND EXISTS (
            SELECT 1
            FROM restriction reference
            WHERE reference."arreteRestrictionId" = parent.id
              AND reference."zoneAlerteId" = ANY($1::integer[])
          )
        ORDER BY parent.id
        FOR SHARE OF parent
      `,
      [uniqueSourceZoneIds],
    );
  }

  private async assertNoOperationalReferenceCollision(
    manager: EntityManager,
    mapping: ReconciliationMapping,
  ): Promise<void> {
    const rows =
      (await manager.query(
        `
          SELECT
            EXISTS (
              SELECT 1
              FROM restriction source
              JOIN arrete_restriction parent
                ON parent.id = source."arreteRestrictionId"
              JOIN restriction target
                ON target."arreteRestrictionId" = source."arreteRestrictionId"
                AND target."zoneAlerteId" = $2
              WHERE source."zoneAlerteId" = $1
                AND parent.statut IN ('a_venir', 'publie')
            ) AS "restrictionCollision",
            EXISTS (
              SELECT 1
              FROM arrete_cadre_zone_alerte_communes source
              JOIN arrete_cadre parent
                ON parent.id = source."arreteCadreId"
              JOIN arrete_cadre_zone_alerte_communes target
                ON target."arreteCadreId" = source."arreteCadreId"
                AND target."zoneAlerteId" = $2
              WHERE source."zoneAlerteId" = $1
                AND parent.statut IN ('a_venir', 'publie')
            ) AS "customizationCollision",
            EXISTS (
              SELECT 1
              FROM sandre_zone_alias alias
              WHERE alias."departementId" = $3
                AND alias."zoneType" = $4
                AND alias."aliasType" = 'cd_zas'
                AND alias."aliasValue" = $5
                AND alias."zoneAlerteId" NOT IN ($1, $2)
            ) AS "aliasCollision"
        `,
        [
          mapping.oldZoneId,
          mapping.newZoneId,
          mapping.departmentId,
          mapping.zoneType,
          mapping.oldCodeSandre,
        ],
      )) ?? [];
    const collision = rows[0];
    const collisionTypes = [
      collision?.restrictionCollision === true ? 'restriction' : null,
      collision?.customizationCollision === true ? 'customization' : null,
      collision?.aliasCollision === true ? 'alias' : null,
    ].filter(Boolean);
    if (collisionTypes.length > 0) {
      throw new SandreDepartmentBlockedError(
        `Official Sandre reconciliation has ${collisionTypes.join(', ')} collision(s) for ${mapping.oldCodeSandre}`,
        [
          {
            decisionKey: `${mapping.oldCodeSandre}:reconciliation`,
            zoneType: mapping.zoneType,
            sourceCode: mapping.oldCodeSandre,
            targetCode: mapping.newCodeSandre,
            zoneAlerteId: mapping.oldZoneId,
            candidateZoneAlerteId:
              mapping.newZoneId > 0 ? mapping.newZoneId : null,
            action: 'RECONCILE_OFFICIAL_SUCCESSOR',
            outcome: 'blocked',
            reason: 'OPERATIONAL_REFERENCE_COLLISION',
            evidence: { collisionTypes },
          },
        ],
      );
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
        headers: SANDRE_GENEALOGY_REQUEST_HEADERS,
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
        headers: SANDRE_GENEALOGY_REQUEST_HEADERS,
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
        sandreProvenance: Not('local_preserved'),
      },
      relations: {
        bassinVersant: true,
        departement: true,
      },
      take: 2,
    });
    const managedCanonicalMatches = canonicalMatches.filter(
      (zone) => zone.sandreProvenance !== 'local_preserved',
    );
    if (managedCanonicalMatches.length > 1) {
      throw new Error(`Duplicate Sandre code ${feature.codeSandre}`);
    }
    if (managedCanonicalMatches.length === 1) {
      this.assertSandreZoneScope(
        managedCanonicalMatches[0],
        departement,
        feature,
      );
      return {
        matchType: 'canonical',
        zone: managedCanonicalMatches[0],
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
        zoneAlerte: {
          sandreProvenance: Not('local_preserved'),
        },
      },
      relations: {
        zoneAlerte: {
          bassinVersant: true,
          departement: true,
        },
      },
    });
    if (alias && alias.zoneAlerte.sandreProvenance !== 'local_preserved') {
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
        sandreProvenance: Not('local_preserved'),
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
    const managedLegacyMatches = legacyMatches.filter(
      (zone) => zone.sandreProvenance !== 'local_preserved',
    );
    if (managedLegacyMatches.length > 1) {
      throw new Error(
        `Duplicate legacy Sandre gid ${feature.gid} for department ${departement.code}`,
      );
    }

    return managedLegacyMatches.length === 1
      ? {
          matchType: 'legacy_gid',
          zone: managedLegacyMatches[0],
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
    bassinVersant: BassinVersant,
    result: SandreSyncResult,
  ): Promise<{ zone: ZoneAlerte; recomputeRequired: boolean }> {
    const zoneRepository = manager.getRepository(ZoneAlerte);
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
      (zone.sandreProvenance !== undefined &&
        zone.sandreProvenance !== 'official') ||
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
    zone.sandreProvenance = 'official';

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
    replacesZoneId?: number,
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
    if (existingAlias?.zoneAlerte.id === replacesZoneId) {
      existingAlias.zoneAlerte = zone;
      existingAlias.source = source;
      await aliasRepository.save(existingAlias);
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

  private async assertSandreApprovedAlias(
    manager: EntityManager,
    departement: Departement,
    zone: ZoneAlerte,
    aliasValue: string,
  ): Promise<void> {
    const aliases = await manager.getRepository(SandreZoneAlias).find({
      where: {
        departement: { id: departement.id },
        zoneAlerte: { id: zone.id },
        zoneType: zone.type,
        aliasType: 'cd_zas',
        aliasValue,
      },
      take: 2,
    });
    if (aliases.length !== 1) {
      throw new Error(`Approved Sandre alias ${aliasValue} changed`);
    }
  }

  private assertSandreApprovedSourcePostState(
    zone: ZoneAlerte,
    feature: SandreZoneFeature,
  ): void {
    if (
      zone.disabled !== true ||
      zone.idSandre !== feature.gid ||
      zone.codeSandre !== feature.codeSandre ||
      zone.sandreProvenance !== 'official' ||
      zone.statutSandre !== feature.status ||
      zone.dateMajSandre !== feature.sourceUpdatedAt ||
      zone.numeroVersionSandre !== feature.version ||
      zone.sandrePayloadHash !== feature.payloadHash ||
      !sameStringArrays(zone.codesAlternatifs, feature.alternateCodes)
    ) {
      throw new Error(
        `Approved Sandre source ${feature.codeSandre} post-state changed`,
      );
    }
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

function parseSandreApprovedSourceIdentityEvidence(
  value: unknown,
): SandreApprovedSourceIdentityEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid approved Sandre source identity evidence');
  }
  const row = value as Record<string, unknown>;
  const parsed: SandreApprovedSourceIdentityEvidence = {
    matchType: row.matchType as 'canonical' | 'legacy_gid',
    idSandre: Number(row.idSandre),
    codeSandre: row.codeSandre === null ? null : String(row.codeSandre),
    provenance: row.provenance as 'official' | 'legacy_unverified',
    disabled: row.disabled as boolean,
    statutSandre: row.statutSandre === null ? null : String(row.statutSandre),
    dateMajSandre:
      row.dateMajSandre === null ? null : String(row.dateMajSandre),
    numeroVersionSandre:
      row.numeroVersionSandre === null ? null : Number(row.numeroVersionSandre),
    sandrePayloadHash:
      row.sandrePayloadHash === null ? null : String(row.sandrePayloadHash),
  };
  if (
    !['canonical', 'legacy_gid'].includes(parsed.matchType) ||
    !Number.isInteger(parsed.idSandre) ||
    parsed.idSandre <= 0 ||
    typeof row.disabled !== 'boolean' ||
    (parsed.matchType === 'canonical'
      ? parsed.provenance !== 'official' ||
        !/^\d{1,32}$/.test(parsed.codeSandre ?? '')
      : parsed.provenance !== 'legacy_unverified' ||
        parsed.codeSandre !== null) ||
    (parsed.dateMajSandre !== null &&
      !/^\d{4}-\d{2}-\d{2}$/.test(parsed.dateMajSandre)) ||
    (parsed.numeroVersionSandre !== null &&
      !Number.isInteger(parsed.numeroVersionSandre)) ||
    (parsed.sandrePayloadHash !== null &&
      !/^[a-f0-9]{64}$/.test(parsed.sandrePayloadHash)) ||
    fingerprint(parsed) !== fingerprint(value)
  ) {
    throw new Error('Invalid approved Sandre source identity evidence');
  }
  return parsed;
}
