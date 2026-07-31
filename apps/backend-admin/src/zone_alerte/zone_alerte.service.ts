import { HttpService } from '@nestjs/axios';
import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
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
} from 'typeorm';
import { isMainThread } from 'worker_threads';
import { ArreteCadreService } from '../arrete_cadre/arrete_cadre.service';
import { BassinVersantService } from '../bassin_versant/bassin_versant.service';
import { DepartementService } from '../departement/departement.service';
import { RegleauLogger } from '../logger/regleau.logger';
import { MailService } from '../shared/services/mail.service';
import { runCurrentZoneComputeWorker } from '../worker_threads/run-current-zone-compute';
import {
  fetchSandreZoneSnapshot,
  hashSandreZoneFeatures,
  SandreZoneFeature,
  SandreZoneSnapshot,
} from './sandre-zone-sync';

const SANDRE_FULL_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SANDRE_HTTP_TIMEOUT_MS = 30 * 1000;
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
}

@Injectable()
export class ZoneAlerteService {
  private readonly logger = new RegleauLogger('ZoneAlerteService');
  private sandreSyncRunning = false;
  private sandreSyncConfigurationWarned = false;

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

  /**
   * Vérification régulière s'il n'y a pas de nouvelles zones
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async updateZones() {
    const syncMode = this.configService
      .get<string>('SANDRE_ZONE_SYNC_MODE')
      ?.trim();
    if (syncMode !== 'safe') {
      if (!this.sandreSyncConfigurationWarned) {
        if (!syncMode || syncMode === 'paused') {
          this.logger.warn(
            'SYNCHRONISATION SANDRE EN PAUSE: SANDRE_ZONE_SYNC_MODE=safe REQUIS',
          );
        } else {
          this.logger.error(`SANDRE_ZONE_SYNC_MODE INVALIDE: ${syncMode}`, '');
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
    try {
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
          const lastFullSyncAt = state?.lastFullSyncAt?.getTime();
          const fullSyncExpired =
            !lastFullSyncAt ||
            Date.now() - lastFullSyncAt >= SANDRE_FULL_SYNC_INTERVAL_MS;
          const sourceChanged =
            !fullSyncExpired && (await this.hasSandreChanges(d.code, state));

          if (fullSyncExpired || sourceChanged) {
            await this.updateDepartementZones(d.code);
          }
        } catch (error) {
          this.logger.error(
            `ERREUR LORS DE LA MISE A JOUR DES ZONES D'ALERTES DU DEPARTEMENT ${d.code}`,
            error,
          );
        }
        if (recomputeWasPending) {
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
      this.sandreSyncRunning = false;
      this.logger.log("MISE A JOUR DES ZONES D'ALERTE - FIN");
    }
  }

  async updateDepartementZones(depCode: string): Promise<SandreSyncResult> {
    this.logger.log(`MISE A JOUR DES ZONES D'ALERTE DU DEPARTEMENT ${depCode}`);

    const [{ syncStartedAt }] = await this.dataSource.query(
      'SELECT clock_timestamp() AS "syncStartedAt"',
    );
    const snapshot = await this.fetchSandreDepartmentSnapshot(depCode);
    const { result, recomputeRequired } = await this.applySandreSnapshot(
      depCode,
      snapshot,
      new Date(syncStartedAt),
    );

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

  private async hasSandreChanges(
    depCode: string,
    state: SandreZoneSyncState,
  ): Promise<boolean> {
    if (state.featureCount === 0) {
      return (await this.fetchSandreFeatureCount(depCode)) > 0;
    }
    if (!state.sourceUpdatedAt || !state.latestFeaturesHash) {
      return false;
    }

    const latestFeatures = await this.fetchSandreDepartmentSnapshot(
      depCode,
      state.sourceUpdatedAt,
      true,
    );
    return latestFeatures.snapshotHash !== state.latestFeaturesHash;
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
      const staleBySourceDate =
        state?.sourceUpdatedAt &&
        snapshot.sourceUpdatedAt &&
        state.sourceUpdatedAt > snapshot.sourceUpdatedAt;
      if (staleByStart || staleBySourceDate) {
        this.logger.warn(
          `INSTANTANE SANDRE IGNORE CAR PLUS ANCIEN POUR LE DEPARTEMENT ${depCode}`,
        );
        await queryRunner.commitTransaction();
        return {
          result: {
            added: 0,
            updated: 0,
            disabled: 0,
            unchanged: snapshot.featureCount,
          },
          recomputeRequired: false,
        };
      }

      const result: SandreSyncResult = {
        added: 0,
        updated: 0,
        disabled: 0,
        unchanged: 0,
      };
      const activeZoneIds = new Set<number>();
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
        const upsert = await this.upsertActiveSandreZone(
          queryRunner.manager,
          departement,
          feature,
          match,
          result,
        );
        activeZoneIds.add(upsert.zone.id);
        recomputeRequired ||= upsert.recomputeRequired;
      }

      for (const feature of inactiveFeatures) {
        const match = await this.findSandreZoneMatch(
          queryRunner.manager,
          departement,
          feature,
        );
        if (!match || activeZoneIds.has(match.zone.id)) {
          result.unchanged++;
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
      }

      state ??= stateRepository.create({ departement });
      state.sourceUpdatedAt = snapshot.sourceUpdatedAt;
      state.snapshotHash = snapshot.snapshotHash;
      state.latestFeaturesHash = this.getLatestSandreFeaturesHash(snapshot);
      state.snapshotStartedAt = snapshotStartedAt;
      state.lastFullSyncAt = now;
      state.lastSuccessAt = now;
      state.featureCount = snapshot.featureCount;
      state.needsRecompute = Boolean(state.needsRecompute) || recomputeRequired;
      if (recomputeRequired) {
        state.recomputeRevision = (state.recomputeRevision ?? 0) + 1;
      }
      await stateRepository.save(state);
      await queryRunner.commitTransaction();

      return { result, recomputeRequired };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
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
