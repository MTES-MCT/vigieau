import { MigrationInterface, QueryRunner } from 'typeorm';

export class HistoricBackfillControlPlane1787144400000 implements MigrationInterface {
  name = 'HistoricBackfillControlPlane1787144400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '3s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '15min'`);

    await queryRunner.query(`
      ALTER TABLE "config"
      ADD COLUMN IF NOT EXISTS "historicBackfillGlobalEpoch"
        bigint NOT NULL DEFAULT 0
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "historic_backfill_department_revision" (
        "departementId" integer NOT NULL,
        "generation" bigint NOT NULL DEFAULT 0,
        "lastPublicRevision" bigint NOT NULL DEFAULT 0,
        "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
        CONSTRAINT "PK_historic_backfill_department_revision"
          PRIMARY KEY ("departementId"),
        CONSTRAINT "FK_historic_backfill_department_revision_departement"
          FOREIGN KEY ("departementId") REFERENCES "departement"("id")
          ON DELETE CASCADE,
        CONSTRAINT "CHK_historic_backfill_department_revision_values"
          CHECK ("generation" >= 0 AND "lastPublicRevision" >= 0)
      )
    `);
    await queryRunner.query(`
      INSERT INTO "historic_backfill_department_revision" (
        "departementId", "generation", "lastPublicRevision"
      )
      SELECT departement."id", 0, 0
      FROM "departement" departement
      ON CONFLICT ("departementId") DO NOTHING
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "IDX_historic_backfill_department_revision_generation"
      ON "historic_backfill_department_revision" (
        "generation", "lastPublicRevision"
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "historic_backfill_run" (
        "id" uuid NOT NULL,
        "status" varchar(20) NOT NULL,
        "mapDateFrom" date NOT NULL,
        "statisticDateFrom" date NOT NULL,
        "dateThrough" date NOT NULL,
        "sourceRevision" bigint NOT NULL,
        "historicComputeEpoch" bigint NOT NULL,
        "historicBackfillGlobalEpoch" bigint NOT NULL,
        "baseStatisticRevision" bigint NOT NULL,
        "statisticsPromotedAt" timestamp with time zone,
        "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
        "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
        "startedAt" timestamp with time zone,
        "pausedAt" timestamp with time zone,
        "completedAt" timestamp with time zone,
        "lastError" text,
        CONSTRAINT "PK_historic_backfill_run" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_historic_backfill_run_status"
          CHECK (
            "status" IN (
              'preparing', 'running', 'paused', 'completed', 'failed'
            )
          ),
        CONSTRAINT "CHK_historic_backfill_run_date_range"
          CHECK (
            "mapDateFrom" <= "dateThrough"
            AND "statisticDateFrom" <= "dateThrough"
          ),
        CONSTRAINT "CHK_historic_backfill_run_revisions"
          CHECK (
            "sourceRevision" >= 0
            AND "historicComputeEpoch" >= 0
            AND "historicBackfillGlobalEpoch" >= 0
            AND "baseStatisticRevision" >= 0
          )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_historic_backfill_run_status"
      ON "historic_backfill_run" ("status", "updatedAt")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_historic_backfill_run_active"
      ON "historic_backfill_run" ((1))
      WHERE "status" IN ('preparing', 'running', 'paused')
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_historic_backfill_run_context"
      ON "historic_backfill_run" (
        "sourceRevision", "historicComputeEpoch", "historicBackfillGlobalEpoch"
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "historic_backfill_task" (
        "runId" uuid NOT NULL,
        "departementId" integer NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT 'pending',
        "departmentGeneration" bigint NOT NULL,
        "progressDate" date,
        "segmentCount" integer NOT NULL DEFAULT 0,
        "communeCount" integer NOT NULL DEFAULT 0,
        "outputSignature" varchar(64),
        "artifactPrefix" text,
        "attemptCount" integer NOT NULL DEFAULT 0,
        "leaseOwner" varchar(200),
        "leaseToken" uuid,
        "leaseExpiresAt" timestamp with time zone,
        "heartbeatAt" timestamp with time zone,
        "nextAttemptAt" timestamp with time zone NOT NULL DEFAULT now(),
        "startedAt" timestamp with time zone,
        "completedAt" timestamp with time zone,
        "lastError" text,
        "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
        "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
        CONSTRAINT "PK_historic_backfill_task"
          PRIMARY KEY ("runId", "departementId"),
        CONSTRAINT "FK_historic_backfill_task_run"
          FOREIGN KEY ("runId") REFERENCES "historic_backfill_run"("id")
          ON DELETE CASCADE,
        CONSTRAINT "FK_historic_backfill_task_departement"
          FOREIGN KEY ("departementId") REFERENCES "departement"("id")
          ON DELETE RESTRICT,
        CONSTRAINT "CHK_historic_backfill_task_status"
          CHECK ("status" IN ('pending', 'leased', 'completed', 'failed')),
        CONSTRAINT "CHK_historic_backfill_task_counts"
          CHECK (
            "attemptCount" >= 0
            AND "departmentGeneration" >= 0
            AND "segmentCount" >= 0
            AND "communeCount" >= 0
          ),
        CONSTRAINT "CHK_historic_backfill_task_lease"
          CHECK (
            (
              "status" = 'leased'
              AND "leaseOwner" IS NOT NULL
              AND "leaseToken" IS NOT NULL
              AND "leaseExpiresAt" IS NOT NULL
            )
            OR (
              "status" <> 'leased'
              AND "leaseOwner" IS NULL
              AND "leaseToken" IS NULL
              AND "leaseExpiresAt" IS NULL
            )
          ),
        CONSTRAINT "CHK_historic_backfill_task_output_signature"
          CHECK (
            "outputSignature" IS NULL
            OR "outputSignature" ~ '^[0-9a-f]{64}$'
          )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_historic_backfill_task_claim"
      ON "historic_backfill_task" ("runId", "nextAttemptAt", "createdAt")
      WHERE "status" = 'pending'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_historic_backfill_task_expired_lease"
      ON "historic_backfill_task" ("leaseExpiresAt")
      WHERE "status" = 'leased'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "IDX_historic_backfill_task_department_generation"
      ON "historic_backfill_task" (
        "departementId", "departmentGeneration"
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "historic_backfill_commune_segment" (
        "runId" uuid NOT NULL,
        "departementId" integer NOT NULL,
        "communeId" integer NOT NULL,
        "validFrom" date NOT NULL,
        "validThrough" date NOT NULL,
        "SOU" varchar(20),
        "SUP" varchar(20),
        "AEP" varchar(20),
        "sourceGeneration" bigint NOT NULL,
        "inputSignature" varchar(64) NOT NULL,
        "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
        CONSTRAINT "PK_historic_backfill_commune_segment"
          PRIMARY KEY ("runId", "communeId", "validFrom"),
        CONSTRAINT "FK_historic_backfill_commune_segment_run"
          FOREIGN KEY ("runId") REFERENCES "historic_backfill_run"("id")
          ON DELETE CASCADE,
        CONSTRAINT "FK_historic_backfill_commune_segment_departement"
          FOREIGN KEY ("departementId") REFERENCES "departement"("id")
          ON DELETE RESTRICT,
        CONSTRAINT "FK_historic_backfill_commune_segment_task"
          FOREIGN KEY ("runId", "departementId")
          REFERENCES "historic_backfill_task"("runId", "departementId")
          ON DELETE CASCADE,
        CONSTRAINT "FK_historic_backfill_commune_segment_commune"
          FOREIGN KEY ("communeId") REFERENCES "commune"("id")
          ON DELETE RESTRICT,
        CONSTRAINT "CHK_historic_backfill_commune_segment_date_range"
          CHECK ("validFrom" <= "validThrough"),
        CONSTRAINT "CHK_historic_backfill_commune_segment_levels"
          CHECK (
            (
              "SOU" IS NULL
              OR "SOU" IN (
                'vigilance', 'alerte', 'alerte_renforcee', 'crise'
              )
            )
            AND (
              "SUP" IS NULL
              OR "SUP" IN (
                'vigilance', 'alerte', 'alerte_renforcee', 'crise'
              )
            )
            AND (
              "AEP" IS NULL
              OR "AEP" IN (
                'vigilance', 'alerte', 'alerte_renforcee', 'crise'
              )
            )
          ),
        CONSTRAINT "CHK_historic_backfill_commune_segment_generation"
          CHECK ("sourceGeneration" >= 0),
        CONSTRAINT "CHK_historic_backfill_commune_segment_signature"
          CHECK ("inputSignature" ~ '^[0-9a-f]{64}$')
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "IDX_historic_backfill_commune_segment_run_department_dates"
      ON "historic_backfill_commune_segment" (
        "runId", "departementId", "validFrom", "validThrough"
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "historic_backfill_department_segment" (
        "runId" uuid NOT NULL,
        "departementId" integer NOT NULL,
        "validFrom" date NOT NULL,
        "validThrough" date NOT NULL,
        "sourceGeneration" bigint NOT NULL,
        "inputSignature" varchar(64) NOT NULL,
        "restriction" jsonb NOT NULL,
        "situation" jsonb NOT NULL,
        "geojsonObjectKey" text NOT NULL,
        "geojsonChecksum" varchar(64) NOT NULL,
        "featureCount" integer NOT NULL,
        "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
        CONSTRAINT "PK_historic_backfill_department_segment"
          PRIMARY KEY ("runId", "departementId", "validFrom"),
        CONSTRAINT "FK_historic_backfill_department_segment_task"
          FOREIGN KEY ("runId", "departementId")
          REFERENCES "historic_backfill_task"("runId", "departementId")
          ON DELETE CASCADE,
        CONSTRAINT "CHK_historic_backfill_department_segment_date_range"
          CHECK ("validFrom" <= "validThrough"),
        CONSTRAINT "CHK_historic_backfill_department_segment_generation"
          CHECK ("sourceGeneration" >= 0),
        CONSTRAINT "CHK_historic_backfill_department_segment_signature"
          CHECK ("inputSignature" ~ '^[0-9a-f]{64}$'),
        CONSTRAINT "CHK_historic_backfill_department_segment_payloads"
          CHECK (
            jsonb_typeof("restriction") = 'object'
            AND jsonb_typeof("situation") = 'object'
          ),
        CONSTRAINT "CHK_historic_backfill_department_segment_artifact"
          CHECK (
            length("geojsonObjectKey") > 0
            AND "geojsonChecksum" ~ '^[0-9a-f]{64}$'
            AND "featureCount" >= 0
          )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "IDX_historic_backfill_department_segment_run_dates"
      ON "historic_backfill_department_segment" (
        "runId", "validFrom", "validThrough"
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "historic_backfill_commune_shadow" (
        "runId" uuid NOT NULL,
        "communeId" integer NOT NULL,
        "departementId" integer NOT NULL,
        "sourceGeneration" bigint NOT NULL,
        "restrictions" jsonb NOT NULL,
        "restrictionsByMonth" jsonb NOT NULL,
        "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
        "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
        CONSTRAINT "PK_historic_backfill_commune_shadow"
          PRIMARY KEY ("runId", "communeId"),
        CONSTRAINT "FK_historic_backfill_commune_shadow_task"
          FOREIGN KEY ("runId", "departementId")
          REFERENCES "historic_backfill_task"("runId", "departementId")
          ON DELETE CASCADE,
        CONSTRAINT "FK_historic_backfill_commune_shadow_commune"
          FOREIGN KEY ("communeId") REFERENCES "commune"("id")
          ON DELETE RESTRICT,
        CONSTRAINT "CHK_historic_backfill_commune_shadow_generation"
          CHECK ("sourceGeneration" >= 0),
        CONSTRAINT "CHK_historic_backfill_commune_shadow_arrays"
          CHECK (
            jsonb_typeof("restrictions") = 'array'
            AND jsonb_typeof("restrictionsByMonth") = 'array'
        )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "IDX_historic_backfill_commune_shadow_run_department"
      ON "historic_backfill_commune_shadow" ("runId", "departementId")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "historic_backfill_artifact_task" (
        "runId" uuid NOT NULL,
        "validFrom" date NOT NULL,
        "validThrough" date NOT NULL,
        "sourceRevision" bigint NOT NULL,
        "historicComputeEpoch" bigint NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT 'pending',
        "attemptCount" integer NOT NULL DEFAULT 0,
        "leaseOwner" varchar(200),
        "leaseToken" uuid,
        "leaseExpiresAt" timestamp with time zone,
        "heartbeatAt" timestamp with time zone,
        "nextAttemptAt" timestamp with time zone NOT NULL DEFAULT now(),
        "geojsonObjectKey" text,
        "geojsonChecksum" varchar(64),
        "pmtilesObjectKey" text,
        "pmtilesChecksum" varchar(64),
        "featureCount" integer NOT NULL DEFAULT 0,
        "startedAt" timestamp with time zone,
        "completedAt" timestamp with time zone,
        "lastError" text,
        "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
        "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
        CONSTRAINT "PK_historic_backfill_artifact_task"
          PRIMARY KEY ("runId", "validFrom"),
        CONSTRAINT "FK_historic_backfill_artifact_task_run"
          FOREIGN KEY ("runId") REFERENCES "historic_backfill_run"("id")
          ON DELETE CASCADE,
        CONSTRAINT "CHK_historic_backfill_artifact_task_range"
          CHECK ("validFrom" <= "validThrough"),
        CONSTRAINT "CHK_historic_backfill_artifact_task_status"
          CHECK ("status" IN ('pending', 'leased', 'completed', 'failed')),
        CONSTRAINT "CHK_historic_backfill_artifact_task_attempts"
          CHECK ("attemptCount" >= 0 AND "featureCount" >= 0),
        CONSTRAINT "CHK_historic_backfill_artifact_task_lease"
          CHECK (
            (
              "status" = 'leased'
              AND "leaseOwner" IS NOT NULL
              AND "leaseToken" IS NOT NULL
              AND "leaseExpiresAt" IS NOT NULL
            )
            OR (
              "status" <> 'leased'
              AND "leaseOwner" IS NULL
              AND "leaseToken" IS NULL
              AND "leaseExpiresAt" IS NULL
            )
          ),
        CONSTRAINT "CHK_historic_backfill_artifact_task_output"
          CHECK (
            "status" <> 'completed'
            OR (
              length("geojsonObjectKey") > 0
              AND "geojsonChecksum" ~ '^[0-9a-f]{64}$'
              AND length("pmtilesObjectKey") > 0
              AND "pmtilesChecksum" ~ '^[0-9a-f]{64}$'
            )
          )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_historic_backfill_artifact_task_claim"
      ON "historic_backfill_artifact_task" (
        "runId", "nextAttemptAt", "validFrom"
      )
      WHERE "status" = 'pending'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "IDX_historic_backfill_artifact_task_expired_lease"
      ON "historic_backfill_artifact_task" ("leaseExpiresAt")
      WHERE "status" = 'leased'
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "historic_backfill_map_manifest_outbox" (
        "runId" uuid NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT 'pending',
        "mapDateFrom" date NOT NULL,
        "dateThrough" date NOT NULL,
        "sourceRevision" bigint NOT NULL,
        "historicComputeEpoch" bigint NOT NULL,
        "mapGeneration" bigint NOT NULL,
        "statisticRevision" bigint NOT NULL,
        "artifactTaskCount" integer NOT NULL,
        "dayCount" integer NOT NULL,
        "manifestObjectKey" text NOT NULL,
        "manifestBody" text NOT NULL,
        "manifestChecksum" varchar(64) NOT NULL,
        "publishedAt" timestamp with time zone,
        "lastError" text,
        "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
        "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
        CONSTRAINT "PK_historic_backfill_map_manifest_outbox"
          PRIMARY KEY ("runId"),
        CONSTRAINT "FK_historic_backfill_map_manifest_outbox_run"
          FOREIGN KEY ("runId") REFERENCES "historic_backfill_run"("id")
          ON DELETE CASCADE,
        CONSTRAINT "CHK_historic_backfill_map_manifest_outbox_status"
          CHECK (
            ("status" = 'pending' AND "publishedAt" IS NULL)
            OR ("status" = 'published' AND "publishedAt" IS NOT NULL)
          ),
        CONSTRAINT "CHK_historic_backfill_map_manifest_outbox_values"
          CHECK (
            "mapDateFrom" <= "dateThrough"
            AND "sourceRevision" >= 0
            AND "historicComputeEpoch" >= 0
            AND "mapGeneration" >= 0
            AND "statisticRevision" >= 0
            AND "artifactTaskCount" > 0
            AND "dayCount" > 0
            AND length("manifestObjectKey") > 0
            AND length("manifestBody") > 0
            AND "manifestChecksum" ~ '^[0-9a-f]{64}$'
          )
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        "UQ_historic_backfill_map_manifest_outbox_pending"
      ON "historic_backfill_map_manifest_outbox" ("status")
      WHERE "status" = 'pending'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP TABLE IF EXISTS "historic_backfill_map_manifest_outbox"',
    );
    await queryRunner.query(
      'DROP TABLE IF EXISTS "historic_backfill_artifact_task"',
    );
    await queryRunner.query(
      'DROP TABLE IF EXISTS "historic_backfill_commune_shadow"',
    );
    await queryRunner.query(
      'DROP TABLE IF EXISTS "historic_backfill_department_segment"',
    );
    await queryRunner.query(
      'DROP TABLE IF EXISTS "historic_backfill_commune_segment"',
    );
    await queryRunner.query('DROP TABLE IF EXISTS "historic_backfill_task"');
    await queryRunner.query('DROP TABLE IF EXISTS "historic_backfill_run"');
    await queryRunner.query(
      'DROP TABLE IF EXISTS "historic_backfill_department_revision"',
    );
    await queryRunner.query(
      'ALTER TABLE "config" DROP COLUMN IF EXISTS "historicBackfillGlobalEpoch"',
    );
  }
}
