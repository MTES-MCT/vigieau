import { MigrationInterface, QueryRunner } from 'typeorm';

export class StatisticCachePublication1786744800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "statistic_cache_publication" (
        "id" uuid NOT NULL,
        "statisticRevision" bigint NOT NULL,
        "currentPublishedDate" date NOT NULL,
        "schemaVersion" integer NOT NULL DEFAULT 1,
        "mode" character varying(20) NOT NULL,
        "materializationStrategy" character varying(30) NOT NULL,
        "status" character varying(20) NOT NULL,
        "historicDirtyFrom" date,
        "historicDirtyThrough" date,
        "historicMapCursor" date,
        "historicStatsCursor" date,
        "sourceRevision" bigint,
        "historicComputeEpoch" bigint,
        "firstDate" date NOT NULL,
        "latestDate" date NOT NULL,
        "dateCount" integer NOT NULL,
        "areaCount" integer NOT NULL,
        "departmentCount" integer NOT NULL,
        "communeCount" integer NOT NULL,
        "contentFingerprint" character varying(64),
        "compressedByteLength" bigint NOT NULL DEFAULT 0,
        "uncompressedByteLength" bigint NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "readyAt" TIMESTAMP WITH TIME ZONE,
        "activatedAt" TIMESTAMP WITH TIME ZONE,
        "retiredAt" TIMESTAMP WITH TIME ZONE,
        "failedAt" TIMESTAMP WITH TIME ZONE,
        "lastError" text,
        CONSTRAINT "PK_statistic_cache_publication" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_statistic_cache_publication_instance_identity"
          UNIQUE (
            "id", "statisticRevision", "currentPublishedDate",
            "contentFingerprint"
          ),
        CONSTRAINT "CHK_statistic_cache_publication_mode" CHECK (
          "mode" IN ('legacy-bootstrap', 'versioned')
        ),
        CONSTRAINT "CHK_statistic_cache_publication_status" CHECK (
          "status" IN ('building', 'ready', 'active', 'retired', 'failed')
        ),
        CONSTRAINT "CHK_statistic_cache_publication_strategy" CHECK (
          "materializationStrategy" IN (
            'full-clean', 'legacy-safe-boundary', 'daily-delta',
            'current-replace'
          )
        ),
        CONSTRAINT "CHK_statistic_cache_publication_revision" CHECK (
          "statisticRevision" >= 0
        ),
        CONSTRAINT "CHK_statistic_cache_publication_schema_version" CHECK (
          "schemaVersion" > 0
        ),
        CONSTRAINT "CHK_statistic_cache_publication_date_range" CHECK (
          "firstDate" <= "latestDate"
          AND "latestDate" <= "currentPublishedDate"
        ),
        CONSTRAINT "CHK_statistic_cache_publication_counts" CHECK (
          "dateCount" > 0
          AND "areaCount" >= 0
          AND "departmentCount" >= 0
          AND "communeCount" >= 0
          AND "compressedByteLength" >= 0
          AND "uncompressedByteLength" >= 0
        ),
        CONSTRAINT "CHK_statistic_cache_publication_fingerprint" CHECK (
          "contentFingerprint" IS NULL
          OR "contentFingerprint" ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT "CHK_statistic_cache_publication_ready_content" CHECK (
          "status" IN ('building', 'failed')
          OR (
            "contentFingerprint" IS NOT NULL
            AND "latestDate" = "currentPublishedDate"
            AND "compressedByteLength" > 0
            AND "uncompressedByteLength" > 0
          )
        ),
        CONSTRAINT "CHK_statistic_cache_publication_dirty_range" CHECK (
          (
            "historicDirtyFrom" IS NULL
            AND "historicDirtyThrough" IS NULL
          )
          OR (
            "historicDirtyFrom" IS NOT NULL
            AND "historicDirtyThrough" IS NOT NULL
            AND "historicDirtyFrom" <= "historicDirtyThrough"
          )
        ),
        CONSTRAINT "CHK_statistic_cache_publication_cursor_pair" CHECK (
          (
            "historicMapCursor" IS NULL
            AND "historicStatsCursor" IS NULL
          )
          OR (
            "historicMapCursor" IS NOT NULL
            AND "historicStatsCursor" IS NOT NULL
          )
        ),
        CONSTRAINT "CHK_statistic_cache_publication_source_context" CHECK (
          ("sourceRevision" IS NULL OR "sourceRevision" >= 0)
          AND (
            "historicComputeEpoch" IS NULL
            OR "historicComputeEpoch" >= 0
          )
        ),
        CONSTRAINT "CHK_statistic_cache_publication_safe_boundary" CHECK (
          "materializationStrategy" <> 'legacy-safe-boundary'
          OR (
            "mode" = 'legacy-bootstrap'
            AND "historicDirtyFrom" IS NOT NULL
            AND "historicDirtyThrough" IS NOT NULL
            AND "historicMapCursor" IS NOT NULL
            AND "historicStatsCursor" IS NOT NULL
            AND "sourceRevision" IS NOT NULL
            AND "historicComputeEpoch" IS NOT NULL
          )
        ),
        CONSTRAINT "CHK_statistic_cache_publication_lifecycle" CHECK (
          CASE "status"
            WHEN 'building' THEN
              "readyAt" IS NULL
              AND "activatedAt" IS NULL
              AND "retiredAt" IS NULL
              AND "failedAt" IS NULL
              AND "lastError" IS NULL
            WHEN 'ready' THEN
              "readyAt" IS NOT NULL
              AND "activatedAt" IS NULL
              AND "retiredAt" IS NULL
              AND "failedAt" IS NULL
              AND "lastError" IS NULL
            WHEN 'active' THEN
              "readyAt" IS NOT NULL
              AND "activatedAt" IS NOT NULL
              AND "retiredAt" IS NULL
              AND "failedAt" IS NULL
              AND "lastError" IS NULL
            WHEN 'retired' THEN
              "readyAt" IS NOT NULL
              AND "activatedAt" IS NOT NULL
              AND "retiredAt" IS NOT NULL
              AND "failedAt" IS NULL
              AND "lastError" IS NULL
            WHEN 'failed' THEN
              "readyAt" IS NULL
              AND "activatedAt" IS NULL
              AND "retiredAt" IS NULL
              AND "failedAt" IS NOT NULL
              AND "lastError" IS NOT NULL
            ELSE false
          END
        )
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "statistic_cache_artifact" (
        "publicationId" uuid NOT NULL,
        "kind" character varying(20) NOT NULL,
        "contentEncoding" character varying(20) NOT NULL DEFAULT 'gzip',
        "contentType" character varying(50) NOT NULL DEFAULT 'application/json',
        "rowCount" integer NOT NULL,
        "contentFingerprint" character varying(64) NOT NULL,
        "checksum" character varying(64) NOT NULL,
        "compressedByteLength" bigint NOT NULL,
        "uncompressedByteLength" bigint NOT NULL,
        "payload" bytea NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_statistic_cache_artifact"
          PRIMARY KEY ("publicationId", "kind"),
        CONSTRAINT "CHK_statistic_cache_artifact_kind" CHECK (
          "kind" IN ('area', 'departement', 'commune')
        ),
        CONSTRAINT "CHK_statistic_cache_artifact_encoding" CHECK (
          "contentEncoding" = 'gzip'
          AND "contentType" = 'application/json'
        ),
        CONSTRAINT "CHK_statistic_cache_artifact_fingerprints" CHECK (
          "contentFingerprint" ~ '^[0-9a-f]{64}$'
          AND "checksum" ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT "CHK_statistic_cache_artifact_lengths" CHECK (
          "rowCount" >= 0
          AND "compressedByteLength" > 0
          AND "uncompressedByteLength" > 0
          AND "compressedByteLength" = octet_length("payload")
        ),
        CONSTRAINT "FK_statistic_cache_artifact_publication"
          FOREIGN KEY ("publicationId")
          REFERENCES "statistic_cache_publication"("id")
          ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "statistic_cache_state" (
        "id" integer NOT NULL DEFAULT 1,
        "activePublicationId" uuid,
        "previousPublicationId" uuid,
        "historicRecoveryMonthlyFrom" date,
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_statistic_cache_state" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_statistic_cache_state_singleton" CHECK ("id" = 1),
        CONSTRAINT "CHK_statistic_cache_state_distinct_publications" CHECK (
          "activePublicationId" IS NULL
          OR "previousPublicationId" IS NULL
          OR "activePublicationId" <> "previousPublicationId"
        ),
        CONSTRAINT "FK_statistic_cache_state_active"
          FOREIGN KEY ("activePublicationId")
          REFERENCES "statistic_cache_publication"("id")
          ON DELETE RESTRICT,
        CONSTRAINT "FK_statistic_cache_state_previous"
          FOREIGN KEY ("previousPublicationId")
          REFERENCES "statistic_cache_publication"("id")
          ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "statistic_cache_state"
      ADD COLUMN IF NOT EXISTS "historicRecoveryMonthlyFrom" date
    `);

    await queryRunner.query(`
      ALTER TABLE "zone_publication_instance"
      ADD COLUMN IF NOT EXISTS "statisticCachePublicationId" uuid,
      ADD COLUMN IF NOT EXISTS "statisticRevision" bigint,
      ADD COLUMN IF NOT EXISTS "statisticPublishedDate" date,
      ADD COLUMN IF NOT EXISTS "statisticFingerprint" character varying(64),
      ADD COLUMN IF NOT EXISTS "statisticLastError" text
    `);

    const keyConstraints = [
      {
        name: 'PK_statistic_cache_publication',
        table: 'statistic_cache_publication',
        type: 'p',
        columns: ['id'],
        definition: 'PRIMARY KEY ("id")',
      },
      {
        name: 'UQ_statistic_cache_publication_instance_identity',
        table: 'statistic_cache_publication',
        type: 'u',
        columns: [
          'id',
          'statisticRevision',
          'currentPublishedDate',
          'contentFingerprint',
        ],
        definition:
          'UNIQUE ("id", "statisticRevision", "currentPublishedDate", "contentFingerprint")',
      },
      {
        name: 'PK_statistic_cache_artifact',
        table: 'statistic_cache_artifact',
        type: 'p',
        columns: ['publicationId', 'kind'],
        definition: 'PRIMARY KEY ("publicationId", "kind")',
      },
      {
        name: 'PK_statistic_cache_state',
        table: 'statistic_cache_state',
        type: 'p',
        columns: ['id'],
        definition: 'PRIMARY KEY ("id")',
      },
    ];
    for (const constraint of keyConstraints) {
      const columns = constraint.columns
        .map((column) => `'${column}'`)
        .join(', ');
      await queryRunner.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint existing_constraint
            WHERE existing_constraint.conrelid = '"${constraint.table}"'::regclass
              AND existing_constraint.contype = '${constraint.type}'
              AND (
                SELECT array_agg(
                  attribute.attname::text ORDER BY key_column.ordinality
                )
                FROM unnest(existing_constraint.conkey) WITH ORDINALITY
                  AS key_column(attnum, ordinality)
                INNER JOIN pg_attribute attribute
                  ON attribute.attrelid = existing_constraint.conrelid
                  AND attribute.attnum = key_column.attnum
              ) = ARRAY[${columns}]::text[]
          ) THEN
            ALTER TABLE "${constraint.table}"
            ADD CONSTRAINT "${constraint.name}" ${constraint.definition};
          END IF;
        END
        $$
      `);
    }

    await queryRunner.query(`
      ALTER TABLE "statistic_cache_publication"
      DROP CONSTRAINT IF EXISTS "UQ_statistic_cache_publication_source"
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_statistic_cache_publication_source"
      ON "statistic_cache_publication" (
        "statisticRevision", "currentPublishedDate"
      )
    `);

    const checkConstraints = [
      {
        name: 'CHK_statistic_cache_publication_mode',
        table: 'statistic_cache_publication',
        definition: `"mode" IN ('legacy-bootstrap', 'versioned')`,
      },
      {
        name: 'CHK_statistic_cache_publication_status',
        table: 'statistic_cache_publication',
        definition: `"status" IN ('building', 'ready', 'active', 'retired', 'failed')`,
      },
      {
        name: 'CHK_statistic_cache_publication_strategy',
        table: 'statistic_cache_publication',
        definition: `
          "materializationStrategy" IN (
            'full-clean', 'legacy-safe-boundary', 'daily-delta',
            'current-replace'
          )
        `,
      },
      {
        name: 'CHK_statistic_cache_publication_revision',
        table: 'statistic_cache_publication',
        definition: '"statisticRevision" >= 0',
      },
      {
        name: 'CHK_statistic_cache_publication_schema_version',
        table: 'statistic_cache_publication',
        definition: '"schemaVersion" > 0',
      },
      {
        name: 'CHK_statistic_cache_publication_date_range',
        table: 'statistic_cache_publication',
        definition:
          '"firstDate" <= "latestDate" AND "latestDate" <= "currentPublishedDate"',
      },
      {
        name: 'CHK_statistic_cache_publication_counts',
        table: 'statistic_cache_publication',
        definition: `
          "dateCount" > 0
          AND "areaCount" >= 0
          AND "departmentCount" >= 0
          AND "communeCount" >= 0
          AND "compressedByteLength" >= 0
          AND "uncompressedByteLength" >= 0
        `,
      },
      {
        name: 'CHK_statistic_cache_publication_fingerprint',
        table: 'statistic_cache_publication',
        definition: `
          "contentFingerprint" IS NULL
          OR "contentFingerprint" ~ '^[0-9a-f]{64}$'
        `,
      },
      {
        name: 'CHK_statistic_cache_publication_ready_content',
        table: 'statistic_cache_publication',
        definition: `
          "status" IN ('building', 'failed')
          OR (
            "contentFingerprint" IS NOT NULL
            AND "latestDate" = "currentPublishedDate"
            AND "compressedByteLength" > 0
            AND "uncompressedByteLength" > 0
          )
        `,
      },
      {
        name: 'CHK_statistic_cache_publication_lifecycle',
        table: 'statistic_cache_publication',
        definition: `
          CASE "status"
            WHEN 'building' THEN
              "readyAt" IS NULL
              AND "activatedAt" IS NULL
              AND "retiredAt" IS NULL
              AND "failedAt" IS NULL
              AND "lastError" IS NULL
            WHEN 'ready' THEN
              "readyAt" IS NOT NULL
              AND "activatedAt" IS NULL
              AND "retiredAt" IS NULL
              AND "failedAt" IS NULL
              AND "lastError" IS NULL
            WHEN 'active' THEN
              "readyAt" IS NOT NULL
              AND "activatedAt" IS NOT NULL
              AND "retiredAt" IS NULL
              AND "failedAt" IS NULL
              AND "lastError" IS NULL
            WHEN 'retired' THEN
              "readyAt" IS NOT NULL
              AND "activatedAt" IS NOT NULL
              AND "retiredAt" IS NOT NULL
              AND "failedAt" IS NULL
              AND "lastError" IS NULL
            WHEN 'failed' THEN
              "readyAt" IS NULL
              AND "activatedAt" IS NULL
              AND "retiredAt" IS NULL
              AND "failedAt" IS NOT NULL
              AND "lastError" IS NOT NULL
            ELSE false
          END
        `,
      },
      {
        name: 'CHK_statistic_cache_publication_dirty_range',
        table: 'statistic_cache_publication',
        definition: `
          (
            "historicDirtyFrom" IS NULL
            AND "historicDirtyThrough" IS NULL
          )
          OR (
            "historicDirtyFrom" IS NOT NULL
            AND "historicDirtyThrough" IS NOT NULL
            AND "historicDirtyFrom" <= "historicDirtyThrough"
          )
        `,
      },
      {
        name: 'CHK_statistic_cache_publication_cursor_pair',
        table: 'statistic_cache_publication',
        definition: `
          (
            "historicMapCursor" IS NULL
            AND "historicStatsCursor" IS NULL
          )
          OR (
            "historicMapCursor" IS NOT NULL
            AND "historicStatsCursor" IS NOT NULL
          )
        `,
      },
      {
        name: 'CHK_statistic_cache_publication_source_context',
        table: 'statistic_cache_publication',
        definition: `
          ("sourceRevision" IS NULL OR "sourceRevision" >= 0)
          AND (
            "historicComputeEpoch" IS NULL
            OR "historicComputeEpoch" >= 0
          )
        `,
      },
      {
        name: 'CHK_statistic_cache_publication_safe_boundary',
        table: 'statistic_cache_publication',
        definition: `
          "materializationStrategy" <> 'legacy-safe-boundary'
          OR (
            "mode" = 'legacy-bootstrap'
            AND "historicDirtyFrom" IS NOT NULL
            AND "historicDirtyThrough" IS NOT NULL
            AND "historicMapCursor" IS NOT NULL
            AND "historicStatsCursor" IS NOT NULL
            AND "sourceRevision" IS NOT NULL
            AND "historicComputeEpoch" IS NOT NULL
          )
        `,
      },
      {
        name: 'CHK_statistic_cache_artifact_kind',
        table: 'statistic_cache_artifact',
        definition: `"kind" IN ('area', 'departement', 'commune')`,
      },
      {
        name: 'CHK_statistic_cache_artifact_encoding',
        table: 'statistic_cache_artifact',
        definition: `
          "contentEncoding" = 'gzip'
          AND "contentType" = 'application/json'
        `,
      },
      {
        name: 'CHK_statistic_cache_artifact_fingerprints',
        table: 'statistic_cache_artifact',
        definition: `
          "contentFingerprint" ~ '^[0-9a-f]{64}$'
          AND "checksum" ~ '^[0-9a-f]{64}$'
        `,
      },
      {
        name: 'CHK_statistic_cache_artifact_lengths',
        table: 'statistic_cache_artifact',
        definition: `
          "rowCount" >= 0
          AND "compressedByteLength" > 0
          AND "uncompressedByteLength" > 0
          AND "compressedByteLength" = octet_length("payload")
        `,
      },
      {
        name: 'CHK_statistic_cache_state_singleton',
        table: 'statistic_cache_state',
        definition: '"id" = 1',
      },
      {
        name: 'CHK_statistic_cache_state_distinct_publications',
        table: 'statistic_cache_state',
        definition: `
          "activePublicationId" IS NULL
          OR "previousPublicationId" IS NULL
          OR "activePublicationId" <> "previousPublicationId"
        `,
      },
      {
        name: 'CHK_zone_publication_instance_statistic_identity',
        table: 'zone_publication_instance',
        definition: `
          (
            "statisticCachePublicationId" IS NULL
            AND "statisticRevision" IS NULL
            AND "statisticPublishedDate" IS NULL
            AND "statisticFingerprint" IS NULL
          )
          OR (
            "statisticCachePublicationId" IS NOT NULL
            AND "statisticRevision" IS NOT NULL
            AND "statisticRevision" >= 0
            AND "statisticPublishedDate" IS NOT NULL
            AND "statisticFingerprint" ~ '^[0-9a-f]{64}$'
          )
        `,
      },
    ];
    for (const constraint of checkConstraints) {
      await queryRunner.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conname = '${constraint.name}'
              AND conrelid = '"${constraint.table}"'::regclass
          ) THEN
            ALTER TABLE "${constraint.table}"
            ADD CONSTRAINT "${constraint.name}"
            CHECK (${constraint.definition}) NOT VALID;
          END IF;
        END
        $$
      `);
      await queryRunner.query(`
        ALTER TABLE "${constraint.table}"
        VALIDATE CONSTRAINT "${constraint.name}"
      `);
    }

    const foreignKeys = [
      {
        name: 'FK_statistic_cache_artifact_publication',
        table: 'statistic_cache_artifact',
        definition: `
          FOREIGN KEY ("publicationId")
          REFERENCES "statistic_cache_publication"("id")
          ON DELETE CASCADE
        `,
      },
      {
        name: 'FK_statistic_cache_state_active',
        table: 'statistic_cache_state',
        definition: `
          FOREIGN KEY ("activePublicationId")
          REFERENCES "statistic_cache_publication"("id")
          ON DELETE RESTRICT
        `,
      },
      {
        name: 'FK_statistic_cache_state_previous',
        table: 'statistic_cache_state',
        definition: `
          FOREIGN KEY ("previousPublicationId")
          REFERENCES "statistic_cache_publication"("id")
          ON DELETE RESTRICT
        `,
      },
      {
        name: 'FK_zone_publication_instance_statistic_cache',
        table: 'zone_publication_instance',
        definition: `
          FOREIGN KEY (
            "statisticCachePublicationId", "statisticRevision",
            "statisticPublishedDate", "statisticFingerprint"
          ) REFERENCES "statistic_cache_publication"(
            "id", "statisticRevision", "currentPublishedDate",
            "contentFingerprint"
          ) ON DELETE SET NULL
        `,
      },
    ];
    for (const foreignKey of foreignKeys) {
      await queryRunner.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conname = '${foreignKey.name}'
              AND conrelid = '"${foreignKey.table}"'::regclass
          ) THEN
            ALTER TABLE "${foreignKey.table}"
            ADD CONSTRAINT "${foreignKey.name}"
            ${foreignKey.definition} NOT VALID;
          END IF;
        END
        $$
      `);
      await queryRunner.query(`
        ALTER TABLE "${foreignKey.table}"
        VALIDATE CONSTRAINT "${foreignKey.name}"
      `);
    }

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION enforce_statistic_cache_publication_immutable()
      RETURNS trigger AS $$
      DECLARE
        artifact_count integer;
        total_compressed_bytes numeric;
        total_uncompressed_bytes numeric;
        area_rows integer;
        department_rows integer;
        commune_rows integer;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD."status" = 'active' THEN
            RAISE EXCEPTION 'Active statistic cache publication % cannot be deleted',
              OLD."id" USING ERRCODE = '23514';
          END IF;
          RETURN OLD;
        END IF;

        IF NEW."id" IS DISTINCT FROM OLD."id"
          OR NEW."statisticRevision" IS DISTINCT FROM OLD."statisticRevision"
          OR NEW."currentPublishedDate" IS DISTINCT FROM OLD."currentPublishedDate"
          OR NEW."schemaVersion" IS DISTINCT FROM OLD."schemaVersion"
          OR NEW."mode" IS DISTINCT FROM OLD."mode"
          OR NEW."materializationStrategy" IS DISTINCT FROM OLD."materializationStrategy"
          OR NEW."historicDirtyFrom" IS DISTINCT FROM OLD."historicDirtyFrom"
          OR NEW."historicDirtyThrough" IS DISTINCT FROM OLD."historicDirtyThrough"
          OR NEW."historicMapCursor" IS DISTINCT FROM OLD."historicMapCursor"
          OR NEW."historicStatsCursor" IS DISTINCT FROM OLD."historicStatsCursor"
          OR NEW."sourceRevision" IS DISTINCT FROM OLD."sourceRevision"
          OR NEW."historicComputeEpoch" IS DISTINCT FROM OLD."historicComputeEpoch"
          OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
        THEN
          RAISE EXCEPTION 'Statistic cache publication % identity is immutable',
            OLD."id" USING ERRCODE = '23514';
        END IF;

        IF OLD."status" <> 'building' AND (
          NEW."firstDate" IS DISTINCT FROM OLD."firstDate"
          OR NEW."latestDate" IS DISTINCT FROM OLD."latestDate"
          OR NEW."dateCount" IS DISTINCT FROM OLD."dateCount"
          OR NEW."areaCount" IS DISTINCT FROM OLD."areaCount"
          OR NEW."departmentCount" IS DISTINCT FROM OLD."departmentCount"
          OR NEW."communeCount" IS DISTINCT FROM OLD."communeCount"
          OR NEW."contentFingerprint" IS DISTINCT FROM OLD."contentFingerprint"
          OR NEW."compressedByteLength" IS DISTINCT FROM OLD."compressedByteLength"
          OR NEW."uncompressedByteLength" IS DISTINCT FROM OLD."uncompressedByteLength"
        ) THEN
          RAISE EXCEPTION 'Statistic cache publication % content is immutable in status %',
            OLD."id", OLD."status" USING ERRCODE = '23514';
        END IF;

        IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
          (OLD."status" = 'building' AND NEW."status" IN ('ready', 'failed'))
          OR (OLD."status" = 'ready' AND NEW."status" IN ('active', 'retired'))
          OR (OLD."status" = 'active' AND NEW."status" = 'retired')
          OR (OLD."status" = 'retired' AND NEW."status" = 'active')
        ) THEN
          RAISE EXCEPTION 'Invalid statistic cache publication transition % -> % for %',
            OLD."status", NEW."status", OLD."id" USING ERRCODE = '23514';
        END IF;

        IF OLD."status" = 'building' AND NEW."status" = 'ready' THEN
          SELECT
            count(*)::integer,
            COALESCE(sum("compressedByteLength"), 0),
            COALESCE(sum("uncompressedByteLength"), 0),
            max("rowCount") FILTER (WHERE "kind" = 'area'),
            max("rowCount") FILTER (WHERE "kind" = 'departement'),
            max("rowCount") FILTER (WHERE "kind" = 'commune')
          INTO
            artifact_count,
            total_compressed_bytes,
            total_uncompressed_bytes,
            area_rows,
            department_rows,
            commune_rows
          FROM "statistic_cache_artifact"
          WHERE "publicationId" = NEW."id";

          IF artifact_count <> 3
            OR area_rows IS NULL
            OR department_rows IS NULL
            OR commune_rows IS NULL
            OR area_rows <> NEW."dateCount"
            OR NEW."areaCount" <> NEW."dateCount"
            OR department_rows <> NEW."dateCount"
            OR commune_rows <> NEW."communeCount"
            OR total_compressed_bytes <> NEW."compressedByteLength"
            OR total_uncompressed_bytes <> NEW."uncompressedByteLength"
          THEN
            RAISE EXCEPTION 'Statistic cache publication % does not have a complete artifact set',
              NEW."id" USING ERRCODE = '23514';
          END IF;
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_statistic_cache_publication_immutable"
      ON "statistic_cache_publication"
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_statistic_cache_publication_immutable"
      BEFORE UPDATE OR DELETE ON "statistic_cache_publication"
      FOR EACH ROW EXECUTE FUNCTION enforce_statistic_cache_publication_immutable()
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION enforce_statistic_cache_artifact_immutable()
      RETURNS trigger AS $$
      DECLARE
        publication_status character varying(20);
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          RAISE EXCEPTION 'Statistic cache artifact %/% is immutable',
            OLD."publicationId", OLD."kind" USING ERRCODE = '23514';
        END IF;

        SELECT "status"
        INTO publication_status
        FROM "statistic_cache_publication"
        WHERE "id" = COALESCE(NEW."publicationId", OLD."publicationId");

        IF TG_OP = 'INSERT' AND publication_status IS DISTINCT FROM 'building' THEN
          RAISE EXCEPTION 'Statistic cache artifacts can only be added while building'
            USING ERRCODE = '23514';
        END IF;
        IF TG_OP = 'DELETE'
          AND publication_status IS NOT NULL
          AND publication_status NOT IN ('building', 'failed')
          AND pg_trigger_depth() = 1
        THEN
          RAISE EXCEPTION 'Statistic cache artifact %/% is immutable in publication status %',
            OLD."publicationId", OLD."kind", publication_status
            USING ERRCODE = '23514';
        END IF;

        IF TG_OP = 'DELETE' THEN
          RETURN OLD;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_statistic_cache_artifact_immutable"
      ON "statistic_cache_artifact"
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_statistic_cache_artifact_immutable"
      BEFORE INSERT OR UPDATE OR DELETE ON "statistic_cache_artifact"
      FOR EACH ROW EXECUTE FUNCTION enforce_statistic_cache_artifact_immutable()
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION enforce_statistic_cache_state_targets()
      RETURNS trigger AS $$
      DECLARE
        active_status character varying(20);
        previous_status character varying(20);
      BEGIN
        IF NEW."activePublicationId" IS NOT NULL THEN
          SELECT "status" INTO active_status
          FROM "statistic_cache_publication"
          WHERE "id" = NEW."activePublicationId";
          IF active_status IS DISTINCT FROM 'active' THEN
            RAISE EXCEPTION 'Active statistic cache pointer must reference an active publication'
              USING ERRCODE = '23514';
          END IF;
        END IF;

        IF NEW."previousPublicationId" IS NOT NULL THEN
          SELECT "status" INTO previous_status
          FROM "statistic_cache_publication"
          WHERE "id" = NEW."previousPublicationId";
          IF previous_status IS DISTINCT FROM 'retired' THEN
            RAISE EXCEPTION 'Previous statistic cache pointer must reference a retired publication'
              USING ERRCODE = '23514';
          END IF;
        END IF;

        NEW."updatedAt" := now();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_statistic_cache_state_targets"
      ON "statistic_cache_state"
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_statistic_cache_state_targets"
      BEFORE INSERT OR UPDATE ON "statistic_cache_state"
      FOR EACH ROW EXECUTE FUNCTION enforce_statistic_cache_state_targets()
    `);

    await queryRunner.query(`
      INSERT INTO "statistic_cache_state" (
        "id", "activePublicationId", "previousPublicationId", "updatedAt"
      ) VALUES (1, NULL, NULL, now())
      ON CONFLICT ("id") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "zone_publication_instance"
      DROP CONSTRAINT IF EXISTS "FK_zone_publication_instance_statistic_cache",
      DROP CONSTRAINT IF EXISTS "CHK_zone_publication_instance_statistic_identity"
    `);
    await queryRunner.query(`
      ALTER TABLE "zone_publication_instance"
      DROP COLUMN IF EXISTS "statisticLastError",
      DROP COLUMN IF EXISTS "statisticFingerprint",
      DROP COLUMN IF EXISTS "statisticPublishedDate",
      DROP COLUMN IF EXISTS "statisticRevision",
      DROP COLUMN IF EXISTS "statisticCachePublicationId"
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_statistic_cache_state_targets"
      ON "statistic_cache_state"
    `);
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS enforce_statistic_cache_state_targets',
    );
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_statistic_cache_artifact_immutable"
      ON "statistic_cache_artifact"
    `);
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS enforce_statistic_cache_artifact_immutable',
    );
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_statistic_cache_publication_immutable"
      ON "statistic_cache_publication"
    `);
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS enforce_statistic_cache_publication_immutable',
    );
    await queryRunner.query('DROP TABLE IF EXISTS "statistic_cache_state"');
    await queryRunner.query('DROP TABLE IF EXISTS "statistic_cache_artifact"');
    await queryRunner.query(
      'DROP TABLE IF EXISTS "statistic_cache_publication"',
    );
  }
}
