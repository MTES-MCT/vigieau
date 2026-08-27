import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ZoneAlerteComputed } from '@shared/entities/zone_alerte_computed.entity';
import { ZoneAlerteComputedHistoric } from '@shared/entities/zone_alerte_computed_historic.entity';
import { Utils } from '../core/utils';
import { StatisticDepartementService } from '../statistic_departement/statistic_departement.service';
import { S3Service } from '../shared/services/s3.service';
import { ZoneAlerteComputedHistoricService } from '../zone_alerte_computed/zone_alerte_computed_historic.service';
import {
  HistoricBackfillDepartmentPayloadBuilder,
  HistoricBackfillLegacyZoneProvider,
  HistoricBackfillMapArtifactBuilder,
} from './historic-backfill-task-handler';
import { readHistoricBackfillArtifactAcl } from './historic-backfill.config';

type Gravity = 'vigilance' | 'alerte' | 'alerte_renforcee' | 'crise' | null;

function maxGravity(
  zones: readonly ZoneAlerteComputedHistoric[],
  type: 'SUP' | 'SOU' | 'AEP' | null,
  legacy: boolean,
): Gravity {
  const values = zones
    .filter((zone) => !type || zone.type === type)
    .map((zone) => {
      const candidate = zone as ZoneAlerteComputedHistoric & {
        restrictions?: Array<{ niveauGravite?: string }>;
      };
      return legacy
        ? candidate.restrictions?.[0]?.niveauGravite
        : (candidate.restriction?.niveauGravite ?? candidate.niveauGravite);
    })
    .filter((value): value is string => Boolean(value))
    .map((value) => Utils.getNiveau(value));
  if (values.length === 0) {
    return null;
  }
  return Utils.getNiveauInversed(Math.max(...values)) as Gravity;
}

@Injectable()
export class HistoricBackfillLegacyZoneProviderService implements HistoricBackfillLegacyZoneProvider {
  constructor(
    private readonly historicZoneService: ZoneAlerteComputedHistoricService,
  ) {}

  async computeAndFindZones(
    departement: { code: string },
    computedFor: string,
    context: { signal: AbortSignal },
  ): Promise<ZoneAlerteComputedHistoric[]> {
    if (context.signal.aborted) {
      throw context.signal.reason ?? new Error('Historic backfill aborted');
    }
    return this.historicZoneService.findLegacyHistoricDepartmentZones(
      departement.code,
      computedFor,
    );
  }
}

@Injectable()
export class HistoricBackfillDepartmentPayloadBuilderService implements HistoricBackfillDepartmentPayloadBuilder {
  constructor(
    private readonly statisticDepartementService: StatisticDepartementService,
  ) {}

  async build(
    zones: readonly ZoneAlerteComputedHistoric[],
    computedFor: string,
    legacy: boolean,
    context: { departementId: number; departementCode: string },
  ) {
    const restriction =
      await this.statisticDepartementService.buildHistoricDepartmentRestriction(
        zones as unknown as ZoneAlerteComputed[],
        {
          date: computedFor,
          departementId: context.departementId,
          departementCode: context.departementCode,
          historicNotComputed: legacy,
        },
      );
    return {
      restriction: restriction as unknown as Record<string, unknown>,
      situation: {
        max: maxGravity(zones, null, legacy),
        sup: maxGravity(zones, 'SUP', legacy),
        sou: maxGravity(zones, 'SOU', legacy),
        aep: legacy ? null : maxGravity(zones, 'AEP', false),
      },
    };
  }
}

@Injectable()
export class HistoricBackfillMapArtifactBuilderService implements HistoricBackfillMapArtifactBuilder {
  private readonly artifactAcl = readHistoricBackfillArtifactAcl();

  constructor(
    private readonly historicZoneService: ZoneAlerteComputedHistoricService,
    private readonly s3Service: S3Service,
  ) {}

  async buildAndUpload(
    zones: readonly ZoneAlerteComputedHistoric[],
    claim: {
      runId: string;
      departmentLastPublicRevision: string;
      historicComputeEpoch: string;
      departmentGeneration: string;
      departementCode: string;
    },
    validFrom: string,
    _validThrough: string,
    legacy: boolean,
    context: { signal: AbortSignal },
  ) {
    const collection =
      await this.historicZoneService.buildHistoricDepartmentFeatureCollection(
        zones,
        validFrom,
        legacy,
      );
    const body = Buffer.from(JSON.stringify(collection));
    const checksum = createHash('sha256').update(body).digest('hex');
    const objectKey =
      `historic-backfill/${claim.runId}/departments/` +
      `department-revision-${claim.departmentLastPublicRevision}/` +
      `epoch-${claim.historicComputeEpoch}/` +
      `generation-${claim.departmentGeneration}/${claim.departementCode}/` +
      `${validFrom}-${checksum}.geojson`;
    await this.s3Service.uploadFile(
      {
        originalname: objectKey,
        mimetype: 'application/geo+json',
        buffer: body,
      } as Express.Multer.File,
      '',
      { abortSignal: context.signal, acl: this.artifactAcl },
    );
    return {
      objectKey,
      checksum,
      featureCount: collection.features.length,
    };
  }
}
