import { DataSource, QueryRunner } from 'typeorm';
import { SandreZoneSync1785484800000 } from '../migrations/1785484800000-SandreZoneSync';
import { SandreZoneSchemaPrerequisites1786392000000 } from '../migrations/1786392000000-SandreZoneSchemaPrerequisites';
import { SandreZoneDurability1786395600000 } from '../migrations/1786395600000-SandreZoneDurability';
import {
  acquireHistoricalRecomputeLock,
  clearSandreOperationRecomputeDebt,
  earliestOperationRestrictionDate,
  operationBusinessReferencesFingerprint,
  prepareSandreOperationRecomputeDebt,
} from '../scripts/reconcile-sandre-zones';
import { normalizeSandreZoneGeometries } from './sandre-zone-geometry';
import { fingerprint } from './sandre-zone-reconciliation';
import {
  assertSandreApprovedMaterializedTargets,
  auditSandreApprovedSyncGeometry,
  SandreApprovedSyncMapping,
} from './sandre-zone-sync-approvals';
import {
  applySandreApprovedPartitionReferences,
  loadSandreApprovedReferenceEvidence,
  lockSandreApprovedSyncReferences,
  markSandreApprovedHistoricalRecomputeDebt,
} from './sandre-zone-sync-approved-references';
import {
  applySandreReconciliationActions,
  auditSandreReconciliationPlan,
  loadSandreReconciliationState,
  lockSandreReconciliationPlan,
  parseSandreReconciliationPlan,
} from './sandre-zone-reconciliation-actions';

const postgresUrl = process.env.SANDRE_RECONCILIATION_POSTGRES_URL;
const describeWithPostgres = postgresUrl ? describe : describe.skip;

describeWithPostgres('Sandre durable reconciliation on PostgreSQL', () => {
  const schema = `sandre_durability_${process.pid}_${Date.now()}`;
  let dataSource: DataSource;
  let runner: QueryRunner;

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      url: postgresUrl,
      entities: [],
      synchronize: false,
      logging: false,
    }).initialize();
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await runner.query(`CREATE SCHEMA "${schema}"`);
    await runner.query(`SET search_path TO "${schema}", public`);
    await runner.query(`
      CREATE TABLE departement (
        id integer PRIMARY KEY,
        code text NOT NULL UNIQUE
      );
      CREATE TABLE config (
        id integer PRIMARY KEY,
        "computeMapDate" date,
        "computeMapGeneration" bigint NOT NULL DEFAULT 0,
        "computeStatsDate" date,
        "computeStatsGeneration" bigint NOT NULL DEFAULT 0,
        "historicComputeEpoch" bigint NOT NULL DEFAULT 0
      );
      CREATE TABLE sandre_zone_sync_state (
        id serial PRIMARY KEY,
        "departementId" integer NOT NULL UNIQUE REFERENCES departement(id),
        "needsRecompute" boolean NOT NULL DEFAULT false,
        "recomputeRevision" integer NOT NULL DEFAULT 0,
        "updatedAt" timestamp NOT NULL DEFAULT now()
      );
      CREATE TABLE zone_alerte (
        id integer PRIMARY KEY,
        "departementId" integer NOT NULL REFERENCES departement(id),
        type text NOT NULL,
        code text NOT NULL,
        "idSandre" integer,
        "codeSandre" character varying(32),
        "statutSandre" character varying(20),
        "dateMajSandre" date,
        "numeroVersionSandre" integer,
        "codesAlternatifs" jsonb,
        "sandrePayloadHash" character varying(64),
        disabled boolean NOT NULL DEFAULT false,
        geom geometry NOT NULL,
        "updatedAt" timestamp NOT NULL DEFAULT now()
      );
      CREATE TABLE sandre_zone_alias (
        id serial PRIMARY KEY,
        "departementId" integer NOT NULL REFERENCES departement(id),
        "zoneAlerteId" integer NOT NULL REFERENCES zone_alerte(id),
        "zoneType" text NOT NULL,
        "aliasType" text NOT NULL,
        "aliasValue" text NOT NULL,
        source text NOT NULL,
        UNIQUE ("departementId", "zoneType", "aliasType", "aliasValue")
      );
      CREATE TABLE arrete_cadre (
        id integer PRIMARY KEY,
        statut text NOT NULL
      );
      CREATE TABLE arrete_cadre_zone_alerte (
        "arreteCadreId" integer NOT NULL REFERENCES arrete_cadre(id),
        "zoneAlerteId" integer NOT NULL REFERENCES zone_alerte(id),
        PRIMARY KEY ("arreteCadreId", "zoneAlerteId")
      );
      CREATE TABLE arrete_restriction (
        id integer PRIMARY KEY,
        statut text NOT NULL,
        "dateDebut" date
      );
      CREATE TABLE restriction (
        id serial PRIMARY KEY,
        "arreteRestrictionId" integer NOT NULL
          REFERENCES arrete_restriction(id),
        "zoneAlerteId" integer NOT NULL REFERENCES zone_alerte(id),
        "arreteCadreId" integer REFERENCES arrete_cadre(id),
        "nomGroupementAep" text,
        "niveauGravite" text,
        UNIQUE ("arreteRestrictionId", "zoneAlerteId")
      );
      CREATE TABLE usage (
        id serial PRIMARY KEY,
        nom text NOT NULL,
        "thematiqueId" integer NOT NULL,
        "restrictionId" integer REFERENCES restriction(id) ON DELETE CASCADE,
        "arreteCadreId" integer,
        "isTemplate" boolean NOT NULL DEFAULT false,
        "concerneParticulier" boolean,
        "concerneEntreprise" boolean,
        "concerneCollectivite" boolean,
        "concerneExploitation" boolean,
        "concerneEso" boolean NOT NULL DEFAULT true,
        "concerneEsu" boolean NOT NULL DEFAULT true,
        "concerneAep" boolean NOT NULL DEFAULT true,
        "descriptionVigilance" text,
        "descriptionAlerte" text,
        "descriptionAlerteRenforcee" text,
        "descriptionCrise" text,
        UNIQUE (nom, "thematiqueId", "restrictionId")
      );
      CREATE TABLE restriction_commune (
        "restrictionId" integer NOT NULL REFERENCES restriction(id)
          ON DELETE CASCADE,
        "communeId" integer NOT NULL,
        PRIMARY KEY ("restrictionId", "communeId")
      );
      CREATE TABLE zone_alerte_computed (
        id integer PRIMARY KEY,
        "restrictionId" integer REFERENCES restriction(id) ON DELETE CASCADE
      );
      CREATE TABLE zone_alerte_computed_historic (
        id integer PRIMARY KEY,
        "restrictionId" integer REFERENCES restriction(id) ON DELETE CASCADE
      );
      CREATE TABLE arrete_cadre_zone_alerte_communes (
        id integer PRIMARY KEY,
        "arreteCadreId" integer NOT NULL REFERENCES arrete_cadre(id),
        "zoneAlerteId" integer NOT NULL REFERENCES zone_alerte(id),
        UNIQUE ("arreteCadreId", "zoneAlerteId")
      );
      CREATE TABLE ac_za_communes (
        "arreteCadreZoneAlerteCommunesId" integer NOT NULL
          REFERENCES arrete_cadre_zone_alerte_communes(id) ON DELETE CASCADE,
        "communeId" integer NOT NULL,
        PRIMARY KEY ("arreteCadreZoneAlerteCommunesId", "communeId")
      )
    `);
    await new SandreZoneDurability1786395600000().up(runner);
  }, 30_000);

  afterAll(async () => {
    if (runner) {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction();
      }
      await runner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await runner.release();
    }
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('installs fail-closed provenance and the audited basin mapping', async () => {
    const [mapping] = await runner.query(`
      SELECT
        "officialBasinCode",
        "officialName",
        "localBasinCode",
        source
      FROM sandre_basin_mapping
      WHERE "officialBasinCode" = 12
    `);
    expect(mapping).toEqual({
      officialBasinCode: 12,
      officialName: 'CORSE',
      localBasinCode: 6,
      source: 'audited_official_to_local',
    });

    await runner.query(
      `
        INSERT INTO departement (id, code) VALUES (999, 'XX');
        INSERT INTO zone_alerte (
          id, "departementId", type, code, disabled, geom,
          "sandreProvenance"
        ) VALUES (
          999, 999, 'SOU', 'LOCAL', false,
          ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 0))', 4326),
          'local_preserved'
        )
      `,
    );
    await expect(
      runner.query(
        `UPDATE zone_alerte SET "numeroVersionSandre" = 1 WHERE id = 999`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await runner.query(`DELETE FROM zone_alerte WHERE id = 999`);
    await runner.query(`DELETE FROM departement WHERE id = 999`);
  });

  it('repairs all five audited invalid geometries with unchanged bboxes', async () => {
    const fixtures = [
      ['19', '3917'],
      ['69', '1827'],
      ['72', '2129'],
      ['81', '3090'],
      ['87', '1424'],
    ];
    const features = fixtures.map(([, code], index) => ({
      codeSandre: code,
      geometry: invalidTouchingHole(index * 10),
    })) as any[];

    const result = await normalizeSandreZoneGeometries(runner, features);

    expect(result.features).toHaveLength(5);
    for (const [departmentCode, code] of fixtures) {
      expect(departmentCode).toMatch(/^\d{2}$/);
      expect(result.audits.get(code)).toEqual(
        expect.objectContaining({
          normalized: true,
          normalizedGeometryType: 'MULTIPOLYGON',
        }),
      );
      expect(result.audits.get(code)!.relativeAreaDelta).toBeLessThanOrEqual(
        1e-9,
      );
      expect(
        result.audits.get(code)!.absoluteGeodesicAreaDeltaSquareMeters,
      ).toBeGreaterThanOrEqual(0);
      expect(
        Number.isFinite(result.audits.get(code)!.rawGeodesicAreaSquareMeters),
      ).toBe(true);
      expect(result.audits.get(code)!.normalizationApprovalId).toBeNull();
    }
  });

  it('applies and replays every reconciliation strategy without losing history', async () => {
    await seedReconciliationFixture(runner);
    const canonicalRestrictionConflicts = [
      {
        arreteRestrictionId: 10,
        parentStatus: 'abroge',
        sourceRestrictionId: 101,
        targetRestrictionId: 100,
        sourceArreteCadreId: 3,
        targetArreteCadreId: 3,
        sourceNomGroupementAep: null,
        targetNomGroupementAep: null,
        sourceNiveauGravite: 'crise',
        targetNiveauGravite: 'alerte',
      },
    ];
    const plan = parseSandreReconciliationPlan({
      schemaVersion: 1,
      operationId: 'postgres-all-strategies',
      description: 'PostgreSQL integration fixture',
      actions: [
        {
          strategy: 'preserve_local',
          departmentCode: '2B',
          zoneType: 'SOU',
          sourceZoneId: 4605,
          expectedSourceCode: '94_2B_01',
        },
        {
          strategy: 'replace_1to1',
          departmentCode: '2A',
          zoneType: 'SOU',
          sourceZoneId: 100,
          targetZoneId: 101,
        },
        {
          strategy: 'replace_partition_1ton',
          departmentCode: '2A',
          zoneType: 'SUP',
          sourceZoneId: 300,
          targetZoneIds: [301, 302],
        },
        {
          strategy: 'canonicalize_duplicate',
          departmentCode: '49',
          zoneType: 'SOU',
          sourceZoneId: 9707,
          targetZoneId: 9704,
          expectedSourceCode: '52_49_14',
          expectedSandreGid: 408,
          officialCode: '300',
          restrictionConflictPolicy: {
            mode: 'prefer_source',
            expectedCount: canonicalRestrictionConflicts.length,
            expectedFingerprint: fingerprint(canonicalRestrictionConflicts),
            allowedDifferingFields: ['niveauGravite'],
            requiredParentStatus: 'abroge',
            requireSourceSeverityStrictlyHigher: true,
          },
        },
      ],
    });
    const official = [officialErdreFeature()];
    const [sourceOnlyBefore] = await runner.query(`
      SELECT count(*)::integer AS count
      FROM restriction source
      WHERE source."zoneAlerteId" = 9707
        AND NOT EXISTS (
          SELECT 1
          FROM restriction target
          WHERE target."arreteRestrictionId" = source."arreteRestrictionId"
            AND target."zoneAlerteId" = 9704
        )
    `);
    expect(sourceOnlyBefore.count).toBe(1);

    await runner.query(
      `UPDATE restriction SET "nomGroupementAep" = 'drift' WHERE id = 101`,
    );
    await expect(
      auditSandreReconciliationPlan(runner, plan, official),
    ).rejects.toThrow('restriction fields differ');
    await runner.query(
      `UPDATE restriction SET "nomGroupementAep" = NULL WHERE id = 101`,
    );

    await runner.query(
      `UPDATE arrete_restriction SET statut = 'publie' WHERE id = 10`,
    );
    await expect(
      auditSandreReconciliationPlan(runner, plan, official),
    ).rejects.toThrow('restriction parent status changed');
    await runner.query(
      `UPDATE arrete_restriction SET statut = 'abroge' WHERE id = 10`,
    );

    await runner.query(
      `DELETE FROM restriction_commune WHERE "restrictionId" = 100 AND "communeId" = 2`,
    );
    await expect(
      auditSandreReconciliationPlan(runner, plan, official),
    ).rejects.toThrow('restriction communes differ');
    await runner.query(
      `INSERT INTO restriction_commune ("restrictionId", "communeId") VALUES (100, 2)`,
    );

    await runner.query(
      `UPDATE restriction SET "niveauGravite" = 'vigilance' WHERE id = 100`,
    );
    await expect(
      auditSandreReconciliationPlan(runner, plan, official),
    ).rejects.toThrow('restriction conflicts changed');
    await runner.query(
      `UPDATE restriction SET "niveauGravite" = 'alerte' WHERE id = 100`,
    );

    await runner.query(
      `UPDATE usage SET "descriptionCrise" = 'different' WHERE id = 2`,
    );
    await expect(
      auditSandreReconciliationPlan(runner, plan, official),
    ).rejects.toThrow('Canonical duplicate usages differ');
    await runner.query(
      `UPDATE usage SET "descriptionCrise" = 'same' WHERE id = 2`,
    );

    const beforeState = await loadSandreReconciliationState(runner, plan);
    const beforeFingerprint = fingerprint(beforeState);
    expect(beforeState.restrictions).toHaveLength(3);
    expect(
      beforeState.restrictions.map(
        (restriction) => restriction.arreteRestrictionDateDebut,
      ),
    ).toEqual(['2016-07-18', '2016-07-18', '2021-01-01']);
    expect(earliestOperationRestrictionDate(beforeState)).toBe('2016-07-18');
    const audits = await auditSandreReconciliationPlan(runner, plan, official);
    expect(audits.every((audit) => audit.status === 'ready')).toBe(true);
    expect(audits[3].restrictionConflicts).toEqual({
      policy: 'prefer_source',
      count: 1,
      fingerprint: fingerprint(canonicalRestrictionConflicts),
    });
    expect(audits[3].geometry).toEqual(
      expect.objectContaining({
        officialCode: '300',
        officialGid: 408,
        officialPayloadHash: 'official-300-hash',
        targetEqualsOfficial: true,
      }),
    );

    let simulatedAfterFingerprint = '';
    let approvedBusinessReferencesFingerprint = '';
    await runner.startTransaction('SERIALIZABLE');
    try {
      await lockSandreReconciliationPlan(runner, plan);
      await applySandreReconciliationActions(runner, audits);
      const finalAudits = await auditSandreReconciliationPlan(
        runner,
        plan,
        official,
      );
      expect(
        finalAudits.every((audit) => audit.status === 'already_applied'),
      ).toBe(true);
      simulatedAfterFingerprint = fingerprint(
        await loadSandreReconciliationState(runner, plan),
      );
      await runner.rollbackTransaction();
    } catch (error) {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction();
      }
      throw error;
    }
    expect(fingerprint(await loadSandreReconciliationState(runner, plan))).toBe(
      beforeFingerprint,
    );

    await runner.startTransaction('SERIALIZABLE');
    try {
      await lockSandreReconciliationPlan(runner, plan);
      const applyAudits = await auditSandreReconciliationPlan(
        runner,
        plan,
        official,
      );
      await applySandreReconciliationActions(runner, applyAudits);
      const finalAudits = await auditSandreReconciliationPlan(
        runner,
        plan,
        official,
      );
      expect(
        finalAudits.every((audit) => audit.status === 'already_applied'),
      ).toBe(true);
      expect(
        fingerprint(await loadSandreReconciliationState(runner, plan)),
      ).toBe(simulatedAfterFingerprint);
      approvedBusinessReferencesFingerprint =
        operationBusinessReferencesFingerprint(
          await loadSandreReconciliationState(runner, plan),
        );
      await applySandreReconciliationActions(runner, finalAudits);
      expect(
        fingerprint(await loadSandreReconciliationState(runner, plan)),
      ).toBe(simulatedAfterFingerprint);
      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    }

    const replayAudits = await auditSandreReconciliationPlan(
      runner,
      plan,
      official,
    );
    expect(
      replayAudits.every((audit) => audit.status === 'already_applied'),
    ).toBe(true);
    expect(fingerprint(await loadSandreReconciliationState(runner, plan))).toBe(
      simulatedAfterFingerprint,
    );

    const [preserved] = await runner.query(`
      SELECT
        disabled,
        "sandreProvenance",
        "idSandre",
        "codeSandre",
        "statutSandre",
        "dateMajSandre",
        "numeroVersionSandre",
        "codesAlternatifs",
        "sandrePayloadHash"
      FROM zone_alerte
      WHERE id = 4605
    `);
    expect(preserved).toEqual({
      disabled: false,
      sandreProvenance: 'local_preserved',
      idSandre: null,
      codeSandre: null,
      statutSandre: null,
      dateMajSandre: null,
      numeroVersionSandre: null,
      codesAlternatifs: null,
      sandrePayloadHash: null,
    });
    const [canonicalCounts] = await runner.query(`
      SELECT
        (SELECT count(*)::integer FROM arrete_cadre_zone_alerte
          WHERE "zoneAlerteId" = 9704) AS ac,
        (SELECT count(*)::integer FROM restriction
          WHERE "zoneAlerteId" = 9704) AS restrictions,
        (SELECT count(*)::integer FROM arrete_cadre_zone_alerte_communes
          WHERE "zoneAlerteId" = 9704) AS customizations,
        (SELECT count(*)::integer FROM usage) AS usages,
        (SELECT count(*)::integer FROM restriction_commune) AS communes,
        (SELECT count(*)::integer FROM arrete_cadre_zone_alerte
          WHERE "zoneAlerteId" = 9707) +
        (SELECT count(*)::integer FROM restriction
          WHERE "zoneAlerteId" = 9707) +
        (SELECT count(*)::integer FROM arrete_cadre_zone_alerte_communes
          WHERE "zoneAlerteId" = 9707) AS source_refs
    `);
    expect(canonicalCounts).toEqual({
      ac: 2,
      restrictions: 2,
      customizations: 2,
      usages: 2,
      communes: 3,
      source_refs: 0,
    });
    const canonicalRestrictions = await runner.query(`
      SELECT id, "zoneAlerteId", "niveauGravite"
      FROM restriction
      WHERE id IN (100, 101, 102)
      ORDER BY id
    `);
    expect(canonicalRestrictions).toEqual([
      { id: 100, zoneAlerteId: 9704, niveauGravite: 'crise' },
      { id: 102, zoneAlerteId: 9704, niveauGravite: 'crise' },
    ]);

    await runner.startTransaction('SERIALIZABLE');
    try {
      await runner.query(`
        DELETE FROM arrete_cadre_zone_alerte
        WHERE "arreteCadreId" = 4 AND "zoneAlerteId" = 9704
      `);
      const driftedAudits = await auditSandreReconciliationPlan(
        runner,
        plan,
        official,
      );
      expect(
        driftedAudits.every((audit) => audit.status === 'already_applied'),
      ).toBe(true);
      expect(
        fingerprint(await loadSandreReconciliationState(runner, plan)),
      ).not.toBe(simulatedAfterFingerprint);
      expect(
        operationBusinessReferencesFingerprint(
          await loadSandreReconciliationState(runner, plan),
        ),
      ).not.toBe(approvedBusinessReferencesFingerprint);
      await runner.query(
        `UPDATE zone_alerte SET disabled = true WHERE id = 9704`,
      );
      await expect(
        auditSandreReconciliationPlan(runner, plan, official),
      ).rejects.toThrow('Duplicate canonicalization identity mismatch');
    } finally {
      await runner.rollbackTransaction();
    }
  }, 30_000);

  it('canonicalizes an exact duplicate with a zero-conflict policy', async () => {
    await runner.query(`
      INSERT INTO zone_alerte (
        id, "departementId", type, code, "idSandre", disabled, geom,
        "sandreProvenance"
      ) VALUES
        (9708, 49, 'SOU', '52_49_15', 409, false,
          ST_GeomFromText('POLYGON((4 0,6 0,6 2,4 2,4 0))', 4326),
          'legacy_unverified'),
        (16677, 49, 'SOU', '52_49_15', 409, false,
          ST_GeomFromText('POLYGON((4 0,6 0,6 2,4 2,4 0))', 4326),
          'legacy_unverified');
      INSERT INTO arrete_cadre (id, statut) VALUES (20, 'publie');
      INSERT INTO arrete_cadre_zone_alerte (
        "arreteCadreId", "zoneAlerteId"
      ) VALUES (20, 9708);
      INSERT INTO arrete_restriction (id, statut, "dateDebut")
      VALUES (20, 'a_valider', DATE '2026-06-22');
      INSERT INTO restriction (
        id, "arreteRestrictionId", "zoneAlerteId", "arreteCadreId",
        "niveauGravite"
      ) VALUES (200, 20, 9708, 20, 'alerte');
    `);
    const plan = parseSandreReconciliationPlan({
      schemaVersion: 1,
      operationId: 'postgres-zero-conflict-duplicate',
      description: 'PostgreSQL zero-conflict duplicate fixture',
      actions: [
        {
          strategy: 'canonicalize_duplicate',
          departmentCode: '49',
          zoneType: 'SOU',
          sourceZoneId: 16677,
          targetZoneId: 9708,
          expectedSourceCode: '52_49_15',
          expectedSandreGid: 409,
          officialCode: '301',
          restrictionConflictPolicy: {
            mode: 'prefer_source',
            expectedCount: 0,
            expectedFingerprint: fingerprint([]),
            allowedDifferingFields: ['niveauGravite'],
            requiredParentStatus: 'abroge',
            requireSourceSeverityStrictlyHigher: true,
          },
        },
      ],
    });
    const official = [officialAubanceFeature()];

    const audits = await auditSandreReconciliationPlan(runner, plan, official);
    expect(audits).toEqual([
      expect.objectContaining({
        status: 'ready',
        restrictionConflicts: {
          policy: 'prefer_source',
          count: 0,
          fingerprint: fingerprint([]),
        },
        geometry: expect.objectContaining({
          officialCode: '301',
          officialGid: 409,
          targetEqualsOfficial: true,
          sourceCoverage: 1,
          targetCoverage: 1,
          iou: 1,
        }),
      }),
    ]);

    await runner.startTransaction('SERIALIZABLE');
    try {
      await lockSandreReconciliationPlan(runner, plan);
      await applySandreReconciliationActions(runner, audits);
      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    }

    const [state] = await runner.query(`
      SELECT
        source.disabled AS "sourceDisabled",
        source."idSandre" AS "sourceGid",
        source."sandreProvenance" AS "sourceProvenance",
        (SELECT count(*)::integer FROM arrete_cadre_zone_alerte
          WHERE "zoneAlerteId" = 16677) AS "sourceFrameworks",
        (SELECT count(*)::integer FROM restriction
          WHERE "zoneAlerteId" = 16677) AS "sourceRestrictions",
        (SELECT count(*)::integer FROM arrete_cadre_zone_alerte
          WHERE "zoneAlerteId" = 9708) AS "targetFrameworks",
        (SELECT count(*)::integer FROM restriction
          WHERE "zoneAlerteId" = 9708) AS "targetRestrictions"
      FROM zone_alerte source
      WHERE source.id = 16677
    `);
    expect(state).toEqual({
      sourceDisabled: true,
      sourceGid: null,
      sourceProvenance: 'legacy_unverified',
      sourceFrameworks: 0,
      sourceRestrictions: 0,
      targetFrameworks: 1,
      targetRestrictions: 1,
    });
    await expect(
      auditSandreReconciliationPlan(runner, plan, official),
    ).resolves.toEqual([
      expect.objectContaining({ status: 'already_applied' }),
    ]);
  }, 30_000);

  it('preserves restriction history while applying and replaying an approved sync split', async () => {
    await runner.query(`
      INSERT INTO departement (id, code) VALUES (86, '86');
      INSERT INTO config (
        id, "computeMapDate", "computeMapGeneration", "computeStatsDate",
        "computeStatsGeneration", "historicComputeEpoch"
      ) VALUES (1, DATE '2026-08-15', 7, DATE '2026-08-15', 8, 9)
      ON CONFLICT (id) DO UPDATE SET
        "computeMapDate" = EXCLUDED."computeMapDate",
        "computeMapGeneration" = EXCLUDED."computeMapGeneration",
        "computeStatsDate" = EXCLUDED."computeStatsDate",
        "computeStatsGeneration" = EXCLUDED."computeStatsGeneration",
        "historicComputeEpoch" = EXCLUDED."historicComputeEpoch";
      INSERT INTO zone_alerte (
        id, "departementId", type, code, "idSandre", "codeSandre",
        disabled, geom, "sandreProvenance"
      ) VALUES
        (20582, 86, 'SUP', 'SOURCE', 464, '355', true,
          ST_GeomFromText('POLYGON((0 8,2 8,2 10,0 10,0 8))', 4326),
          'official'),
        (20583, 86, 'SUP', 'TARGET-A', 3947, '3947', false,
          ST_GeomFromText('POLYGON((0 8,1 8,1 10,0 10,0 8))', 4326),
          'official'),
        (20584, 86, 'SUP', 'TARGET-B', 3946, '3948', false,
          ST_GeomFromText('POLYGON((1 8,2 8,2 10,1 10,1 8))', 4326),
          'official');
      INSERT INTO arrete_cadre (id, statut) VALUES
        (130, 'publie'),
        (131, 'abroge');
      INSERT INTO arrete_cadre_zone_alerte (
        "arreteCadreId", "zoneAlerteId"
      ) VALUES (130, 20582), (131, 20582);
      INSERT INTO arrete_restriction (id, statut, "dateDebut") VALUES
        (130, 'publie', DATE '2026-05-01'),
        (131, 'a_venir', DATE '2026-07-01'),
        (132, 'abroge', DATE '2025-01-01');
      INSERT INTO restriction (
        id, "arreteRestrictionId", "zoneAlerteId", "arreteCadreId",
        "nomGroupementAep", "niveauGravite"
      ) VALUES
        (1300, 130, 20582, 130, NULL, 'alerte_renforcee'),
        (1301, 131, 20582, 130, 'GROUPEMENT', 'crise'),
        (1302, 132, 20582, 131, NULL, 'alerte');
      INSERT INTO usage (
        id, nom, "thematiqueId", "restrictionId", "arreteCadreId",
        "isTemplate", "concerneParticulier", "concerneEntreprise",
        "concerneCollectivite", "concerneExploitation", "concerneEso",
        "concerneEsu", "concerneAep", "descriptionAlerte",
        "descriptionCrise"
      ) VALUES
        (1300, 'Usage split A', 1, 1300, NULL, false, true, false, false,
          false, true, true, false, 'Alerte A', 'Crise A'),
        (1301, 'Usage split B', 2, 1301, NULL, false, false, true, true,
          false, false, true, true, 'Alerte B', 'Crise B'),
        (1302, 'Usage historique', 3, 1302, NULL, false, false, false,
          false, false, true, true, true, 'Historique', 'Historique');
      INSERT INTO restriction_commune ("restrictionId", "communeId") VALUES
        (1300, 86001), (1300, 86002), (1301, 86003), (1302, 86004);
      INSERT INTO zone_alerte_computed (id, "restrictionId") VALUES
        (1300, 1300), (1301, 1301);
      INSERT INTO zone_alerte_computed_historic (id, "restrictionId") VALUES
        (2300, 1300), (2301, 1301), (2302, 1302);
      SELECT setval(
        pg_get_serial_sequence('restriction', 'id'),
        (SELECT max(id) FROM restriction)
      );
      SELECT setval(
        pg_get_serial_sequence('usage', 'id'),
        (SELECT max(id) FROM usage)
      );
    `);
    const expected = await loadSandreApprovedReferenceEvidence(
      runner,
      20582,
      [20583, 20584],
    );
    expect(
      expected.restrictions.map((restriction) => restriction.restrictionId),
    ).toEqual([1300, 1301]);

    await runner.query(
      `UPDATE restriction SET "niveauGravite" = 'crise' WHERE id = 1300`,
    );
    await expect(
      applySandreApprovedPartitionReferences(
        runner,
        expected,
        [
          { codeSandre: '3947', zoneAlerteId: 20583 },
          { codeSandre: '3948', zoneAlerteId: 20584 },
        ],
        '2026-06-30',
      ),
    ).rejects.toThrow('partition references changed');
    await runner.query(
      `UPDATE restriction SET "niveauGravite" = 'alerte_renforcee' WHERE id = 1300`,
    );

    await runner.startTransaction('SERIALIZABLE');
    try {
      await lockSandreApprovedSyncReferences(runner, [20582], [20583, 20584]);
      await expect(
        applySandreApprovedPartitionReferences(
          runner,
          expected,
          [
            { codeSandre: '3948', zoneAlerteId: 20584 },
            { codeSandre: '3947', zoneAlerteId: 20583 },
          ],
          '2026-06-30',
        ),
      ).resolves.toEqual({ applied: true });
      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    }

    const restrictions = await runner.query(`
      SELECT id, "zoneAlerteId", "arreteRestrictionId"
      FROM restriction
      WHERE "arreteRestrictionId" IN (130, 131, 132)
      ORDER BY "arreteRestrictionId", "zoneAlerteId"
    `);
    expect(restrictions).toEqual([
      { id: 1300, zoneAlerteId: 20583, arreteRestrictionId: 130 },
      {
        id: expect.any(Number),
        zoneAlerteId: 20584,
        arreteRestrictionId: 130,
      },
      { id: 1301, zoneAlerteId: 20583, arreteRestrictionId: 131 },
      {
        id: expect.any(Number),
        zoneAlerteId: 20584,
        arreteRestrictionId: 131,
      },
      { id: 1302, zoneAlerteId: 20582, arreteRestrictionId: 132 },
    ]);
    const computed = await runner.query(`
      SELECT 'current' AS kind, id, "restrictionId"
      FROM zone_alerte_computed
      UNION ALL
      SELECT 'historic' AS kind, id, "restrictionId"
      FROM zone_alerte_computed_historic
      ORDER BY kind, id
    `);
    expect(computed).toEqual(
      expect.arrayContaining([
        { kind: 'current', id: 1300, restrictionId: 1300 },
        { kind: 'current', id: 1301, restrictionId: 1301 },
        { kind: 'historic', id: 2300, restrictionId: 1300 },
        { kind: 'historic', id: 2301, restrictionId: 1301 },
        { kind: 'historic', id: 2302, restrictionId: 1302 },
      ]),
    );
    const cloneRestrictionIds = restrictions
      .filter((row) => row.zoneAlerteId === 20584)
      .map((row) => Number(row.id));
    expect(cloneRestrictionIds).toHaveLength(2);
    expect(
      computed.filter((row) => cloneRestrictionIds.includes(row.restrictionId)),
    ).toEqual([]);
    await runner.query(
      `
        INSERT INTO zone_alerte_computed (id, "restrictionId") VALUES
          (91300, $1), (91301, $2)
      `,
      cloneRestrictionIds,
    );
    await runner.query(
      `
        INSERT INTO zone_alerte_computed_historic (id, "restrictionId") VALUES
          (92300, $1), (92301, $2)
      `,
      cloneRestrictionIds,
    );
    const initialLineage = await loadSandreApprovedReferenceEvidence(
      runner,
      20582,
      [20583, 20584],
      expected,
    );
    expect(initialLineage.lifecycle).toBe('post_apply');
    const [cursor] = await runner.query(`
      SELECT
        "computeMapDate"::text AS "computeMapDate",
        "computeMapGeneration"::integer AS "computeMapGeneration",
        "computeStatsDate"::text AS "computeStatsDate",
        "computeStatsGeneration"::integer AS "computeStatsGeneration",
        "historicComputeEpoch"::integer AS "historicComputeEpoch"
      FROM config WHERE id = 1
    `);
    expect(cursor).toEqual({
      computeMapDate: '2026-06-30',
      computeMapGeneration: 8,
      computeStatsDate: '2026-06-30',
      computeStatsGeneration: 9,
      historicComputeEpoch: 10,
    });

    await runner.startTransaction('SERIALIZABLE');
    try {
      await lockSandreApprovedSyncReferences(runner, [20582], [20583, 20584]);
      await expect(
        applySandreApprovedPartitionReferences(
          runner,
          expected,
          [
            { codeSandre: '3947', zoneAlerteId: 20583 },
            { codeSandre: '3948', zoneAlerteId: 20584 },
          ],
          '2026-06-30',
        ),
      ).resolves.toEqual({ applied: false });
      await markSandreApprovedHistoricalRecomputeDebt(runner, '2026-08-01');
      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    }
    const [replayedCursor] = await runner.query(`
      SELECT
        "computeMapGeneration"::integer AS map,
        "computeStatsGeneration"::integer AS stats,
        "historicComputeEpoch"::integer AS epoch
      FROM config WHERE id = 1
    `);
    expect(replayedCursor).toEqual({ map: 8, stats: 9, epoch: 10 });

    await runner.query(`
      INSERT INTO arrete_cadre (id, statut) VALUES (86130, 'publie');
      INSERT INTO arrete_cadre_zone_alerte (
        "arreteCadreId", "zoneAlerteId"
      ) VALUES (86130, 20584);
      INSERT INTO arrete_restriction (id, statut, "dateDebut")
      VALUES (86130, 'publie', DATE '2026-08-10');
    `);
    const [futureRestriction] = await runner.query(`
      INSERT INTO restriction (
        "arreteRestrictionId", "zoneAlerteId", "arreteCadreId",
        "nomGroupementAep", "niveauGravite"
      ) VALUES (86130, 20584, 86130, NULL, 'alerte')
      RETURNING id
    `);
    const auditedFutureState = await loadSandreApprovedReferenceEvidence(
      runner,
      20582,
      [20583, 20584],
      initialLineage,
    );
    expect(auditedFutureState.lifecycle).toBe('post_apply');
    expect(auditedFutureState.fingerprint).not.toBe(initialLineage.fingerprint);
    await expect(
      applySandreApprovedPartitionReferences(
        runner,
        auditedFutureState,
        [
          { codeSandre: '3947', zoneAlerteId: 20583 },
          { codeSandre: '3948', zoneAlerteId: 20584 },
        ],
        '2026-06-30',
      ),
    ).resolves.toEqual({ applied: false });

    await runner.query(
      `UPDATE restriction SET "niveauGravite" = 'crise' WHERE id = $1`,
      [futureRestriction.id],
    );
    await expect(
      applySandreApprovedPartitionReferences(
        runner,
        auditedFutureState,
        [
          { codeSandre: '3947', zoneAlerteId: 20583 },
          { codeSandre: '3948', zoneAlerteId: 20584 },
        ],
        '2026-06-30',
      ),
    ).rejects.toThrow('post-apply state changed');
    await runner.query(
      `UPDATE restriction SET "niveauGravite" = 'alerte' WHERE id = $1`,
      [futureRestriction.id],
    );

    await runner.query(
      `UPDATE restriction SET "niveauGravite" = 'crise' WHERE id = $1`,
      [cloneRestrictionIds[0]],
    );
    const evolvedLineage = await loadSandreApprovedReferenceEvidence(
      runner,
      20582,
      [20583, 20584],
      initialLineage,
    );
    expect(evolvedLineage).toEqual(
      expect.objectContaining({ lifecycle: 'post_apply' }),
    );
    expect(evolvedLineage.fingerprint).not.toBe(initialLineage.fingerprint);
    await runner.query(
      `UPDATE restriction SET "niveauGravite" = 'alerte_renforcee' WHERE id = $1`,
      [cloneRestrictionIds[0]],
    );

    await runner.startTransaction('SERIALIZABLE');
    try {
      await runner.query(`DELETE FROM restriction WHERE id = $1`, [
        cloneRestrictionIds[0],
      ]);
      await runner.query(`
        INSERT INTO restriction (
          "arreteRestrictionId", "zoneAlerteId", "arreteCadreId",
          "nomGroupementAep", "niveauGravite"
        ) VALUES (130, 20584, 130, NULL, 'alerte_renforcee')
      `);
      await expect(
        loadSandreApprovedReferenceEvidence(
          runner,
          20582,
          [20583, 20584],
          initialLineage,
        ),
      ).rejects.toThrow('restriction lineage is incomplete');
    } finally {
      await runner.rollbackTransaction();
    }

    await runner.query(`
      UPDATE arrete_cadre SET statut = 'abroge' WHERE id = 130;
      UPDATE arrete_restriction SET statut = 'abroge' WHERE id = 130;
    `);
    await expect(
      loadSandreApprovedReferenceEvidence(
        runner,
        20582,
        [20583, 20584],
        initialLineage,
      ),
    ).resolves.toEqual(expect.objectContaining({ lifecycle: 'post_apply' }));

    await runner.query(`
      INSERT INTO arrete_cadre_zone_alerte_communes (
        id, "arreteCadreId", "zoneAlerteId"
      ) VALUES (86130, 86130, 20582)
    `);
    await expect(
      loadSandreApprovedReferenceEvidence(
        runner,
        20582,
        [20583, 20584],
        initialLineage,
      ),
    ).rejects.toThrow('source regained operational references');
    await runner.query(
      `DELETE FROM arrete_cadre_zone_alerte_communes WHERE id = 86130`,
    );
  }, 30_000);

  it('pins approved split geometry and its materialized target rows', async () => {
    await runner.query(
      `UPDATE zone_alerte SET geom = ST_Multi(geom) WHERE id IN (20583, 20584)`,
    );
    const targetFeatures = [
      {
        codeSandre: '3947',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 8],
              [1, 8],
              [1, 10],
              [0, 10],
              [0, 8],
            ],
          ],
        },
      },
      {
        codeSandre: '3948',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [1, 8],
              [2, 8],
              [2, 10],
              [1, 10],
              [1, 8],
            ],
          ],
        },
      },
    ] as any[];
    const mapping: SandreApprovedSyncMapping = {
      sourceCode: '355',
      sourceZoneId: 20582,
      targetCodes: ['3947', '3948'],
      requireTopologicalEquality: false,
      effectiveDate: '2026-06-30',
      expectedGeometry: null,
      minimumGeometry: {
        sourceCoverage: 0.9999,
        targetCoverage: 0.9999,
        iou: 0.9999,
      },
    };
    const observed = await auditSandreApprovedSyncGeometry(
      runner,
      mapping,
      targetFeatures,
    );
    expect(observed).toEqual(
      expect.objectContaining({
        sourceCoverage: 1,
        targetCoverage: 1,
        iou: 1,
        pairwiseOverlapRatio: 0,
        topologicallyEqual: true,
      }),
    );
    const pinned: SandreApprovedSyncMapping = {
      ...mapping,
      expectedGeometry: {
        sourceGeometryHash: observed.sourceGeometryHash,
        targetGeometryHashes: observed.targetGeometryHashes,
        unionGeometryHash: observed.unionGeometryHash,
        sourceCoverage: observed.sourceCoverage,
        targetCoverage: observed.targetCoverage,
        iou: observed.iou,
      },
    };
    await expect(
      auditSandreApprovedSyncGeometry(runner, pinned, targetFeatures),
    ).resolves.toEqual(observed);
    await expect(
      assertSandreApprovedMaterializedTargets(runner, 86, [
        { feature: targetFeatures[0], zoneAlerteId: 20583 },
        { feature: targetFeatures[1], zoneAlerteId: 20584 },
      ]),
    ).resolves.toBeUndefined();

    const [stored] = await runner.query(`
      SELECT
        ST_AsEWKB(source.geom) AS source,
        ST_AsEWKB(target.geom) AS target
      FROM zone_alerte source
      CROSS JOIN zone_alerte target
      WHERE source.id = 20582 AND target.id = 20583
    `);
    await runner.query(
      `UPDATE zone_alerte SET geom = ST_Translate(geom, 0.000001, 0) WHERE id = 20582`,
    );
    await expect(
      auditSandreApprovedSyncGeometry(runner, pinned, targetFeatures),
    ).rejects.toThrow('Approved Sandre geometry changed');
    await runner.query(
      `UPDATE zone_alerte SET geom = ST_GeomFromEWKB($1) WHERE id = 20582`,
      [stored.source],
    );

    await runner.query(
      `UPDATE zone_alerte SET geom = ST_Translate(geom, 0.000001, 0) WHERE id = 20583`,
    );
    await expect(
      assertSandreApprovedMaterializedTargets(runner, 86, [
        { feature: targetFeatures[0], zoneAlerteId: 20583 },
        { feature: targetFeatures[1], zoneAlerteId: 20584 },
      ]),
    ).rejects.toThrow('materialized target geometry changed');
    await runner.query(
      `UPDATE zone_alerte SET geom = ST_GeomFromEWKB($1) WHERE id = 20583`,
      [stored.target],
    );
  }, 30_000);

  it('persists the historical cursors and resumes an existing recompute debt', async () => {
    const firstDebt = await prepareSandreOperationRecomputeDebt(
      runner,
      'APPLIED',
      [1],
      '2016-07-18',
    );
    expect(firstDebt).toEqual([{ departmentId: 1, revision: 1 }]);
    const [initialCursors] = await runner.query(`
      SELECT
        "computeMapDate"::text AS "computeMapDate",
        "computeStatsDate"::text AS "computeStatsDate"
      FROM config
      WHERE id = 1
    `);
    expect(initialCursors).toEqual({
      computeMapDate: '2016-07-18',
      computeStatsDate: '2016-07-18',
    });

    const crashResumeDebt = await prepareSandreOperationRecomputeDebt(
      runner,
      'ALREADY_APPLIED',
      [1],
      '2016-07-18',
    );
    expect(crashResumeDebt).toEqual(firstDebt);
    const [pendingState] = await runner.query(`
      SELECT "needsRecompute", "recomputeRevision"
      FROM sandre_zone_sync_state
      WHERE "departementId" = 1
    `);
    expect(pendingState).toEqual({
      needsRecompute: true,
      recomputeRevision: 1,
    });

    await clearSandreOperationRecomputeDebt(runner, crashResumeDebt);
    await runner.query(`
      UPDATE config
      SET
        "computeMapDate" = DATE '2026-08-15',
        "computeStatsDate" = DATE '2026-08-15'
      WHERE id = 1
    `);
    const cleanReplayDebt = await prepareSandreOperationRecomputeDebt(
      runner,
      'ALREADY_APPLIED',
      [1],
      '2016-07-18',
    );
    expect(cleanReplayDebt).toEqual([]);
    const [finalState] = await runner.query(`
      SELECT
        state."needsRecompute",
        state."recomputeRevision",
        to_char(config."computeMapDate", 'YYYY-MM-DD') AS "computeMapDate",
        to_char(config."computeStatsDate", 'YYYY-MM-DD') AS "computeStatsDate"
      FROM sandre_zone_sync_state state
      CROSS JOIN config
      WHERE state."departementId" = 1
        AND config.id = 1
    `);
    expect(finalState).toEqual({
      needsRecompute: false,
      recomputeRevision: 1,
      computeMapDate: '2026-08-15',
      computeStatsDate: '2026-08-15',
    });
  });

  it('blocks the audited apply until the historic compute lock is released', async () => {
    const contender = dataSource.createQueryRunner();
    await contender.connect();
    await contender.query(`SET search_path TO "${schema}", public`);
    let ownerLocked = false;
    let contenderLocked = false;
    try {
      await runner.query(`
        INSERT INTO zone_alerte (
          id, "departementId", type, code, disabled, geom,
          "sandreProvenance"
        ) VALUES (
          5000, 2, 'SOU', 'LOCAL-CONCURRENT', true,
          ST_GeomFromText('POLYGON((3 0,4 0,4 1,3 0))', 4326),
          'legacy_unverified'
        )
      `);
      const plan = parseSandreReconciliationPlan({
        schemaVersion: 1,
        operationId: 'postgres-concurrent-apply',
        description: 'Historic lock integration fixture',
        actions: [
          {
            strategy: 'preserve_local',
            departmentCode: '2B',
            zoneType: 'SOU',
            sourceZoneId: 5000,
            expectedSourceCode: 'LOCAL-CONCURRENT',
          },
        ],
      });
      const [owner] = await runner.query(
        "SELECT pg_try_advisory_lock(hashtext('vigieau'), hashtext('zone-compute-historic')) AS locked",
      );
      ownerLocked = owner?.locked === true;
      expect(ownerLocked).toBe(true);

      let applySettled = false;
      const applyPromise = (async () => {
        try {
          contenderLocked = await acquireHistoricalRecomputeLock(
            contender,
            '2026-01-01',
            5_000,
          );
          await contender.startTransaction('SERIALIZABLE');
          await contender.query(
            "SELECT pg_advisory_xact_lock(hashtext('vigieau:sandre-zone-sync'), 2)",
          );
          await lockSandreReconciliationPlan(contender, plan);
          const audits = await auditSandreReconciliationPlan(contender, plan);
          await applySandreReconciliationActions(contender, audits);
          await contender.commitTransaction();
        } catch (error) {
          if (contender.isTransactionActive) {
            await contender.rollbackTransaction();
          }
          throw error;
        } finally {
          applySettled = true;
        }
      })();

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(applySettled).toBe(false);
      const [beforeRelease] = await runner.query(
        `SELECT disabled FROM zone_alerte WHERE id = 5000`,
      );
      expect(beforeRelease.disabled).toBe(true);

      const [released] = await runner.query(
        "SELECT pg_advisory_unlock(hashtext('vigieau'), hashtext('zone-compute-historic')) AS unlocked",
      );
      ownerLocked = false;
      expect(released?.unlocked).toBe(true);

      await applyPromise;
      expect(applySettled).toBe(true);
      const [afterRelease] = await runner.query(
        `SELECT disabled, "sandreProvenance" FROM zone_alerte WHERE id = 5000`,
      );
      expect(afterRelease).toEqual({
        disabled: false,
        sandreProvenance: 'local_preserved',
      });
    } finally {
      if (contenderLocked) {
        await contender.query(
          "SELECT pg_advisory_unlock(hashtext('vigieau'), hashtext('zone-compute-historic'))",
        );
      }
      if (ownerLocked) {
        await runner.query(
          "SELECT pg_advisory_unlock(hashtext('vigieau'), hashtext('zone-compute-historic'))",
        );
      }
      await contender.release();
      await runner.query(`DELETE FROM zone_alerte WHERE id = 5000`);
    }
  });
});

describeWithPostgres('Sandre schema drift recovery on PostgreSQL', () => {
  const schema = `sandre_schema_drift_${process.pid}_${Date.now()}`;
  let bootstrapDataSource: DataSource;
  let driftDataSource: DataSource;

  beforeAll(async () => {
    bootstrapDataSource = await new DataSource({
      type: 'postgres',
      url: postgresUrl,
      entities: [],
      synchronize: false,
      logging: false,
    }).initialize();
    await bootstrapDataSource.query(`CREATE SCHEMA "${schema}"`);

    driftDataSource = await new DataSource({
      type: 'postgres',
      url: postgresUrl,
      entities: [],
      migrations: [
        SandreZoneSync1785484800000,
        SandreZoneSchemaPrerequisites1786392000000,
        SandreZoneDurability1786395600000,
      ],
      migrationsTransactionMode: 'each',
      synchronize: false,
      logging: false,
      extra: { options: `-c search_path=${schema},public` },
    }).initialize();
  });

  afterAll(async () => {
    if (driftDataSource?.isInitialized) {
      await driftDataSource.destroy();
    }
    if (bootstrapDataSource?.isInitialized) {
      await bootstrapDataSource.query(
        `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
      );
      await bootstrapDataSource.destroy();
    }
  });

  it('repairs a skipped legacy schema before durability reads its columns', async () => {
    await driftDataSource.query(`
      CREATE TABLE "zone_alerte" (
        "id" integer PRIMARY KEY,
        "legacyValue" text NOT NULL
      );
      INSERT INTO "zone_alerte" ("id", "legacyValue")
      VALUES (1, 'preserve-me');
      CREATE TABLE "migrations" (
        "id" SERIAL NOT NULL,
        "timestamp" bigint NOT NULL,
        "name" character varying NOT NULL,
        CONSTRAINT "PK_sandre_drift_migrations" PRIMARY KEY ("id")
      );
      INSERT INTO "migrations" ("timestamp", "name")
      VALUES (1785484800000, 'SandreZoneSync1785484800000');
    `);

    const applied = await driftDataSource.runMigrations({
      transaction: 'each',
    });

    expect(applied.map(({ name }) => name)).toEqual([
      'SandreZoneSchemaPrerequisites1786392000000',
      'SandreZoneDurability1786395600000',
    ]);
    const columns = await driftDataSource.query(`
      SELECT
        "column_name" AS "columnName",
        "data_type" AS "dataType",
        "character_maximum_length"::integer AS "maximumLength",
        "is_nullable" AS "isNullable"
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'zone_alerte'
        AND "column_name" IN (
          'idSandre',
          'codeSandre',
          'statutSandre',
          'dateMajSandre',
          'numeroVersionSandre',
          'codesAlternatifs',
          'sandrePayloadHash'
        )
      ORDER BY "column_name"
    `);
    expect(columns).toEqual([
      {
        columnName: 'codeSandre',
        dataType: 'character varying',
        maximumLength: 32,
        isNullable: 'YES',
      },
      {
        columnName: 'codesAlternatifs',
        dataType: 'jsonb',
        maximumLength: null,
        isNullable: 'YES',
      },
      {
        columnName: 'dateMajSandre',
        dataType: 'date',
        maximumLength: null,
        isNullable: 'YES',
      },
      {
        columnName: 'idSandre',
        dataType: 'integer',
        maximumLength: null,
        isNullable: 'YES',
      },
      {
        columnName: 'numeroVersionSandre',
        dataType: 'integer',
        maximumLength: null,
        isNullable: 'YES',
      },
      {
        columnName: 'sandrePayloadHash',
        dataType: 'character varying',
        maximumLength: 64,
        isNullable: 'YES',
      },
      {
        columnName: 'statutSandre',
        dataType: 'character varying',
        maximumLength: 20,
        isNullable: 'YES',
      },
    ]);
    await expect(
      driftDataSource.query(`
        SELECT "legacyValue", "sandreProvenance"
        FROM "zone_alerte"
        WHERE "id" = 1
      `),
    ).resolves.toEqual([
      { legacyValue: 'preserve-me', sandreProvenance: 'legacy_unverified' },
    ]);

    const replayRunner = driftDataSource.createQueryRunner();
    await replayRunner.connect();
    try {
      await expect(
        new SandreZoneSchemaPrerequisites1786392000000().up(replayRunner),
      ).resolves.toBeUndefined();
    } finally {
      await replayRunner.release();
    }
    await expect(
      driftDataSource.runMigrations({ transaction: 'each' }),
    ).resolves.toEqual([]);
  });
});

function invalidTouchingHole(offset: number): any {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [offset, 0],
        [offset + 2, 0],
        [offset + 2, 2],
        [offset, 2],
        [offset, 0],
        [offset - 2, 0],
        [offset - 2, -2],
        [offset, -2],
        [offset, 0],
      ],
    ],
  };
}

function officialErdreFeature(): any {
  return {
    codeSandre: '300',
    gid: 408,
    departmentCode: '49',
    type: 'SOU',
    status: 'Validé',
    payloadHash: 'official-300-hash',
    basinCode: 1,
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [2, 0],
          [2, 2],
          [0, 2],
          [0, 0],
        ],
      ],
    },
  };
}

function officialAubanceFeature(): any {
  return {
    codeSandre: '301',
    gid: 409,
    departmentCode: '49',
    type: 'SOU',
    status: 'Validé',
    payloadHash: 'official-301-hash',
    basinCode: 1,
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [4, 0],
          [6, 0],
          [6, 2],
          [4, 2],
          [4, 0],
        ],
      ],
    },
  };
}

async function seedReconciliationFixture(runner: QueryRunner): Promise<void> {
  await runner.query(`
    INSERT INTO departement (id, code) VALUES
      (1, '2A'),
      (2, '2B'),
      (49, '49');
    INSERT INTO zone_alerte (
      id, "departementId", type, code, "idSandre", disabled, geom,
      "sandreProvenance", "statutSandre", "dateMajSandre",
      "numeroVersionSandre", "codesAlternatifs", "sandrePayloadHash"
    ) VALUES
      (4605, 2, 'SOU', '94_2B_01', NULL, true,
        ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 0))', 4326),
        'legacy_unverified', NULL, NULL, NULL, NULL, NULL),
      (100, 1, 'SOU', 'OLD-1', 100, true,
        ST_GeomFromText('POLYGON((0 0,2 0,2 1,0 1,0 0))', 4326),
        'legacy_unverified', NULL, NULL, NULL, NULL, NULL),
      (101, 1, 'SOU', 'NEW-1', 101, false,
        ST_GeomFromText('POLYGON((0 0,2 0,2 1,0 1,0 0))', 4326),
        'legacy_unverified', NULL, NULL, NULL, NULL, NULL),
      (300, 1, 'SUP', 'OLD-PARTITION', 300, true,
        ST_GeomFromText('POLYGON((0 0,2 0,2 1,0 1,0 0))', 4326),
        'legacy_unverified', NULL, NULL, NULL, NULL, NULL),
      (301, 1, 'SUP', 'NEW-PARTITION-A', 301, false,
        ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))', 4326),
        'legacy_unverified', NULL, NULL, NULL, NULL, NULL),
      (302, 1, 'SUP', 'NEW-PARTITION-B', 302, false,
        ST_GeomFromText('POLYGON((1 0,2 0,2 1,1 1,1 0))', 4326),
        'legacy_unverified', NULL, NULL, NULL, NULL, NULL),
      (9704, 49, 'SOU', '52_49_14', 408, false,
        ST_GeomFromText('POLYGON((0 0,2 0,2 2,0 2,0 0))', 4326),
        'legacy_unverified', NULL, NULL, NULL, NULL, NULL),
      (9707, 49, 'SOU', '52_49_14', 408, false,
        ST_GeomFromText('POLYGON((0 0,1.996 0,1.996 2,0 2,0 0))', 4326),
        'legacy_unverified', NULL, NULL, NULL, NULL, NULL);
    INSERT INTO sandre_zone_alias (
      "departementId", "zoneAlerteId", "zoneType", "aliasType",
      "aliasValue", source
    ) VALUES
      (2, 4605, 'SOU', 'cd_zas', 'LOCAL-OLD', 'legacy'),
      (49, 9704, 'SOU', 'cd_zas', 'CANONICAL', 'legacy'),
      (49, 9707, 'SOU', 'cd_zas', 'DUPLICATE', 'legacy');
    INSERT INTO arrete_cadre (id, statut) VALUES
      (1, 'publie'),
      (2, 'publie'),
      (3, 'abroge'),
      (4, 'abroge');
    INSERT INTO arrete_cadre_zone_alerte (
      "arreteCadreId", "zoneAlerteId"
    ) VALUES
      (1, 100),
      (2, 300),
      (3, 9704),
      (3, 9707),
      (4, 9707);
    INSERT INTO arrete_restriction (id, statut, "dateDebut") VALUES
      (10, 'abroge', DATE '2016-07-18'),
      (11, 'abroge', DATE '2021-01-01');
    INSERT INTO restriction (
      id, "arreteRestrictionId", "zoneAlerteId", "arreteCadreId",
      "nomGroupementAep", "niveauGravite"
    ) VALUES
      (100, 10, 9704, 3, NULL, 'alerte'),
      (101, 10, 9707, 3, NULL, 'crise'),
      (102, 11, 9707, 4, NULL, 'crise');
    INSERT INTO usage (
      id, nom, "thematiqueId", "restrictionId", "arreteCadreId",
      "isTemplate", "concerneParticulier", "descriptionCrise"
    ) VALUES
      (1, 'Shared', 1, 100, NULL, false, true, 'same'),
      (2, 'Shared', 1, 101, NULL, false, true, 'same'),
      (3, 'Unique', 1, 102, NULL, false, true, 'unique');
    INSERT INTO restriction_commune ("restrictionId", "communeId") VALUES
      (100, 1),
      (100, 2),
      (101, 1),
      (101, 2),
      (102, 3);
    INSERT INTO arrete_cadre_zone_alerte_communes (
      id, "arreteCadreId", "zoneAlerteId"
    ) VALUES
      (200, 3, 9704),
      (201, 3, 9707),
      (202, 4, 9707);
    INSERT INTO ac_za_communes (
      "arreteCadreZoneAlerteCommunesId", "communeId"
    ) VALUES
      (200, 1),
      (201, 1),
      (201, 2),
      (202, 3)
  `);
}
