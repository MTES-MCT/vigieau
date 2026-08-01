import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { DatagouvService } from '../datagouv/datagouv.service';
import { RegleauLogger } from '../logger/regleau.logger';
import { shouldRunWebScheduledJobs } from '../core/scheduling/business-cron';
import { S3Service } from '../shared/services/s3.service';
import {
  isZonePublicationEnabled,
  ZONE_PUBLICATION_DATAGOUV_PROMOTION_LOCK,
  ZONE_PUBLICATION_STABLE_PROMOTION_LOCK,
} from './zone_publication.config';
import { unwrapTypeOrmDmlReturningRows } from './typeorm-query-result';

const ZONE_PUBLICATION_PROMOTION_INTERVAL_MS = 60_000;

interface ActivePublicationPromotion {
  id: string;
  sourceComputedAt: Date | string;
  geojsonUrl: string;
  geojsonChecksum: string;
  pmtilesUrl: string;
  pmtilesChecksum: string;
}

export type ZonePublicationPromotionResult =
  | 'busy'
  | 'disabled'
  | 'failed'
  | 'nothing_to_do'
  | 'promoted';

@Injectable()
export class ZonePublicationPromotionService {
  private readonly logger = new RegleauLogger(
    'ZonePublicationPromotionService',
  );
  private stablePromotionInProgress = false;
  private dataGouvPromotionInProgress = false;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly s3Service: S3Service,
    private readonly datagouvService: DatagouvService,
  ) {}

  @Interval(ZONE_PUBLICATION_PROMOTION_INTERVAL_MS)
  async promoteStableArtifactsOnSchedule(): Promise<void> {
    if (
      !shouldRunWebScheduledJobs() ||
      !isZonePublicationEnabled() ||
      this.stablePromotionInProgress
    ) {
      return;
    }
    this.stablePromotionInProgress = true;
    try {
      const result = await this.promoteStableArtifacts();
      if (result === 'promoted') {
        this.logger.log(
          'Promoted active zone publication to stable S3 aliases',
        );
      }
    } catch (error) {
      this.logger.error('ZONE PUBLICATION STABLE PROMOTION ERROR', error);
    } finally {
      this.stablePromotionInProgress = false;
    }
  }

  @Interval(ZONE_PUBLICATION_PROMOTION_INTERVAL_MS)
  async promoteDataGouvOnSchedule(): Promise<void> {
    if (
      !shouldRunWebScheduledJobs() ||
      !isZonePublicationEnabled() ||
      this.dataGouvPromotionInProgress
    ) {
      return;
    }
    this.dataGouvPromotionInProgress = true;
    try {
      const result = await this.promoteDataGouv();
      if (result === 'promoted') {
        this.logger.log('Promoted active zone publication to data.gouv.fr');
      }
    } catch (error) {
      this.logger.error('ZONE PUBLICATION DATAGOUV PROMOTION ERROR', error);
    } finally {
      this.dataGouvPromotionInProgress = false;
    }
  }

  async promoteStableArtifacts(): Promise<ZonePublicationPromotionResult> {
    if (!isZonePublicationEnabled()) {
      return 'disabled';
    }
    const retrySeconds = this.readPositiveInteger(
      'ZONE_PUBLICATION_PROMOTION_RETRY_SECONDS',
      300,
    );

    let publicationId: string | undefined;
    try {
      return await this.dataSource.transaction(async (manager) => {
        const [lock] = await manager.query(
          'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked',
          [ZONE_PUBLICATION_STABLE_PROMOTION_LOCK],
        );
        if (lock?.locked !== true) {
          return 'busy';
        }

        const publication = await this.findActivePublicationForPromotion(
          manager,
          'legacy',
          retrySeconds,
        );
        if (!publication) {
          return 'nothing_to_do';
        }
        publicationId = publication.id;
        await this.recordPromotionAttempt(manager, publication.id);
        await this.copyStableArtifacts(publication);
        await this.updateLegacyComputationDate(
          manager,
          new Date(publication.sourceComputedAt),
        );
        const promoted = unwrapTypeOrmDmlReturningRows<{ id: string }>(
          await manager.query(
            `
              UPDATE "zone_publication" publication
              SET "legacyPromotedAt" = now(),
                  "promotionLastAttemptAt" = NULL,
                  "promotionError" = NULL
              FROM "zone_publication_state" state
              WHERE publication."id" = $1
                AND publication."status" = 'active'
                AND state."id" = 1
                AND state."activePublicationId" = publication."id"
              RETURNING publication."id"
              `,
            [publication.id],
          ),
        );
        if (promoted.length !== 1) {
          throw new Error(
            `Zone publication ${publication.id} is no longer active`,
          );
        }
        return 'promoted';
      });
    } catch (error) {
      if (publicationId) {
        await this.dataSource.query(
          `
            UPDATE "zone_publication" publication
            SET "promotionLastAttemptAt" = now(), "promotionError" = $2
            FROM "zone_publication_state" state
            WHERE publication."id" = $1
              AND publication."status" = 'active'
              AND state."id" = 1
              AND state."activePublicationId" = publication."id"
          `,
          [publicationId, this.errorMessage(error)],
        );
        return 'failed';
      }
      throw error;
    }
  }

  async promoteDataGouv(): Promise<ZonePublicationPromotionResult> {
    if (!isZonePublicationEnabled()) {
      return 'disabled';
    }
    const retrySeconds = this.readPositiveInteger(
      'ZONE_PUBLICATION_PROMOTION_RETRY_SECONDS',
      300,
    );
    let publicationId: string | undefined;
    try {
      return await this.dataSource.transaction(async (manager) => {
        // Activation takes the same lock. Keeping it for the complete external
        // write prevents an older publication from finishing after a newer one.
        const [stableLock] = await manager.query(
          'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked',
          [ZONE_PUBLICATION_STABLE_PROMOTION_LOCK],
        );
        if (stableLock?.locked !== true) {
          return 'busy';
        }
        const [dataGouvLock] = await manager.query(
          'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked',
          [ZONE_PUBLICATION_DATAGOUV_PROMOTION_LOCK],
        );
        if (dataGouvLock?.locked !== true) {
          return 'busy';
        }

        const publication = await this.findActivePublicationForPromotion(
          manager,
          'datagouv',
          retrySeconds,
        );
        if (!publication) {
          return 'nothing_to_do';
        }
        publicationId = publication.id;
        await this.recordPromotionAttempt(manager, publication.id);
        if (!this.datagouvService.canUploadToDataGouv()) {
          throw new Error('data.gouv.fr upload configuration is incomplete');
        }
        if (!publication.geojsonUrl || !publication.pmtilesUrl) {
          throw new Error(
            `Zone publication ${publication.id} has incomplete immutable artifact URLs`,
          );
        }
        const timeoutMs = this.readPositiveInteger(
          'ZONE_PUBLICATION_DATAGOUV_TIMEOUT_MS',
          15_000,
        );
        await this.assertActivePublication(manager, publication.id);
        await this.datagouvService.uploadToDatagouv(
          'geojson',
          publication.geojsonUrl,
          'Carte des zones et arrêtés en vigueur - GeoJSON',
          true,
          { timeoutMs },
        );
        await this.assertActivePublication(manager, publication.id);
        await this.datagouvService.uploadToDatagouv(
          'pmtiles',
          publication.pmtilesUrl,
          'Carte des zones et arrêtés en vigueur - PMTILES',
          true,
          { timeoutMs },
        );
        const promoted = unwrapTypeOrmDmlReturningRows<{ id: string }>(
          await manager.query(
            `
            UPDATE "zone_publication" publication
            SET "dataGouvPromotedAt" = now(),
                "promotionLastAttemptAt" = NULL,
                "promotionError" = NULL
            FROM "zone_publication_state" state
            WHERE publication."id" = $1
              AND publication."status" = 'active'
              AND state."id" = 1
              AND state."activePublicationId" = publication."id"
            RETURNING publication."id"
            `,
            [publication.id],
          ),
        );
        if (promoted.length !== 1) {
          throw new Error(
            `Zone publication ${publication.id} is no longer active`,
          );
        }
        return 'promoted';
      });
    } catch (error) {
      if (publicationId) {
        await this.dataSource.query(
          `
            UPDATE "zone_publication" publication
            SET "promotionLastAttemptAt" = now(), "promotionError" = $2
            FROM "zone_publication_state" state
            WHERE publication."id" = $1
              AND publication."status" = 'active'
              AND state."id" = 1
              AND state."activePublicationId" = publication."id"
          `,
          [publicationId, this.errorMessage(error)],
        );
        return 'failed';
      }
      throw error;
    }
  }

  private async assertActivePublication(
    manager: EntityManager,
    publicationId: string,
  ): Promise<void> {
    const [state] = await manager.query(
      `
        SELECT state."activePublicationId"
        FROM "zone_publication_state" state
        INNER JOIN "zone_publication" publication
          ON publication."id" = state."activePublicationId"
         AND publication."status" = 'active'
        WHERE state."id" = 1
          AND state."activePublicationId" = $1
      `,
      [publicationId],
    );
    if (!state) {
      throw new Error(`Zone publication ${publicationId} is no longer active`);
    }
  }

  private async findActivePublicationForPromotion(
    manager: EntityManager,
    stage: 'legacy' | 'datagouv',
    retrySeconds: number,
  ): Promise<ActivePublicationPromotion | null> {
    const stageCondition =
      stage === 'legacy'
        ? 'publication."legacyPromotedAt" IS NULL'
        : `publication."legacyPromotedAt" IS NOT NULL
           AND publication."dataGouvPromotedAt" IS NULL`;
    const [publication] = await manager.query(
      `
        SELECT publication."id",
               publication."sourceComputedAt",
               publication."geojsonUrl",
               publication."geojsonChecksum",
               publication."pmtilesUrl",
               publication."pmtilesChecksum"
        FROM "zone_publication_state" state
        INNER JOIN "zone_publication" publication
          ON publication."id" = state."activePublicationId"
         AND publication."status" = 'active'
        WHERE state."id" = 1
          AND ${stageCondition}
          AND (
            publication."promotionLastAttemptAt" IS NULL
            OR publication."promotionLastAttemptAt"
               < now() - ($1 * interval '1 second')
          )
      `,
      [retrySeconds],
    );
    return publication || null;
  }

  private async recordPromotionAttempt(
    manager: EntityManager,
    publicationId: string,
  ): Promise<void> {
    await manager.query(
      `
        UPDATE "zone_publication"
        SET "promotionLastAttemptAt" = now(), "promotionError" = NULL
        WHERE "id" = $1
      `,
      [publicationId],
    );
  }

  private async updateLegacyComputationDate(
    manager: EntityManager,
    computationDate: Date,
  ): Promise<void> {
    const updated = unwrapTypeOrmDmlReturningRows<{
      computeZoneAlerteComputedDate: Date | string;
    }>(
      await manager.query(
        `
        UPDATE "config"
        SET "computeZoneAlerteComputedDate" = $1
        WHERE "id" = 1
        RETURNING "computeZoneAlerteComputedDate"
        `,
        [computationDate],
      ),
    );
    const [config] = updated;
    const effectiveDate = new Date(config?.computeZoneAlerteComputedDate);
    if (!config || Number.isNaN(effectiveDate.getTime())) {
      throw new Error('Zone computation config state is missing');
    }
    if (effectiveDate.getTime() !== computationDate.getTime()) {
      throw new Error('Zone computation config date could not be synchronized');
    }
  }

  private async copyStableArtifacts(
    publication: ActivePublicationPromotion,
  ): Promise<void> {
    if (!publication.geojsonChecksum || !publication.pmtilesChecksum) {
      throw new Error(
        `Zone publication ${publication.id} has incomplete artifact checksums`,
      );
    }
    const date = new Date(publication.sourceComputedAt);
    if (Number.isNaN(date.getTime())) {
      throw new Error(
        `Zone publication ${publication.id} has an invalid computation date`,
      );
    }
    const day = date.toISOString().split('T')[0];
    const immutableGeojson = `zones_arretes_en_vigueur_${publication.geojsonChecksum}.geojson`;
    const immutablePmtiles = `zones_arretes_en_vigueur_${publication.pmtilesChecksum}.pmtiles`;
    const timeoutMs = this.readPositiveInteger(
      'ZONE_PUBLICATION_S3_TIMEOUT_MS',
      60_000,
    );
    const copyFile = (
      source: string,
      destination: string,
      prefix: string,
      cacheControl: string,
      contentType: string,
    ) =>
      this.copyAndValidateArtifact(source, destination, prefix, {
        // A copy must get its own deadline: the four sequential copies can
        // legitimately take longer than the timeout of one S3 operation.
        abortSignal: AbortSignal.timeout(timeoutMs),
        cacheControl,
        contentType,
      });

    const stableCache = 'public, max-age=0, must-revalidate';

    await copyFile(
      immutableGeojson,
      `zones_arretes_en_vigueur_${day}.geojson`,
      'geojson/',
      stableCache,
      'application/geo+json',
    );
    await copyFile(
      immutablePmtiles,
      `zones_arretes_en_vigueur_${day}.pmtiles`,
      'pmtiles/',
      stableCache,
      'application/vnd.pmtiles',
    );
    await copyFile(
      immutableGeojson,
      'zones_arretes_en_vigueur.geojson',
      'geojson/',
      stableCache,
      'application/geo+json',
    );
    await copyFile(
      immutablePmtiles,
      'zones_arretes_en_vigueur.pmtiles',
      'pmtiles/',
      stableCache,
      'application/vnd.pmtiles',
    );
  }

  private async copyAndValidateArtifact(
    source: string,
    destination: string,
    prefix: string,
    options: {
      abortSignal: AbortSignal;
      cacheControl: string;
      contentType: string;
    },
  ): Promise<void> {
    const sourceHead = await this.s3Service.headFile(source, prefix, {
      abortSignal: options.abortSignal,
    });
    if (!sourceHead.ContentLength || sourceHead.ContentLength <= 0) {
      throw new Error(`Source S3 vide ou absente: ${prefix}${source}`);
    }
    await this.s3Service.copyFile(source, destination, prefix, options);
    const destinationHead = await this.s3Service.headFile(destination, prefix, {
      abortSignal: options.abortSignal,
    });
    if (destinationHead.ContentLength !== sourceHead.ContentLength) {
      throw new Error(
        `Copie S3 invalide: ${prefix}${destination} a une taille inattendue`,
      );
    }
    if (destinationHead.CacheControl !== options.cacheControl) {
      throw new Error(
        `Copie S3 invalide: cache-control inattendu pour ${prefix}${destination}`,
      );
    }
    if (destinationHead.ContentType !== options.contentType) {
      throw new Error(
        `Copie S3 invalide: content-type inattendu pour ${prefix}${destination}`,
      );
    }
  }

  private errorMessage(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(
      0,
      10_000,
    );
  }

  private readPositiveInteger(name: string, fallback: number): number {
    const rawValue = process.env[name];
    if (!rawValue) {
      return fallback;
    }
    const value = Number(rawValue);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }
}
