import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { DataSource } from 'typeorm';
import { ClockHeartbeatService } from '../core/scheduling/clock-heartbeat.service';
import { ExternalPublicationRegistryService } from '../datagouv/external-publication-registry.service';
import { parseSandreZoneSyncMode } from '../zone_alerte/sandre-zone-governance';

type SandreSynchronizationStatus =
  | 'healthy'
  | 'paused'
  | 'invalid_configuration'
  | 'never_observed'
  | 'stale'
  | 'never_applied'
  | 'application_stale'
  | 'pending_application'
  | 'blocked'
  | 'failed';

interface SandreSynchronizationHealth {
  status: SandreSynchronizationStatus;
  mode: 'paused' | 'audit' | 'safe' | 'invalid';
  staleAfterSeconds: number;
  oldestObservationAt: string | null;
  latestObservationAt: string | null;
  summary: {
    totalDepartments: number;
    trackedDepartments: number;
    staleDepartments: number;
    appliedDepartments: number;
    staleAppliedDepartments: number;
    pendingApplicationDepartments: number;
    blockedDepartments: number;
    failedBatches: number;
    blockedBatches: number;
  };
}

@Controller('health')
@ApiTags('Santé du serveur')
export class HealthController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly externalPublicationRegistry: ExternalPublicationRegistryService,
    private readonly clockHeartbeat: ClockHeartbeatService,
    private readonly configService: ConfigService,
  ) {}

  @Get()
  @SkipThrottle()
  check(): Promise<{ status: 'ready'; database: 'up' }> {
    return this.ready();
  }

  @Get('live')
  @SkipThrottle()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @SkipThrottle()
  async ready(): Promise<{ status: 'ready'; database: 'up' }> {
    try {
      await this.dataSource.query('SELECT 1');
      return { status: 'ready', database: 'up' };
    } catch {
      throw new ServiceUnavailableException({
        status: 'unavailable',
        database: 'down',
      });
    }
  }

  @Get('external-publications')
  externalPublications() {
    return this.externalPublicationRegistry.getHealthStatus();
  }

  @Get('sandre-references')
  async sandreReferences(): Promise<{
    status: 'healthy';
    invalidReferences: {
      arreteRestrictions: number;
      arreteCadres: number;
      customizations: number;
      total: number;
    };
  }> {
    try {
      const [row] = await this.dataSource.query(`
        SELECT
          (
            SELECT COUNT(*)::integer
            FROM restriction reference
            JOIN arrete_restriction parent
              ON parent.id = reference."arreteRestrictionId"
            JOIN zone_alerte zone ON zone.id = reference."zoneAlerteId"
            WHERE zone.disabled = true
              AND parent.statut IN ('a_venir', 'publie')
          ) AS "arreteRestrictions",
          (
            SELECT COUNT(*)::integer
            FROM arrete_cadre_zone_alerte reference
            JOIN arrete_cadre parent ON parent.id = reference."arreteCadreId"
            JOIN zone_alerte zone ON zone.id = reference."zoneAlerteId"
            WHERE zone.disabled = true
              AND parent.statut IN ('a_venir', 'publie')
          ) AS "arreteCadres",
          (
            SELECT COUNT(*)::integer
            FROM arrete_cadre_zone_alerte_communes reference
            JOIN arrete_cadre parent ON parent.id = reference."arreteCadreId"
            JOIN zone_alerte zone ON zone.id = reference."zoneAlerteId"
            WHERE zone.disabled = true
              AND parent.statut IN ('a_venir', 'publie')
          ) AS customizations
      `);
      const invalidReferences = {
        arreteRestrictions: Number(row?.arreteRestrictions ?? 0),
        arreteCadres: Number(row?.arreteCadres ?? 0),
        customizations: Number(row?.customizations ?? 0),
        total: 0,
      };
      invalidReferences.total =
        invalidReferences.arreteRestrictions +
        invalidReferences.arreteCadres +
        invalidReferences.customizations;

      if (invalidReferences.total > 0) {
        throw new ServiceUnavailableException({
          status: 'inconsistent',
          invalidReferences,
        });
      }

      return { status: 'healthy', invalidReferences };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }
      throw new ServiceUnavailableException({
        status: 'unavailable',
        invalidReferences: null,
      });
    }
  }

  @Get('sandre-synchronization')
  async sandreSynchronization(): Promise<SandreSynchronizationHealth> {
    const configuredMode = this.configService.get<string>(
      'SANDRE_ZONE_SYNC_MODE',
    );
    const mode = parseSandreZoneSyncMode(configuredMode);
    const configuredStaleAfter = Number(
      this.configService.get<string>('SANDRE_HEALTH_STALE_AFTER_SECONDS'),
    );
    const staleAfterSeconds =
      Number.isInteger(configuredStaleAfter) && configuredStaleAfter > 0
        ? configuredStaleAfter
        : 30 * 60 * 60;

    try {
      const [row] = await this.dataSource.query(
        `
          WITH latest_batches AS (
            SELECT DISTINCT ON (batch."departementId")
              batch."departementId", batch.status
            FROM sandre_zone_sync_batch batch
            WHERE batch.kind = 'snapshot'
            ORDER BY batch."departementId", batch."startedAt" DESC, batch.id DESC
          )
          SELECT
            count(DISTINCT departement.id)::integer AS "totalDepartments",
            count(DISTINCT state."departementId")::integer AS "trackedDepartments",
            count(DISTINCT departement.id) FILTER (
              WHERE state."lastObservedAt" IS NULL
                 OR state."lastObservedAt" < now() - ($1::integer * interval '1 second')
            )::integer AS "staleDepartments",
            count(DISTINCT state."departementId") FILTER (
              WHERE state."lastAppliedAt" IS NOT NULL
            )::integer AS "appliedDepartments",
            count(DISTINCT departement.id) FILTER (
              WHERE state."lastAppliedAt" IS NULL
                 OR state."lastAppliedAt" < now() - ($1::integer * interval '1 second')
            )::integer AS "staleAppliedDepartments",
            count(DISTINCT state."departementId") FILTER (
              WHERE state."observedSnapshotHash" IS DISTINCT FROM state."appliedSnapshotHash"
                 OR state."observedSourceUpdatedAt" IS DISTINCT FROM state."appliedSourceUpdatedAt"
            )::integer AS "pendingApplicationDepartments",
            count(DISTINCT state."departementId") FILTER (
              WHERE state."blockedAt" IS NOT NULL
            )::integer AS "blockedDepartments",
            count(DISTINCT latest_batches."departementId") FILTER (
              WHERE latest_batches.status = 'failed'
            )::integer AS "failedBatches",
            count(DISTINCT latest_batches."departementId") FILTER (
              WHERE latest_batches.status = 'blocked'
            )::integer AS "blockedBatches",
            min(state."lastObservedAt") AS "oldestObservationAt",
            max(state."lastObservedAt") AS "latestObservationAt"
          FROM departement
          LEFT JOIN sandre_zone_sync_state state
            ON state."departementId" = departement.id
          LEFT JOIN latest_batches
            ON latest_batches."departementId" = departement.id
        `,
        [staleAfterSeconds],
      );
      const summary = {
        totalDepartments: Number(row?.totalDepartments ?? 0),
        trackedDepartments: Number(row?.trackedDepartments ?? 0),
        staleDepartments: Number(row?.staleDepartments ?? 0),
        appliedDepartments: Number(row?.appliedDepartments ?? 0),
        staleAppliedDepartments: Number(row?.staleAppliedDepartments ?? 0),
        pendingApplicationDepartments: Number(
          row?.pendingApplicationDepartments ?? 0,
        ),
        blockedDepartments: Number(row?.blockedDepartments ?? 0),
        failedBatches: Number(row?.failedBatches ?? 0),
        blockedBatches: Number(row?.blockedBatches ?? 0),
      };
      let status: SandreSynchronizationStatus = 'healthy';
      if (!mode) {
        status = 'invalid_configuration';
      } else if (mode === 'paused') {
        status = 'paused';
      } else if (summary.blockedDepartments > 0 || summary.blockedBatches > 0) {
        status = 'blocked';
      } else if (summary.failedBatches > 0) {
        status = 'failed';
      } else if (
        summary.totalDepartments === 0 ||
        summary.trackedDepartments === 0
      ) {
        status = 'never_observed';
      } else if (
        summary.trackedDepartments !== summary.totalDepartments ||
        summary.staleDepartments > 0
      ) {
        status = 'stale';
      } else if (
        mode === 'safe' &&
        summary.appliedDepartments !== summary.totalDepartments
      ) {
        status = 'never_applied';
      } else if (mode === 'safe' && summary.pendingApplicationDepartments > 0) {
        status = 'pending_application';
      } else if (mode === 'safe' && summary.staleAppliedDepartments > 0) {
        status = 'application_stale';
      }

      const health: SandreSynchronizationHealth = {
        status,
        mode: mode ?? 'invalid',
        staleAfterSeconds,
        oldestObservationAt: row?.oldestObservationAt
          ? new Date(row.oldestObservationAt).toISOString()
          : null,
        latestObservationAt: row?.latestObservationAt
          ? new Date(row.latestObservationAt).toISOString()
          : null,
        summary,
      };
      if (status !== 'healthy') {
        throw new ServiceUnavailableException(health);
      }
      return health;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }
      throw new ServiceUnavailableException({
        status: 'unavailable',
        mode: mode ?? 'invalid',
        staleAfterSeconds,
        oldestObservationAt: null,
        latestObservationAt: null,
        summary: null,
      });
    }
  }

  @Get('map-archives')
  mapArchives(): {
    status: 'disabled' | 'configured';
    enabled: boolean;
    resources: { geojson: boolean; pmtiles: boolean };
  } {
    const enabled =
      this.configService.get<string>('DATAGOUV_MAP_ARCHIVES_ENABLED') ===
      'true';
    const resources = {
      geojson: Boolean(
        this.configService
          .get<string>('API_DATAGOUV_GEOJSON_ARCHIVE_RESOURCE_ID')
          ?.trim(),
      ),
      pmtiles: Boolean(
        this.configService
          .get<string>('API_DATAGOUV_PMTILES_ARCHIVE_RESOURCE_ID')
          ?.trim(),
      ),
    };
    if (!enabled) {
      return { status: 'disabled', enabled, resources };
    }
    if (!resources.geojson || !resources.pmtiles) {
      throw new ServiceUnavailableException({
        status: 'not_configured',
        enabled,
        resources,
      });
    }
    return { status: 'configured', enabled, resources };
  }

  @Get('clock')
  async clock() {
    try {
      const health = await this.clockHeartbeat.getHealthStatus();
      if (health.status !== 'healthy') {
        throw new ServiceUnavailableException(health);
      }
      return health;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }
      throw new ServiceUnavailableException({
        status: 'unavailable',
        lastSeenAt: null,
        ageSeconds: null,
      });
    }
  }
}
