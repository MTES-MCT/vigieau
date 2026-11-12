import { MigrationInterface, QueryRunner } from 'typeorm';

// Frozen migration policy: new sources/fields require a new migration.
export const USER_ACTIVITY_AUDIT_SOURCES = [
  {
    table: 'user',
    keys: ['audit_id'],
    fields: [
      'audit_id',
      'email',
      'first_name',
      'last_name',
      'role',
      'role_departement',
      'role_departements',
      'role_communes',
      'check_rules',
    ],
    masked: [],
  },
  {
    table: 'arrete_cadre',
    keys: ['id'],
    fields: [
      'id',
      'numero',
      'dateDebut',
      'dateFin',
      'dateFinSaisie',
      'dateFinCalculee',
      'dateFinSaisieConnue',
      'statut',
      'fichierId',
      'departementPiloteId',
      'arreteCadreAbrogeId',
    ],
    masked: [],
  },
  {
    table: 'arrete_restriction',
    keys: ['id'],
    fields: [
      'id',
      'numero',
      'dateSignature',
      'dateDebut',
      'dateFin',
      'dateFinSaisie',
      'dateFinCalculee',
      'dateFinSaisieConnue',
      'statut',
      'fichierId',
      'departementId',
      'arreteRestrictionAbrogeId',
      'niveauGraviteSpecifiqueEap',
      'ressourceEapCommunique',
    ],
    masked: [],
  },
  {
    table: 'arrete_municipal',
    keys: ['id'],
    fields: ['id', 'dateDebut', 'dateFin', 'statut', 'fichierId'],
    masked: ['userFirstName', 'userLastName', 'userEmail', 'userPhone'],
  },
  {
    table: 'restriction',
    keys: ['id'],
    fields: [
      'id',
      'nomGroupementAep',
      'arreteRestrictionId',
      'arreteCadreId',
      'zoneAlerteId',
      'niveauGravite',
    ],
    masked: [],
  },
  {
    table: 'usage',
    keys: ['id'],
    fields: [
      'id',
      'nom',
      'thematiqueId',
      'isTemplate',
      'concerneParticulier',
      'concerneEntreprise',
      'concerneCollectivite',
      'concerneExploitation',
      'concerneEso',
      'concerneEsu',
      'concerneAep',
      'descriptionVigilance',
      'descriptionAlerte',
      'descriptionAlerteRenforcee',
      'descriptionCrise',
      'arreteCadreId',
      'restrictionId',
    ],
    masked: [],
  },
  {
    table: 'parametres',
    keys: ['id'],
    fields: [
      'id',
      'departementId',
      'superpositionCommune',
      'dateDebut',
      'dateFin',
      'disabled',
    ],
    masked: [],
  },
  {
    table: 'usage_feedback',
    keys: ['id'],
    fields: ['id', 'arreteRestrictionId', 'archived'],
    masked: ['feedback', 'usageDescription'],
  },
  {
    table: 'fichier',
    keys: ['id'],
    fields: ['id', 'nom', 'size', 'migrate'],
    masked: ['url'],
  },
  {
    table: 'zone_alerte',
    keys: ['id'],
    fields: [
      'id',
      'idSandre',
      'codeSandre',
      'statutSandre',
      'dateMajSandre',
      'codesAlternatifs',
      'sandrePayloadHash',
      'sandreProvenance',
      'nom',
      'code',
      'type',
      'ressourceInfluencee',
      'numeroVersion',
      'numeroVersionSandre',
      'disabled',
      'departementId',
      'bassinVersantId',
    ],
    masked: [],
    fingerprints: ['geom'],
  },
  {
    table: 'arrete_cadre_arrete_restriction',
    keys: ['arreteCadreId', 'arreteRestrictionId'],
    fields: ['arreteCadreId', 'arreteRestrictionId'],
    masked: [],
  },
  {
    table: 'arrete_cadre_departement',
    keys: ['arreteCadreId', 'departementId'],
    fields: ['arreteCadreId', 'departementId'],
    masked: [],
  },
  {
    table: 'arrete_cadre_zone_alerte',
    keys: ['arreteCadreId', 'zoneAlerteId'],
    fields: ['arreteCadreId', 'zoneAlerteId'],
    masked: [],
  },
  {
    table: 'arrete_cadre_zone_alerte_communes',
    keys: ['id'],
    fields: ['id', 'arreteCadreId', 'zoneAlerteId'],
    masked: [],
  },
  {
    table: 'ac_za_communes',
    keys: ['arreteCadreZoneAlerteCommunesId', 'communeId'],
    fields: ['arreteCadreZoneAlerteCommunesId', 'communeId'],
    masked: [],
  },
  {
    table: 'arrete_municipal_commune',
    keys: ['arreteMunicipalId', 'communeId'],
    fields: ['arreteMunicipalId', 'communeId'],
    masked: [],
  },
  {
    table: 'restriction_commune',
    keys: ['restrictionId', 'communeId'],
    fields: ['restrictionId', 'communeId'],
    masked: [],
  },
  {
    table: 'config',
    keys: ['id'],
    fields: [
      'id',
      'computeMapDate',
      'computeMapGeneration',
      'computeStatsDate',
      'computeStatsGeneration',
      'historicComputeEpoch',
      'historicBackfillGlobalEpoch',
      'computeZoneAlerteComputedDate',
    ],
    masked: [],
  },
  {
    table: 'zone_publication_state',
    keys: ['id'],
    fields: [
      'id',
      'activePublicationId',
      'candidatePublicationId',
      'automaticPublishingPaused',
    ],
    masked: [],
  },
  {
    table: 'zone_publication_source_state',
    keys: ['id'],
    fields: ['id', 'revision', 'publicRevision', 'legacyDualWrite'],
    masked: [],
  },
  {
    table: 'statistic_publication_state',
    keys: ['id'],
    fields: [
      'id',
      'revision',
      'currentPublishedDate',
      'historicPublishedThrough',
      'historicDirtyFrom',
      'historicDirtyThrough',
    ],
    masked: [],
  },
  {
    table: 'zone_type_availability',
    keys: ['departmentCode', 'zoneType'],
    fields: ['departmentCode', 'zoneType', 'status', 'asOf', 'publicRevision'],
    masked: ['officialUrl'],
  },
  {
    table: 'current_zone_recompute_request',
    keys: ['departementId'],
    fields: [
      'departementId',
      'generation',
      'targetPublicRevision',
      'currentPending',
      'scheduledFor',
      'pendingScheduledDates',
      'reason',
    ],
    masked: [],
  },
  {
    table: 'historic_backfill_run',
    keys: ['id'],
    fields: [
      'id',
      'status',
      'mapDateFrom',
      'statisticDateFrom',
      'dateThrough',
      'sourceRevision',
      'historicComputeEpoch',
      'historicBackfillGlobalEpoch',
      'baseStatisticRevision',
      'statisticsPromotedAt',
    ],
    masked: [],
  },
] as const;

const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
const identifier = (value: string) => `"${value.replace(/"/g, '""')}"`;

export class UserActivityAudit1794477600000 implements MigrationInterface {
  name = 'UserActivityAudit1794477600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const [{ schema }] = await queryRunner.query(
      'SELECT current_schema() AS schema',
    );
    const ns = identifier(schema);
    await queryRunner.query(`
      ALTER TABLE ${ns}."user" ADD COLUMN IF NOT EXISTS audit_id uuid
        NOT NULL DEFAULT gen_random_uuid();
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_user_audit_id" ON ${ns}."user" (audit_id);

      CREATE TABLE IF NOT EXISTS ${ns}.audit_event (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        operation_id uuid NOT NULL,
        occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        phase varchar(30) NOT NULL CHECK (phase IN (
          'started', 'applied', 'succeeded', 'failed', 'denied', 'accepted', 'read', 'unknown'
        )),
        action varchar(160) NOT NULL,
        actor jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(actor) = 'object'),
        source varchar(40) NOT NULL DEFAULT 'http',
        request_id uuid,
        method varchar(12),
        route varchar(255),
        metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
        db_txid text
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_audit_event_transaction"
        ON ${ns}.audit_event (operation_id, db_txid) WHERE db_txid IS NOT NULL;
      CREATE INDEX IF NOT EXISTS "IDX_audit_event_date" ON ${ns}.audit_event (occurred_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS "IDX_audit_event_operation" ON ${ns}.audit_event (operation_id, occurred_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS "IDX_audit_event_actor" ON ${ns}.audit_event ((actor->>'id'), occurred_at DESC);
      CREATE INDEX IF NOT EXISTS "IDX_audit_event_email" ON ${ns}.audit_event ((actor->>'email'), occurred_at DESC);
      CREATE INDEX IF NOT EXISTS "IDX_audit_event_action" ON ${ns}.audit_event (action, occurred_at DESC);

      CREATE TABLE IF NOT EXISTS ${ns}.audit_resource (
        id bigserial PRIMARY KEY,
        event_id uuid NOT NULL REFERENCES ${ns}.audit_event(id) ON DELETE CASCADE,
        resource_type varchar(100) NOT NULL,
        resource_id text NOT NULL,
        operation varchar(16) NOT NULL CHECK (operation IN ('create', 'update', 'delete', 'read')),
        "before" jsonb,
        "after" jsonb,
        changed_fields text[] NOT NULL DEFAULT '{}',
        territories text[] NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS "IDX_audit_resource_event" ON ${ns}.audit_resource(event_id, id);
      CREATE INDEX IF NOT EXISTS "IDX_audit_resource_reference" ON ${ns}.audit_resource(resource_type, resource_id, event_id);
      CREATE INDEX IF NOT EXISTS "IDX_audit_resource_territories" ON ${ns}.audit_resource USING gin(territories);

      CREATE TABLE IF NOT EXISTS ${ns}.audit_causality (
        id bigserial PRIMARY KEY,
        event_id uuid NOT NULL REFERENCES ${ns}.audit_event(id) ON DELETE CASCADE,
        kind varchar(100) NOT NULL,
        reference text NOT NULL,
        UNIQUE(event_id, kind, reference)
      );
      CREATE INDEX IF NOT EXISTS "IDX_audit_causality_reference" ON ${ns}.audit_causality(kind, reference, event_id);
    `);

    // The advisory lock serializes inserts and expiry deletion for a whole operation.
    // A connection-scoped flag cannot bypass the retention rule.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ${ns}.guard_user_activity_audit()
      RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, ${ns} AS $$
      DECLARE operation uuid; latest timestamptz;
      BEGIN
        IF TG_OP IN ('UPDATE', 'TRUNCATE') THEN
          RAISE EXCEPTION 'User activity audit is append-only' USING ERRCODE = '55000';
        END IF;
        IF TG_TABLE_NAME = 'audit_event' THEN
          operation := CASE WHEN TG_OP = 'INSERT' THEN NEW.operation_id ELSE OLD.operation_id END;
          IF TG_OP = 'INSERT' THEN
            PERFORM pg_advisory_xact_lock_shared(hashtextextended(operation::text, 819));
          ELSE
            PERFORM pg_advisory_xact_lock(hashtextextended(operation::text, 819));
          END IF;
          IF TG_OP = 'DELETE' THEN
            SELECT max(occurred_at) INTO latest FROM ${ns}.audit_event WHERE operation_id = operation;
            IF latest IS NULL OR latest >= statement_timestamp() - interval '2 years' THEN
              RAISE EXCEPTION 'Audit retention is two years after the last operation event' USING ERRCODE = '55000';
            END IF;
          END IF;
        ELSIF TG_OP = 'INSERT' THEN
          SELECT operation_id INTO operation FROM ${ns}.audit_event WHERE id = NEW.event_id;
          IF operation IS NOT NULL THEN
            PERFORM pg_advisory_xact_lock_shared(hashtextextended(operation::text, 819));
          END IF;
        ELSIF TG_OP = 'DELETE' THEN
          SELECT operation_id INTO operation FROM ${ns}.audit_event WHERE id = OLD.event_id;
          IF operation IS NOT NULL THEN
            PERFORM pg_advisory_xact_lock(hashtextextended(operation::text, 819));
            SELECT max(occurred_at) INTO latest FROM ${ns}.audit_event WHERE operation_id = operation;
            IF latest >= statement_timestamp() - interval '2 years' THEN
              RAISE EXCEPTION 'Audit retention is two years after the last operation event' USING ERRCODE = '55000';
            END IF;
          ELSIF pg_trigger_depth() < 2 THEN
            RAISE EXCEPTION 'Audit resources can only expire with their operation' USING ERRCODE = '55000';
          END IF;
        END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END;
      $$;
    `);
    for (const table of ['audit_event', 'audit_resource', 'audit_causality']) {
      await queryRunner.query(`
        DROP TRIGGER IF EXISTS audit_immutable_rows ON ${ns}.${identifier(table)};
        CREATE TRIGGER audit_immutable_rows BEFORE UPDATE OR DELETE ON ${ns}.${identifier(table)}
          FOR EACH ROW EXECUTE FUNCTION ${ns}.guard_user_activity_audit();
        DROP TRIGGER IF EXISTS audit_no_truncate ON ${ns}.${identifier(table)};
        CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON ${ns}.${identifier(table)}
          FOR EACH STATEMENT EXECUTE FUNCTION ${ns}.guard_user_activity_audit();
        DROP TRIGGER IF EXISTS audit_operation_insert_lock ON ${ns}.${identifier(table)};
        CREATE TRIGGER audit_operation_insert_lock BEFORE INSERT ON ${ns}.${identifier(table)}
          FOR EACH ROW EXECUTE FUNCTION ${ns}.guard_user_activity_audit();
      `);
    }
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ${ns}.guard_user_audit_identity()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.audit_id IS DISTINCT FROM OLD.audit_id THEN
          RAISE EXCEPTION 'User audit identity is immutable' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $$;
      DROP TRIGGER IF EXISTS audit_user_identity ON ${ns}."user";
      CREATE TRIGGER audit_user_identity BEFORE UPDATE OF audit_id ON ${ns}."user"
        FOR EACH ROW EXECUTE FUNCTION ${ns}.guard_user_audit_identity();
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ${ns}.capture_user_activity_mutation()
      RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, ${ns} AS $$
      DECLARE
        context jsonb;
        policy jsonb := TG_ARGV[0]::jsonb;
        previous jsonb := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
        following jsonb := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
        row_data jsonb := coalesce(following, previous);
        before_snapshot jsonb := CASE WHEN previous IS NULL THEN NULL ELSE '{}'::jsonb END;
        after_snapshot jsonb := CASE WHEN following IS NULL THEN NULL ELSE '{}'::jsonb END;
        changed text[] := '{}';
        field text;
        event_uuid uuid;
        operation_uuid uuid;
        tx text := txid_current()::text;
        resource_key text;
        scopes text[] := '{}';
        department integer;
        department_code text;
        actor_snapshot jsonb;
        metadata_snapshot jsonb;
        masked boolean;
        fingerprinted boolean;
      BEGIN
        -- Coalescing advances the same pending work to a newer revision. Keep
        -- every initiating event, including when a worker performs the rebase
        -- without HTTP context. A fresh INSERT never inherits a completed queue.
        IF TG_TABLE_NAME = 'current_zone_recompute_request' AND TG_OP = 'UPDATE'
            AND (previous->>'targetPublicRevision') IS DISTINCT FROM (following->>'targetPublicRevision') THEN
          INSERT INTO ${ns}.audit_causality(event_id, kind, reference)
            SELECT event_id, kind, concat(following->>'departementId', ':', following->>'targetPublicRevision')
              FROM ${ns}.audit_causality
              WHERE kind = 'current-zone-revision'
                AND reference = concat(previous->>'departementId', ':', previous->>'targetPublicRevision')
            ON CONFLICT DO NOTHING;
        END IF;
        IF nullif(current_setting('vigieau.audit_context', true), '') IS NULL THEN
          RETURN NULL;
        END IF;
        context := current_setting('vigieau.audit_context', true)::jsonb;
        operation_uuid := (context->>'operationId')::uuid;
        IF operation_uuid IS NULL OR nullif(context->>'action', '') IS NULL
            OR jsonb_typeof(context->'actor') IS DISTINCT FROM 'object' THEN
          RAISE EXCEPTION 'Invalid server audit context' USING ERRCODE = '22023';
        END IF;
        FOR field IN
          SELECT jsonb_array_elements_text(coalesce(policy->'fields', '[]') || coalesce(policy->'masked', '[]') || coalesce(policy->'fingerprints', '[]'))
        LOOP
          masked := coalesce(policy->'masked', '[]') ? field;
          fingerprinted := coalesce(policy->'fingerprints', '[]') ? field;
          IF previous IS NOT NULL AND previous ? field THEN
            before_snapshot := before_snapshot || jsonb_build_object(field,
              CASE WHEN masked THEN to_jsonb('[masqué]'::text)
                   WHEN fingerprinted AND previous->field <> 'null'::jsonb THEN to_jsonb(encode(sha256(convert_to((previous->field)::text, 'UTF8')), 'hex'))
                   ELSE previous->field END);
          END IF;
          IF following IS NOT NULL AND following ? field THEN
            after_snapshot := after_snapshot || jsonb_build_object(field,
              CASE WHEN masked THEN to_jsonb('[masqué]'::text)
                   WHEN fingerprinted AND following->field <> 'null'::jsonb THEN to_jsonb(encode(sha256(convert_to((following->field)::text, 'UTF8')), 'hex'))
                   ELSE following->field END);
          END IF;
          IF (previous->field) IS DISTINCT FROM (following->field) THEN changed := array_append(changed, field); END IF;
        END LOOP;
        IF TG_OP = 'UPDATE' AND cardinality(changed) = 0 THEN
          -- An idempotent enqueue still has a human initiator. Link the accepted
          -- request without inventing a row mutation or an applied event.
          IF TG_TABLE_NAME = 'current_zone_recompute_request' THEN
            SELECT id INTO event_uuid FROM ${ns}.audit_event
              WHERE operation_id = operation_uuid AND phase = 'started'
              ORDER BY occurred_at, id LIMIT 1;
            IF event_uuid IS NOT NULL THEN
              INSERT INTO ${ns}.audit_causality(event_id, kind, reference)
                VALUES(event_uuid, 'current-zone-revision', concat(row_data->>'departementId', ':', row_data->>'targetPublicRevision'))
                ON CONFLICT DO NOTHING;
            END IF;
          END IF;
          RETURN NULL;
        END IF;

        SELECT string_agg(coalesce(row_data->>key, '<null>'), ':' ORDER BY ordinal)
          INTO resource_key FROM jsonb_array_elements_text(policy->'keys') WITH ORDINALITY AS keys(key, ordinal);
        SELECT coalesce(jsonb_object_agg(key, value), '{}') INTO actor_snapshot
          FROM jsonb_each(context->'actor') WHERE key IN ('id','email','firstName','lastName','role','departements','communes');
        SELECT coalesce(jsonb_object_agg(key, value), '{}') INTO metadata_snapshot
          FROM jsonb_each(coalesce(context->'metadata', '{}'))
          WHERE key IN ('resourceType','resourceId','resourceLabel','territories','apply','httpStatus','errorCode','durationMs','resultCount','query','document','workerRunId','parentOperationId');

        INSERT INTO ${ns}.audit_event(operation_id, phase, action, actor, source, request_id, method, route, metadata, db_txid)
          VALUES (operation_uuid, 'applied', context->>'action', actor_snapshot,
            coalesce(context->>'source', 'http'), nullif(context->>'requestId', '')::uuid,
            context->>'method', context->>'route', metadata_snapshot, tx)
          ON CONFLICT (operation_id, db_txid) WHERE db_txid IS NOT NULL DO NOTHING
          RETURNING id INTO event_uuid;
        IF event_uuid IS NULL THEN
          SELECT id INTO STRICT event_uuid FROM ${ns}.audit_event WHERE operation_id = operation_uuid AND db_txid = tx;
        END IF;

        department := coalesce(nullif(row_data->>'departementId', '')::integer, nullif(row_data->>'departementPiloteId', '')::integer);
        IF department IS NULL AND row_data ? 'communeId' AND to_regclass(${literal(schema + '.commune')}) IS NOT NULL THEN
          SELECT "departementId" INTO department FROM ${ns}.commune WHERE id = (row_data->>'communeId')::integer;
        END IF;
        IF department IS NULL AND row_data ? 'arreteRestrictionId' AND to_regclass(${literal(schema + '.arrete_restriction')}) IS NOT NULL THEN
          SELECT "departementId" INTO department FROM ${ns}.arrete_restriction WHERE id = (row_data->>'arreteRestrictionId')::integer;
        END IF;
        IF department IS NULL AND row_data ? 'arreteCadreId' AND to_regclass(${literal(schema + '.arrete_cadre')}) IS NOT NULL THEN
          SELECT "departementPiloteId" INTO department FROM ${ns}.arrete_cadre WHERE id = (row_data->>'arreteCadreId')::integer;
        END IF;
        IF department IS NOT NULL AND to_regclass(${literal(schema + '.departement')}) IS NOT NULL THEN
          SELECT code INTO department_code FROM ${ns}.departement WHERE id = department;
          IF department_code IS NOT NULL THEN scopes := array_append(scopes, department_code); END IF;
        END IF;
        IF row_data->>'departmentCode' IS NOT NULL THEN scopes := array_append(scopes, row_data->>'departmentCode'); END IF;
        IF TG_TABLE_NAME = 'user' THEN
          SELECT coalesce(array_agg(value ORDER BY value), '{}') INTO scopes
            FROM (SELECT DISTINCT jsonb_array_elements_text(coalesce(nullif(row_data->'role_departements', 'null'::jsonb), '[]')) AS value) source;
        END IF;
        INSERT INTO ${ns}.audit_resource(event_id, resource_type, resource_id, operation, "before", "after", changed_fields, territories)
          VALUES (event_uuid, TG_TABLE_NAME, resource_key,
            CASE TG_OP WHEN 'INSERT' THEN 'create' WHEN 'UPDATE' THEN 'update' ELSE 'delete' END,
            before_snapshot, after_snapshot, changed, scopes);

        IF TG_TABLE_NAME = 'current_zone_recompute_request' THEN
          INSERT INTO ${ns}.audit_causality(event_id, kind, reference)
            VALUES(event_uuid, 'current-zone-revision', concat(row_data->>'departementId', ':', row_data->>'targetPublicRevision'))
            ON CONFLICT DO NOTHING;
        ELSIF TG_TABLE_NAME = 'historic_backfill_run' THEN
          INSERT INTO ${ns}.audit_causality(event_id, kind, reference)
            VALUES(event_uuid, 'historic-backfill-run', row_data->>'id') ON CONFLICT DO NOTHING;
        END IF;
        RETURN NULL;
      END;
      $$;
    `);

    for (const source of USER_ACTIVITY_AUDIT_SOURCES) {
      if (await queryRunner.hasTable(`${schema}.${source.table}`)) {
        await queryRunner.query(`
          DROP TRIGGER IF EXISTS audit_business_mutation ON ${ns}.${identifier(source.table)};
          CREATE TRIGGER audit_business_mutation AFTER INSERT OR UPDATE OR DELETE ON ${ns}.${identifier(source.table)}
            FOR EACH ROW EXECUTE FUNCTION ${ns}.capture_user_activity_mutation(${literal(JSON.stringify(source))});
        `);
      }
    }

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ${ns}.purge_user_activity_audit(batch_size integer DEFAULT 5000)
      RETURNS integer LANGUAGE plpgsql SET search_path = pg_catalog, ${ns} AS $$
      DECLARE candidate record; purged integer := 0;
      BEGIN
        IF current_setting('transaction_isolation') <> 'read committed' THEN
          RAISE EXCEPTION 'Audit purge requires READ COMMITTED isolation' USING ERRCODE = '25000';
        END IF;
        IF batch_size < 1 OR batch_size > 5000 OR batch_size IS NULL THEN
          RAISE EXCEPTION 'Audit purge batch must be between 1 and 5000' USING ERRCODE = '22023';
        END IF;
        IF NOT pg_try_advisory_xact_lock(hashtextextended('vigieau:audit-purge:' || ${literal(schema)}, 819)) THEN RETURN 0; END IF;
        FOR candidate IN
          SELECT operation_id FROM ${ns}.audit_event GROUP BY operation_id
          HAVING max(occurred_at) < statement_timestamp() - interval '2 years'
          ORDER BY max(occurred_at), operation_id LIMIT batch_size
        LOOP
          PERFORM pg_advisory_xact_lock(hashtextextended(candidate.operation_id::text, 819));
          IF NOT EXISTS(SELECT 1 FROM ${ns}.audit_event WHERE operation_id = candidate.operation_id
            AND occurred_at >= statement_timestamp() - interval '2 years') THEN
            DELETE FROM ${ns}.audit_event WHERE operation_id = candidate.operation_id;
            IF FOUND THEN purged := purged + 1; END IF;
          END IF;
        END LOOP;
        RETURN purged;
      END;
      $$;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Preserve evidence and stable identities on rollback. Only stop collection.
    const [{ schema }] = await queryRunner.query(
      'SELECT current_schema() AS schema',
    );
    for (const source of USER_ACTIVITY_AUDIT_SOURCES) {
      if (await queryRunner.hasTable(`${schema}.${source.table}`)) {
        await queryRunner.query(
          `DROP TRIGGER IF EXISTS audit_business_mutation ON ${identifier(schema)}.${identifier(source.table)}`,
        );
      }
    }
  }
}
