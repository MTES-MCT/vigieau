import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { DatagouvService } from '../datagouv/datagouv.service';
import { RegleauLogger } from '../logger/regleau.logger';
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
  geojsonChecksum: string;
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
    if (!isZonePublicationEnabled() || this.stablePromotionInProgress) {
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
    if (!isZonePublicationEnabled() || this.dataGouvPromotionInProgress) {
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
    const publication = await this.claimDataGouvPromotion(retrySeconds);
    if (!publication) {
      return 'nothing_to_do';
    }

    try {
      if (!this.datagouvService.canUploadToDataGouv()) {
        throw new Error('data.gouv.fr upload configuration is incomplete');
      }
      const timeoutMs = this.readPositiveInteger(
        'ZONE_PUBLICATION_DATAGOUV_TIMEOUT_MS',
        15_000,
      );
      await this.datagouvService.uploadToDatagouv(
        'geojson',
        this.s3Service.getPublicFileUrl(
          'zones_arretes_en_vigueur.geojson',
          'geojson/',
        ),
        'Carte des zones et arrêtés en vigueur - GeoJSON',
        true,
        { timeoutMs },
      );
      await this.datagouvService.uploadToDatagouv(
        'pmtiles',
        this.s3Service.getPublicFileUrl(
          'zones_arretes_en_vigueur.pmtiles',
          'pmtiles/',
        ),
        'Carte des zones et arrêtés en vigueur - PMTILES',
        true,
        { timeoutMs },
      );
      const promoted = unwrapTypeOrmDmlReturningRows<{ id: string }>(
        await this.dataSource.query(
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
      return promoted.length === 1 ? 'promoted' : 'nothing_to_do';
    } catch (error) {
      await this.dataSource.query(
        `
          UPDATE "zone_publication" publication
          SET "promotionError" = $2
          FROM "zone_publication_state" state
          WHERE publication."id" = $1
            AND publication."status" = 'active'
            AND state."id" = 1
            AND state."activePublicationId" = publication."id"
        `,
        [publication.id, this.errorMessage(error)],
      );
      return 'failed';
    }
  }

  private async claimDataGouvPromotion(
    retrySeconds: number,
  ): Promise<ActivePublicationPromotion | null> {
    return this.dataSource.transaction(async (manager) => {
      const [lock] = await manager.query(
        'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked',
        [ZONE_PUBLICATION_DATAGOUV_PROMOTION_LOCK],
      );
      if (lock?.locked !== true) {
        return null;
      }
      const publication = await this.findActivePublicationForPromotion(
        manager,
        'datagouv',
        retrySeconds,
      );
      if (!publication) {
        return null;
      }
      await this.recordPromotionAttempt(manager, publication.id);
      return publication;
    });
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
               publication."geojsonChecksum",
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
          AND (
            "computeZoneAlerteComputedDate" < $1
            OR "computeZoneAlerteComputedDate" IS NULL
          )
        RETURNING "computeZoneAlerteComputedDate"
        `,
        [computationDate],
      ),
    );
    const [config] =
      updated.length > 0
        ? updated
        : await manager.query(
            `SELECT "computeZoneAlerteComputedDate" FROM "config" WHERE "id" = 1`,
          );
    const effectiveDate = new Date(config?.computeZoneAlerteComputedDate);
    if (!config || Number.isNaN(effectiveDate.getTime())) {
      throw new Error('Zone computation config state is missing');
    }
    if (effectiveDate.getTime() < computationDate.getTime()) {
      throw new Error('Zone computation config date could not be advanced');
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
    const abortSignal = AbortSignal.timeout(
      this.readPositiveInteger('ZONE_PUBLICATION_S3_TIMEOUT_MS', 60_000),
    );

    await this.s3Service.copyFile(
      immutableGeojson,
      `zones_arretes_en_vigueur_${day}.geojson`,
      'geojson/',
      { abortSignal },
    );
    await this.s3Service.copyFile(
      immutablePmtiles,
      `zones_arretes_en_vigueur_${day}.pmtiles`,
      'pmtiles/',
      { abortSignal },
    );
    await this.s3Service.copyFile(
      immutableGeojson,
      'zones_arretes_en_vigueur.geojson',
      'geojson/',
      { abortSignal },
    );
    await this.s3Service.copyFile(
      immutablePmtiles,
      'zones_arretes_en_vigueur.pmtiles',
      'pmtiles/',
      { abortSignal },
    );
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
