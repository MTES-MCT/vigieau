import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DataSource } from "../apps/backend-admin/node_modules/typeorm/index.js";

const databaseUrl = process.env.MIGRATION_VERIFY_DATABASE_URL;
assert.ok(databaseUrl, "MIGRATION_VERIFY_DATABASE_URL is required");
const mode = process.env.MIGRATION_VERIFY_MODE || "fresh";
assert.ok(
  ["fresh", "upgrade"].includes(mode),
  "Unsupported migration verification mode",
);
const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
assert.match(
  databaseName,
  /(?:^|_)ci$/,
  "Migration verification is restricted to a dedicated *_ci database",
);

const dist = resolve("apps/backend-admin/dist");
const dataSource = new DataSource({
  type: "postgres",
  url: databaseUrl,
  entities: [`${dist}/global_shared/**/*.entity.js`],
  migrations: [`${dist}/apps/backend-admin/src/migrations/*.js`],
  synchronize: false,
  logging: false,
});

function waitForChild(child, label, captureOutput = false) {
  let stdout = "";
  if (captureOutput) {
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      assert.ok(
        stdout.length < 1_000_000,
        `${label} produced excessive output`,
      );
    });
  }
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) return resolvePromise(stdout.trim());
      reject(new Error(`${label} exited with ${code ?? signal}`));
    });
  });
}

async function resolveUpgradeBaseSha() {
  const requested = process.env.MIGRATION_VERIFY_BASE_SHA;
  const candidates = [];
  if (requested && !/^0+$/.test(requested)) candidates.push(requested);
  candidates.push("HEAD^");
  for (const candidate of candidates) {
    const child = spawn(
      "git",
      ["rev-parse", "--verify", `${candidate}^{commit}`],
      {
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    try {
      return await waitForChild(child, `git rev-parse ${candidate}`, true);
    } catch {
      // Fall back to the previous commit for local runs and initial pushes.
    }
  }
  throw new Error("No previous commit is available for upgrade verification");
}

async function extractCommit(sha, destination) {
  const archive = spawn("git", ["archive", sha], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const extract = spawn("tar", ["-x", "-C", destination], {
    stdio: ["pipe", "inherit", "inherit"],
  });
  archive.stdout.pipe(extract.stdin);
  await Promise.all([
    waitForChild(archive, `git archive ${sha}`),
    waitForChild(extract, `tar extraction for ${sha}`),
  ]);
}

async function runInherited(command, args, cwd, label) {
  const child = spawn(command, args, {
    cwd,
    stdio: "inherit",
  });
  await waitForChild(child, label);
}

async function prepareUpgradeDatabase() {
  const baseSha = await resolveUpgradeBaseSha();
  const checkout = await mkdtemp(join(tmpdir(), "vigieau-migration-base-"));
  try {
    await extractCommit(baseSha, checkout);
    await symlink(
      resolve("apps/backend-admin/node_modules"),
      join(checkout, "apps/backend-admin/node_modules"),
      "dir",
    );
    await runInherited(
      process.execPath,
      [
        resolve("apps/backend-admin/node_modules/@nestjs/cli/bin/nest.js"),
        "build",
      ],
      join(checkout, "apps/backend-admin"),
      `build of migration base ${baseSha}`,
    );

    const previousDist = join(checkout, "apps/backend-admin/dist");
    const previousDataSource = new DataSource({
      type: "postgres",
      url: databaseUrl,
      entities: [`${previousDist}/global_shared/**/*.entity.js`],
      migrations: [`${previousDist}/apps/backend-admin/src/migrations/*.js`],
      synchronize: false,
      logging: false,
    });
    await previousDataSource.initialize();
    try {
      await previousDataSource.query("CREATE EXTENSION IF NOT EXISTS postgis");
      const [{ baselineExists }] = await previousDataSource.query(`
        SELECT to_regclass(current_schema() || '."user"') IS NOT NULL
          AS "baselineExists"
      `);
      assert.equal(
        baselineExists,
        false,
        "The upgrade verifier requires an empty dedicated database",
      );
      await previousDataSource.synchronize();
      await previousDataSource.runMigrations({ transaction: "each" });
      assert.equal(
        await previousDataSource.showMigrations(),
        false,
        "The base revision still has pending migrations",
      );
      const statisticActivationBarrierAlreadyPresent =
        previousDataSource.migrations.some(
          ({ constructor }) =>
            constructor.name ===
            "StatisticPublicationActivationBarrier1786129200000",
        );
      if (!statisticActivationBarrierAlreadyPresent) {
        await previousDataSource.query(`
          ALTER TABLE "zone_publication_state"
          DROP COLUMN IF EXISTS "automaticPublishingPaused",
          DROP COLUMN IF EXISTS "automaticPublishingPausedAt"
        `);
      }
      await previousDataSource.query(`
        INSERT INTO "config" ("id", "computeMapDate", "computeStatsDate")
        VALUES (1, DATE '2026-07-30', DATE '2026-07-29')
        ON CONFLICT ("id") DO UPDATE SET
          "computeMapDate" = EXCLUDED."computeMapDate",
          "computeStatsDate" = EXCLUDED."computeStatsDate"
      `);
      await previousDataSource.query(`
        INSERT INTO "zone_publication" (
          "id", "sourceRevision", "materializationVersion", "status",
          "sourceComputedAt", "zoneCount", "communeLinkCount"
        )
        SELECT
          '00000000-0000-4000-8000-000000000101'::uuid,
          source_state."revision",
          2,
          'active',
          TIMESTAMPTZ '2026-08-02 08:00:00+00',
          0,
          0
        FROM "zone_publication_source_state" source_state
        WHERE source_state."id" = 1
      `);
      await previousDataSource.query(`
        UPDATE "zone_publication_state"
        SET "activePublicationId" =
          '00000000-0000-4000-8000-000000000101'::uuid,
            "updatedAt" = now()
        WHERE "id" = 1
      `);

      const [department] = await previousDataSource.query(`
        INSERT INTO "departement" ("code", "nom")
        VALUES ('UPG', 'Upgrade test')
        RETURNING "id"
      `);
      const legacyRestrictions = [
        [
          { date: "2026-08-01", SOU: null, SUP: "alerte", AEP: null },
          { date: "2026-07-31", SOU: null, SUP: null, AEP: null },
        ],
        [
          { date: "2026-07-31", SOU: null, SUP: "vigilance", AEP: null },
          { date: "2026-08-01", SOU: null, SUP: "alerte", AEP: null },
        ],
      ];
      for (let index = 0; index < legacyRestrictions.length; index++) {
        const [commune] = await previousDataSource.query(
          `
            INSERT INTO "commune" (
              "code", "nom", "departementId", "disabled"
            ) VALUES ($1, $2, $3, false)
            RETURNING "id"
          `,
          [`UPG00${index + 1}`, `Upgrade commune ${index + 1}`, department.id],
        );
        await previousDataSource.query(
          `
            INSERT INTO "statistic_commune" (
              "communeId", "restrictions", "restrictionsByMonth"
            ) VALUES ($1, $2::jsonb, '[]'::jsonb)
          `,
          [commune.id, JSON.stringify(legacyRestrictions[index])],
        );
      }
      return {
        baseSha,
        legacyRestrictions,
        simulatedPauseColumnDrift: !statisticActivationBarrierAlreadyPresent,
      };
    } finally {
      await previousDataSource.destroy();
    }
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
}

async function verifySandreReferenceGuards() {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    const [department] = await runner.query(`
      INSERT INTO "departement" ("code", "nom")
      VALUES ('TST', 'Migration test')
      RETURNING "id"
    `);
    const insertZone = async (code, codeSandre) => {
      const [zone] = await runner.query(
        `
          INSERT INTO "zone_alerte" (
            "nom", "code", "codeSandre", "type", "geom", "departementId"
          ) VALUES (
            $1, $2, $3, 'SUP',
            ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 0))', 4326),
            $4
          )
          RETURNING "id"
        `,
        [code, code, codeSandre, department.id],
      );
      return zone.id;
    };
    const insertRestrictionOrder = async (status = "a_valider") => {
      const [order] = await runner.query(
        `INSERT INTO "arrete_restriction" ("numero", "statut") VALUES ($1, $2) RETURNING "id"`,
        [`TEST-${Math.random()}`, status],
      );
      return order.id;
    };
    const insertFrameworkOrder = async (status) => {
      const [order] = await runner.query(
        `INSERT INTO "arrete_cadre" ("numero", "statut") VALUES ($1, $2) RETURNING "id"`,
        [`TEST-AC-${Math.random()}`, status],
      );
      return order.id;
    };
    const insertAlias = (oldCode, targetZoneId) =>
      runner.query(
        `
          INSERT INTO "sandre_zone_alias" (
            "departementId", "zoneAlerteId", "zoneType", "aliasType",
            "aliasValue", "source"
          ) VALUES ($1, $2, 'SUP', 'cd_zas', $3, 'manual_reconciliation')
        `,
        [department.id, targetZoneId, oldCode],
      );

    const targetZoneId = await insertZone("TEST_TARGET", "TEST_TARGET");
    const disabledZoneId = await insertZone("TEST_OLD", "TEST_OLD");
    await insertAlias("TEST_OLD", targetZoneId);
    await runner.query(
      `UPDATE "zone_alerte" SET "disabled" = true WHERE "id" = $1`,
      [disabledZoneId],
    );
    const draftOrderId = await insertRestrictionOrder("a_valider");
    const [draftReference] = await runner.query(
      `
        INSERT INTO "restriction" ("arreteRestrictionId", "zoneAlerteId")
        VALUES ($1, $2)
        RETURNING "zoneAlerteId"
      `,
      [draftOrderId, disabledZoneId],
    );
    assert.equal(
      draftReference.zoneAlerteId,
      disabledZoneId,
      "A draft reference to a disabled SANDRE zone was unexpectedly remapped",
    );
    await runner.query(
      `UPDATE "arrete_restriction" SET "statut" = 'a_venir' WHERE "id" = $1`,
      [draftOrderId],
    );
    const [activatedReference] = await runner.query(
      `SELECT "zoneAlerteId" FROM "restriction" WHERE "arreteRestrictionId" = $1`,
      [draftOrderId],
    );
    assert.equal(
      activatedReference.zoneAlerteId,
      targetZoneId,
      "Activating a draft order did not remap its disabled SANDRE zone reference",
    );

    const referencedZoneId = await insertZone(
      "TEST_REFERENCED_OLD",
      "TEST_REFERENCED_OLD",
    );
    await insertAlias("TEST_REFERENCED_OLD", targetZoneId);
    const referencedOrderId = await insertRestrictionOrder("publie");
    await runner.query(
      `INSERT INTO "restriction" ("arreteRestrictionId", "zoneAlerteId") VALUES ($1, $2)`,
      [referencedOrderId, referencedZoneId],
    );
    await runner.query(
      `UPDATE "zone_alerte" SET "disabled" = true WHERE "id" = $1`,
      [referencedZoneId],
    );
    const [referenceAfterDisable] = await runner.query(
      `SELECT "zoneAlerteId" FROM "restriction" WHERE "arreteRestrictionId" = $1`,
      [referencedOrderId],
    );
    assert.equal(
      referenceAfterDisable.zoneAlerteId,
      targetZoneId,
      "Existing references were not remapped before disabling a SANDRE zone",
    );

    const unresolvedZoneId = await insertZone(
      "TEST_UNRESOLVED",
      "TEST_UNRESOLVED",
    );
    await runner.query(
      `UPDATE "zone_alerte" SET "disabled" = true WHERE "id" = $1`,
      [unresolvedZoneId],
    );
    const unresolvedOrderId = await insertRestrictionOrder("publie");
    await runner.query("SAVEPOINT unresolved_reference");
    let blocked = false;
    try {
      await runner.query(
        `INSERT INTO "restriction" ("arreteRestrictionId", "zoneAlerteId") VALUES ($1, $2)`,
        [unresolvedOrderId, unresolvedZoneId],
      );
    } catch (error) {
      blocked = error?.code === "23514";
      await runner.query("ROLLBACK TO SAVEPOINT unresolved_reference");
    }
    assert.equal(
      blocked,
      true,
      "An unresolved disabled SANDRE zone reference was not rejected",
    );

    const legacyInvalidZoneId = await insertZone(
      "TEST_LEGACY_INVALID",
      "TEST_LEGACY_INVALID",
    );
    const legacyInvalidOrderId = await insertRestrictionOrder();
    const [legacyInvalidReference] = await runner.query(
      `
        INSERT INTO "restriction" (
          "arreteRestrictionId", "zoneAlerteId", "niveauGravite"
        ) VALUES ($1, $2, 'vigilance')
        RETURNING "id"
      `,
      [legacyInvalidOrderId, legacyInvalidZoneId],
    );
    await runner.query(`
      ALTER TABLE "zone_alerte"
      DISABLE TRIGGER "TRG_zone_alerte_remap_references_before_disable"
    `);
    await runner.query(
      `UPDATE "zone_alerte" SET "disabled" = true WHERE "id" = $1`,
      [legacyInvalidZoneId],
    );
    await runner.query(`
      ALTER TABLE "zone_alerte"
      ENABLE TRIGGER "TRG_zone_alerte_remap_references_before_disable"
    `);
    await runner.query(
      `
        UPDATE "restriction"
        SET "niveauGravite" = 'alerte'
        WHERE "id" = $1
      `,
      [legacyInvalidReference.id],
    );
    const [legacyInvalidAfterUpdate] = await runner.query(
      `SELECT "zoneAlerteId" FROM "restriction" WHERE "id" = $1`,
      [legacyInvalidReference.id],
    );
    assert.equal(
      legacyInvalidAfterUpdate.zoneAlerteId,
      legacyInvalidZoneId,
      "An unrelated update touched a legacy disabled-zone reference",
    );

    const historicalZoneId = await insertZone(
      "TEST_HISTORICAL",
      "TEST_HISTORICAL",
    );
    await insertAlias("TEST_HISTORICAL", targetZoneId);
    const abrogatedOrderId = await insertRestrictionOrder("abroge");
    const [historicalReference] = await runner.query(
      `
        INSERT INTO "restriction" (
          "arreteRestrictionId", "zoneAlerteId", "niveauGravite"
        ) VALUES ($1, $2, 'vigilance')
        RETURNING "id"
      `,
      [abrogatedOrderId, historicalZoneId],
    );
    await runner.query(
      `UPDATE "zone_alerte" SET "disabled" = true WHERE "id" = $1`,
      [historicalZoneId],
    );
    await runner.query(
      `
        UPDATE "restriction"
        SET "niveauGravite" = 'alerte'
        WHERE "id" = $1
      `,
      [historicalReference.id],
    );
    const [updatedHistoricalReference] = await runner.query(
      `SELECT "zoneAlerteId" FROM "restriction" WHERE "id" = $1`,
      [historicalReference.id],
    );
    assert.equal(
      updatedHistoricalReference.zoneAlerteId,
      historicalZoneId,
      "An unrelated update rewrote an abrogated historical reference",
    );
    await runner.query(
      `UPDATE "arrete_restriction" SET "statut" = 'publie' WHERE "id" = $1`,
      [abrogatedOrderId],
    );
    const [reactivatedReference] = await runner.query(
      `SELECT "zoneAlerteId" FROM "restriction" WHERE "id" = $1`,
      [historicalReference.id],
    );
    assert.equal(
      reactivatedReference.zoneAlerteId,
      targetZoneId,
      "Reactivating a restriction order did not remap its disabled-zone references",
    );

    const historicalFrameworkZoneId = await insertZone(
      "TEST_HISTORICAL_AC",
      "TEST_HISTORICAL_AC",
    );
    await insertAlias("TEST_HISTORICAL_AC", targetZoneId);
    const abrogatedFrameworkOrderId = await insertFrameworkOrder("abroge");
    await runner.query(
      `
        INSERT INTO "arrete_cadre_zone_alerte" (
          "arreteCadreId", "zoneAlerteId"
        ) VALUES ($1, $2)
      `,
      [abrogatedFrameworkOrderId, historicalFrameworkZoneId],
    );
    await runner.query(
      `UPDATE "zone_alerte" SET "disabled" = true WHERE "id" = $1`,
      [historicalFrameworkZoneId],
    );
    const [historicalFrameworkReference] = await runner.query(
      `
        SELECT "zoneAlerteId"
        FROM "arrete_cadre_zone_alerte"
        WHERE "arreteCadreId" = $1
      `,
      [abrogatedFrameworkOrderId],
    );
    assert.equal(
      historicalFrameworkReference.zoneAlerteId,
      historicalFrameworkZoneId,
      "An abrogated framework-order link did not remain historical",
    );
    await runner.query(
      `UPDATE "arrete_cadre" SET "statut" = 'publie' WHERE "id" = $1`,
      [abrogatedFrameworkOrderId],
    );
    const reactivatedFrameworkReferences = await runner.query(
      `
        SELECT "zoneAlerteId"
        FROM "arrete_cadre_zone_alerte"
        WHERE "arreteCadreId" = $1
      `,
      [abrogatedFrameworkOrderId],
    );
    assert.deepEqual(
      reactivatedFrameworkReferences.map(({ zoneAlerteId }) => zoneAlerteId),
      [targetZoneId],
      "Reactivating a framework order did not remap its disabled-zone references",
    );

    const unresolvedHistoricalZoneId = await insertZone(
      "TEST_HISTORICAL_UNRESOLVED",
      "TEST_HISTORICAL_UNRESOLVED",
    );
    const unresolvedHistoricalOrderId = await insertRestrictionOrder("abroge");
    await runner.query(
      `INSERT INTO "restriction" ("arreteRestrictionId", "zoneAlerteId") VALUES ($1, $2)`,
      [unresolvedHistoricalOrderId, unresolvedHistoricalZoneId],
    );
    await runner.query(
      `UPDATE "zone_alerte" SET "disabled" = true WHERE "id" = $1`,
      [unresolvedHistoricalZoneId],
    );
    await runner.query("SAVEPOINT unresolved_parent_reactivation");
    let reactivationBlocked = false;
    try {
      await runner.query(
        `UPDATE "arrete_restriction" SET "statut" = 'publie' WHERE "id" = $1`,
        [unresolvedHistoricalOrderId],
      );
    } catch (error) {
      reactivationBlocked = error?.code === "23514";
      await runner.query(
        "ROLLBACK TO SAVEPOINT unresolved_parent_reactivation",
      );
    }
    assert.equal(
      reactivationBlocked,
      true,
      "Reactivating a parent with an unresolved disabled-zone reference was not rejected",
    );
  } finally {
    await runner.rollbackTransaction();
    await runner.release();
  }
}

async function verifyStatisticCachePublication() {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  let savepointSequence = 0;

  const expectDatabaseError = async (expectedCode, action, message) => {
    const savepoint = `statistic_cache_guard_${++savepointSequence}`;
    await runner.query(`SAVEPOINT ${savepoint}`);
    let blocked = false;
    try {
      await action();
    } catch (error) {
      blocked = error?.code === expectedCode;
    } finally {
      await runner.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    }
    assert.equal(blocked, true, message);
  };

  const payloadHex = "1f8b0800000000000003abae050043bfa6a302000000";
  const payloadByteLength = Buffer.from(payloadHex, "hex").length;
  const areaFingerprint = "a".repeat(64);
  const departmentFingerprint = "b".repeat(64);
  const communeFingerprint = "c".repeat(64);
  const publicationFingerprint = "f".repeat(64);
  const checksum = "1".repeat(64);
  const incompletePublicationId = "00000000-0000-4000-8000-000000000201";
  const completePublicationId = "00000000-0000-4000-8000-000000000202";
  const disposablePublicationId = "00000000-0000-4000-8000-000000000203";
  const invalidBoundaryPublicationId = "00000000-0000-4000-8000-000000000204";
  const replacementPublicationId = "00000000-0000-4000-8000-000000000205";
  const rematerializedPublicationId = "00000000-0000-4000-8000-000000000206";

  const insertBuildingPublication = async ({
    id,
    statisticRevision,
    currentPublishedDate,
    contentFingerprint = null,
    materializationStrategy = "full-clean",
    historicDirtyFrom = null,
    historicDirtyThrough = null,
    historicMapCursor = null,
    historicStatsCursor = null,
    sourceRevision = null,
    historicComputeEpoch = null,
  }) => {
    await runner.query(
      `
        INSERT INTO "statistic_cache_publication" (
          "id", "statisticRevision", "currentPublishedDate",
          "schemaVersion", "mode", "materializationStrategy", "status",
          "historicDirtyFrom", "historicDirtyThrough",
          "historicMapCursor", "historicStatsCursor", "sourceRevision",
          "historicComputeEpoch", "firstDate", "latestDate",
          "dateCount", "areaCount", "departmentCount", "communeCount",
          "contentFingerprint", "compressedByteLength",
          "uncompressedByteLength"
        ) VALUES (
          $1, $2, $3, 1, 'legacy-bootstrap', $5, 'building',
          $6, $7, $8, $9, $10, $11,
          DATE '2026-08-14', $3, 2, 2, 101, 34943, $4, 0, 0
        )
      `,
      [
        id,
        statisticRevision,
        currentPublishedDate,
        contentFingerprint,
        materializationStrategy,
        historicDirtyFrom,
        historicDirtyThrough,
        historicMapCursor,
        historicStatsCursor,
        sourceRevision,
        historicComputeEpoch,
      ],
    );
  };

  const completeBuildingPublication = async ({
    id,
    statisticRevision,
    currentPublishedDate,
    contentFingerprint,
  }) => {
    await insertBuildingPublication({
      id,
      statisticRevision,
      currentPublishedDate,
    });
    await runner.query(
      `
        INSERT INTO "statistic_cache_artifact" (
          "publicationId", "kind", "rowCount", "contentFingerprint",
          "checksum", "compressedByteLength", "uncompressedByteLength",
          "payload"
        ) VALUES
          ($1, 'area', 2, $2, $5, $6, 2, decode($7, 'hex')),
          ($1, 'departement', 2, $3, $5, $6, 2, decode($7, 'hex')),
          ($1, 'commune', 34943, $4, $5, $6, 2, decode($7, 'hex'))
      `,
      [
        id,
        areaFingerprint,
        departmentFingerprint,
        communeFingerprint,
        checksum,
        payloadByteLength,
        payloadHex,
      ],
    );
    await runner.query(
      `
        UPDATE "statistic_cache_publication"
        SET "status" = 'ready',
            "contentFingerprint" = $2,
            "compressedByteLength" = $3,
            "uncompressedByteLength" = 6,
            "readyAt" = now()
        WHERE "id" = $1
      `,
      [id, contentFingerprint, payloadByteLength * 3],
    );
  };

  try {
    await insertBuildingPublication({
      id: incompletePublicationId,
      statisticRevision: 10,
      currentPublishedDate: "2026-08-15",
    });
    await expectDatabaseError(
      "23514",
      () =>
        runner.query(
          `
            UPDATE "statistic_cache_publication"
            SET "status" = 'ready',
                "contentFingerprint" = $2,
                "compressedByteLength" = 1,
                "uncompressedByteLength" = 1,
                "readyAt" = now()
            WHERE "id" = $1
          `,
          [incompletePublicationId, publicationFingerprint],
        ),
      "An incomplete statistic cache publication was marked ready",
    );
    await runner.query(
      'DELETE FROM "statistic_cache_publication" WHERE "id" = $1',
      [incompletePublicationId],
    );

    await completeBuildingPublication({
      id: completePublicationId,
      statisticRevision: 11,
      currentPublishedDate: "2026-08-15",
      contentFingerprint: publicationFingerprint,
    });

    const [readyPublication] = await runner.query(
      `
        SELECT "status", "contentFingerprint", "compressedByteLength"::text
          AS "compressedByteLength"
        FROM "statistic_cache_publication"
        WHERE "id" = $1
      `,
      [completePublicationId],
    );
    assert.deepEqual(
      readyPublication,
      {
        status: "ready",
        contentFingerprint: publicationFingerprint,
        compressedByteLength: String(payloadByteLength * 3),
      },
      "The complete statistic cache publication did not become ready",
    );
    await expectDatabaseError(
      "23514",
      () =>
        runner.query(
          `UPDATE "statistic_cache_publication" SET "communeCount" = 1 WHERE "id" = $1`,
          [completePublicationId],
        ),
      "Ready statistic cache publication metadata remained mutable",
    );
    await expectDatabaseError(
      "23514",
      () =>
        runner.query(
          `UPDATE "statistic_cache_publication" SET "sourceRevision" = 99 WHERE "id" = $1`,
          [completePublicationId],
        ),
      "Ready statistic cache publication audit context remained mutable",
    );
    await expectDatabaseError(
      "23514",
      () =>
        runner.query(
          `
            UPDATE "statistic_cache_artifact"
            SET "rowCount" = 2
            WHERE "publicationId" = $1 AND "kind" = 'area'
          `,
          [completePublicationId],
        ),
      "A persisted statistic cache artifact remained mutable",
    );
    await expectDatabaseError(
      "23514",
      () =>
        runner.query(
          `
            DELETE FROM "statistic_cache_artifact"
            WHERE "publicationId" = $1 AND "kind" = 'area'
          `,
          [completePublicationId],
        ),
      "A ready statistic cache artifact could be deleted directly",
    );

    await runner.query(
      `
        UPDATE "statistic_cache_publication"
        SET "status" = 'active', "activatedAt" = now()
        WHERE "id" = $1
      `,
      [completePublicationId],
    );
    await runner.query(
      `
        UPDATE "statistic_cache_state"
        SET "activePublicationId" = $1, "previousPublicationId" = NULL
        WHERE "id" = 1
      `,
      [completePublicationId],
    );
    await expectDatabaseError(
      "23514",
      () =>
        runner.query(
          `
            UPDATE "statistic_cache_state"
            SET "previousPublicationId" = "activePublicationId"
            WHERE "id" = 1
          `,
        ),
      "The singleton accepted the same active and previous publication",
    );

    const replacementFingerprint = "d".repeat(64);
    const rematerializedFingerprint = "9".repeat(64);
    await completeBuildingPublication({
      id: replacementPublicationId,
      statisticRevision: 12,
      currentPublishedDate: "2026-08-16",
      contentFingerprint: replacementFingerprint,
    });
    await runner.query(
      `
        UPDATE "statistic_cache_publication"
        SET "status" = 'retired', "retiredAt" = now()
        WHERE "id" = $1 AND "status" = 'active'
      `,
      [completePublicationId],
    );
    await runner.query(
      `
        UPDATE "statistic_cache_publication"
        SET "status" = 'active', "activatedAt" = now()
        WHERE "id" = $1 AND "status" = 'ready'
      `,
      [replacementPublicationId],
    );
    await runner.query(
      `
        UPDATE "statistic_cache_state"
        SET "activePublicationId" = $1, "previousPublicationId" = $2
        WHERE "id" = 1
      `,
      [replacementPublicationId, completePublicationId],
    );

    const rollback = async (activePublicationId, previousPublicationId) => {
      await runner.query(
        `
          UPDATE "statistic_cache_publication"
          SET "status" = 'retired', "retiredAt" = now()
          WHERE "id" = $1 AND "status" = 'active'
        `,
        [activePublicationId],
      );
      await runner.query(
        `
          UPDATE "statistic_cache_publication"
          SET "status" = 'active', "activatedAt" = now(), "retiredAt" = NULL
          WHERE "id" = $1 AND "status" = 'retired'
        `,
        [previousPublicationId],
      );
      await runner.query(
        `
          UPDATE "statistic_cache_state"
          SET "activePublicationId" = $1, "previousPublicationId" = $2
          WHERE "id" = 1
        `,
        [previousPublicationId, activePublicationId],
      );
    };
    await rollback(replacementPublicationId, completePublicationId);
    await rollback(replacementPublicationId, completePublicationId);

    await completeBuildingPublication({
      id: rematerializedPublicationId,
      statisticRevision: 12,
      currentPublishedDate: "2026-08-16",
      contentFingerprint: rematerializedFingerprint,
    });
    await runner.query(
      `
        UPDATE "statistic_cache_publication"
        SET "status" = 'retired', "retiredAt" = now()
        WHERE "id" = $1 AND "status" = 'active'
      `,
      [completePublicationId],
    );
    await runner.query(
      `
        UPDATE "statistic_cache_publication"
        SET "status" = 'active', "activatedAt" = now()
        WHERE "id" = $1 AND "status" = 'ready'
      `,
      [rematerializedPublicationId],
    );
    await runner.query(
      `
        UPDATE "statistic_cache_state"
        SET "activePublicationId" = $1, "previousPublicationId" = $2
        WHERE "id" = 1
      `,
      [rematerializedPublicationId, completePublicationId],
    );
    await rollback(rematerializedPublicationId, completePublicationId);
    await rollback(completePublicationId, rematerializedPublicationId);

    const [recoveryState] = await runner.query(
      `
        SELECT
          state."activePublicationId"::text AS "activePublicationId",
          state."previousPublicationId"::text AS "previousPublicationId",
          active."contentFingerprint" AS "activeFingerprint",
          previous."status" AS "previousStatus"
        FROM "statistic_cache_state" state
        JOIN "statistic_cache_publication" active
          ON active."id" = state."activePublicationId"
        JOIN "statistic_cache_publication" previous
          ON previous."id" = state."previousPublicationId"
        WHERE state."id" = 1
      `,
    );
    assert.deepEqual(
      recoveryState,
      {
        activePublicationId: rematerializedPublicationId,
        previousPublicationId: completePublicationId,
        activeFingerprint: rematerializedFingerprint,
        previousStatus: "retired",
      },
      "Rollback and same-identity rematerialization did not preserve a usable active/previous pair",
    );

    await runner.query(
      `
        INSERT INTO "zone_publication_instance" (
          "instanceId", "statisticCachePublicationId", "statisticRevision",
          "statisticPublishedDate", "statisticFingerprint",
          "statisticLastError"
        ) VALUES ($1, $2, 11, DATE '2026-08-15', $3, NULL)
      `,
      [
        "statistic-cache-active-instance",
        completePublicationId,
        publicationFingerprint,
      ],
    );
    await expectDatabaseError(
      "23514",
      () =>
        runner.query(
          `
            INSERT INTO "zone_publication_instance" (
              "instanceId", "statisticCachePublicationId"
            ) VALUES ('statistic-cache-partial-instance', $1)
          `,
          [completePublicationId],
        ),
      "A heartbeat accepted a partial statistic cache identity",
    );

    const disposableFingerprint = "e".repeat(64);
    await expectDatabaseError(
      "23514",
      () =>
        insertBuildingPublication({
          id: invalidBoundaryPublicationId,
          statisticRevision: 13,
          currentPublishedDate: "2026-08-17",
          materializationStrategy: "legacy-safe-boundary",
        }),
      "A legacy safe-boundary publication was accepted without audit context",
    );
    await insertBuildingPublication({
      id: disposablePublicationId,
      statisticRevision: 12,
      currentPublishedDate: "2026-08-16",
      contentFingerprint: disposableFingerprint,
      materializationStrategy: "legacy-safe-boundary",
      historicDirtyFrom: "2015-01-01",
      historicDirtyThrough: "2026-08-15",
      historicMapCursor: "2015-01-28",
      historicStatsCursor: "2015-01-28",
      sourceRevision: 42,
      historicComputeEpoch: 17,
    });
    await runner.query(
      `
        INSERT INTO "zone_publication_instance" (
          "instanceId", "statisticCachePublicationId", "statisticRevision",
          "statisticPublishedDate", "statisticFingerprint",
          "statisticLastError"
        ) VALUES ($1, $2, 12, DATE '2026-08-16', $3, 'load failed')
      `,
      [
        "statistic-cache-disposable-instance",
        disposablePublicationId,
        disposableFingerprint,
      ],
    );
    await runner.query(
      'DELETE FROM "statistic_cache_publication" WHERE "id" = $1',
      [disposablePublicationId],
    );
    const [clearedHeartbeat] = await runner.query(`
      SELECT
        "statisticCachePublicationId", "statisticRevision",
        "statisticPublishedDate", "statisticFingerprint",
        "statisticLastError"
      FROM "zone_publication_instance"
      WHERE "instanceId" = 'statistic-cache-disposable-instance'
    `);
    assert.deepEqual(
      clearedHeartbeat,
      {
        statisticCachePublicationId: null,
        statisticRevision: null,
        statisticPublishedDate: null,
        statisticFingerprint: null,
        statisticLastError: "load failed",
      },
      "Deleting a disposable publication did not clear its full heartbeat identity",
    );

    await runner.query(`
      UPDATE "statistic_cache_state"
      SET "activePublicationId" = NULL, "previousPublicationId" = NULL
      WHERE "id" = 1
    `);
    await runner.query(
      `
        UPDATE "statistic_cache_publication"
        SET "status" = 'retired', "retiredAt" = now()
        WHERE "id" = $1 AND "status" = 'active'
      `,
      [rematerializedPublicationId],
    );
    await runner.query(
      `
        UPDATE "statistic_cache_publication"
        SET "status" = 'retired', "retiredAt" = now()
        WHERE "id" = $1
      `,
      [completePublicationId],
    );
    await runner.query(
      'DELETE FROM "statistic_cache_publication" WHERE "id" = $1',
      [completePublicationId],
    );
    await runner.query(
      'DELETE FROM "statistic_cache_publication" WHERE "id" IN ($1, $2)',
      [replacementPublicationId, rematerializedPublicationId],
    );
    const [{ artifactCountAfterCollection }] = await runner.query(
      `
        SELECT count(*)::integer AS "artifactCountAfterCollection"
        FROM "statistic_cache_artifact"
        WHERE "publicationId" = $1
      `,
      [completePublicationId],
    );
    assert.equal(
      artifactCountAfterCollection,
      0,
      "Collecting a retired publication did not cascade to its artifacts",
    );
  } finally {
    await runner.rollbackTransaction();
    await runner.release();
  }
}

const upgrade = mode === "upgrade" ? await prepareUpgradeDatabase() : null;

await dataSource.initialize();
try {
  await dataSource.query("CREATE EXTENSION IF NOT EXISTS postgis");
  const [{ baselineExists }] = await dataSource.query(`
    SELECT to_regclass(current_schema() || '."user"') IS NOT NULL
      AS "baselineExists"
  `);
  if (!baselineExists) {
    await dataSource.synchronize();
  }
  const applied = await dataSource.runMigrations({ transaction: "each" });
  const pending = await dataSource.showMigrations();
  assert.equal(pending, false, "Some migrations are still pending");

  const cursorGenerationColumns = await dataSource.query(`
    SELECT "column_name", "is_nullable"
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'config'
      AND "column_name" IN (
        'computeMapGeneration',
        'computeStatsGeneration'
      )
    ORDER BY "column_name"
  `);
  assert.deepEqual(
    cursorGenerationColumns,
    [
      { column_name: "computeMapGeneration", is_nullable: "NO" },
      { column_name: "computeStatsGeneration", is_nullable: "NO" },
    ],
    "The historic cursor generations are missing",
  );
  const cursorProgressColumns = await dataSource.query(`
    SELECT "column_name", "data_type", "is_nullable"
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'config'
      AND "column_name" IN (
        'computeMapUpdatedAt',
        'computeStatsUpdatedAt'
      )
    ORDER BY "column_name"
  `);
  assert.deepEqual(
    cursorProgressColumns,
    [
      {
        column_name: "computeMapUpdatedAt",
        data_type: "timestamp with time zone",
        is_nullable: "YES",
      },
      {
        column_name: "computeStatsUpdatedAt",
        data_type: "timestamp with time zone",
        is_nullable: "YES",
      },
    ],
    "The historic cursor progress timestamps are missing",
  );

  const publicationPauseColumns = await dataSource.query(`
    SELECT "column_name", "data_type", "is_nullable", "column_default"
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'zone_publication_state'
      AND "column_name" IN (
        'automaticPublishingPaused',
        'automaticPublishingPausedAt'
      )
    ORDER BY "column_name"
  `);
  assert.deepEqual(
    publicationPauseColumns.map(
      ({ column_name, data_type, is_nullable, column_default }) => ({
        columnName: column_name,
        dataType: data_type,
        nullable: is_nullable,
        hasFalseDefault: column_default === "false",
      }),
    ),
    [
      {
        columnName: "automaticPublishingPaused",
        dataType: "boolean",
        nullable: "NO",
        hasFalseDefault: true,
      },
      {
        columnName: "automaticPublishingPausedAt",
        dataType: "timestamp with time zone",
        nullable: "YES",
        hasFalseDefault: false,
      },
    ],
    "The automatic-publication pause columns were not installed or repaired",
  );
  const [publicationPauseState] = await dataSource.query(`
    SELECT "automaticPublishingPaused", "automaticPublishingPausedAt"
    FROM "zone_publication_state"
    WHERE "id" = 1
  `);
  assert.deepEqual(
    publicationPauseState,
    {
      automaticPublishingPaused: false,
      automaticPublishingPausedAt: null,
    },
    "The automatic-publication pause state was not seeded safely",
  );

  const statisticBarrierColumns = await dataSource.query(`
    SELECT "table_name", "column_name", "data_type", "is_nullable"
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND (
        (
          table_name = 'statistic_commune_snapshot'
          AND "column_name" = 'sourceRevision'
        )
        OR (
          table_name = 'statistic_publication_state'
          AND "column_name" IN (
            'id',
            'revision',
            'currentPublishedDate',
            'historicPublishedThrough',
            'historicDirtyFrom',
            'historicDirtyThrough',
            'updatedAt'
          )
        )
      )
    ORDER BY "table_name", "column_name"
  `);
  assert.deepEqual(
    statisticBarrierColumns.map(
      ({ table_name, column_name, data_type, is_nullable }) => ({
        tableName: table_name,
        columnName: column_name,
        dataType: data_type,
        nullable: is_nullable,
      }),
    ),
    [
      {
        tableName: "statistic_commune_snapshot",
        columnName: "sourceRevision",
        dataType: "bigint",
        nullable: "YES",
      },
      {
        tableName: "statistic_publication_state",
        columnName: "currentPublishedDate",
        dataType: "date",
        nullable: "YES",
      },
      {
        tableName: "statistic_publication_state",
        columnName: "historicDirtyFrom",
        dataType: "date",
        nullable: "YES",
      },
      {
        tableName: "statistic_publication_state",
        columnName: "historicDirtyThrough",
        dataType: "date",
        nullable: "YES",
      },
      {
        tableName: "statistic_publication_state",
        columnName: "historicPublishedThrough",
        dataType: "date",
        nullable: "YES",
      },
      {
        tableName: "statistic_publication_state",
        columnName: "id",
        dataType: "integer",
        nullable: "NO",
      },
      {
        tableName: "statistic_publication_state",
        columnName: "revision",
        dataType: "bigint",
        nullable: "NO",
      },
      {
        tableName: "statistic_publication_state",
        columnName: "updatedAt",
        dataType: "timestamp with time zone",
        nullable: "NO",
      },
    ],
    "The statistic publication barrier columns are incomplete",
  );
  const statisticBarrierConstraints = await dataSource.query(`
    SELECT conname, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = '"statistic_publication_state"'::regclass
      AND conname IN (
        'CHK_statistic_publication_state_singleton',
        'CHK_statistic_publication_state_dirty_range'
      )
    ORDER BY conname
  `);
  assert.deepEqual(
    statisticBarrierConstraints.map(({ conname }) => conname),
    [
      "CHK_statistic_publication_state_dirty_range",
      "CHK_statistic_publication_state_singleton",
    ],
    "The statistic publication state constraints are missing",
  );
  assert.match(
    statisticBarrierConstraints[0].definition,
    /historicDirtyFrom.*historicDirtyThrough/s,
    "The dirty-range constraint does not bind both limits",
  );
  const [statisticSnapshotStatusConstraint] = await dataSource.query(`
    SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = '"statistic_commune_snapshot"'::regclass
      AND conname = 'CHK_statistic_commune_snapshot_status'
  `);
  assert.match(
    statisticSnapshotStatusConstraint?.definition || "",
    /'ready'/,
    "The statistic snapshot status constraint does not allow ready candidates",
  );
  const [statisticPublicationState] = await dataSource.query(`
    SELECT
      statistic_state."id",
      statistic_state."revision"::text AS "revision",
      statistic_state."currentPublishedDate"::text AS "currentPublishedDate",
      statistic_state."historicPublishedThrough"::text AS "historicPublishedThrough",
      statistic_state."historicDirtyFrom"::text AS "historicDirtyFrom",
      statistic_state."historicDirtyThrough"::text AS "historicDirtyThrough",
      (active."sourceComputedAt" AT TIME ZONE 'UTC')::date::text
        AS "expectedPublishedDate"
    FROM "statistic_publication_state" statistic_state
    LEFT JOIN "zone_publication_state" publication_state
      ON publication_state."id" = statistic_state."id"
    LEFT JOIN "zone_publication" active
      ON active."id" = publication_state."activePublicationId"
      AND active."status" = 'active'
    WHERE statistic_state."id" = 1
  `);
  assert.deepEqual(
    statisticPublicationState,
    upgrade?.simulatedPauseColumnDrift
      ? {
          id: 1,
          revision: "0",
          currentPublishedDate: "2026-08-02",
          historicPublishedThrough: "2026-07-28",
          historicDirtyFrom: "2026-07-29",
          historicDirtyThrough: "2026-08-01",
          expectedPublishedDate: "2026-08-02",
        }
      : upgrade
        ? {
            id: 1,
            revision: "0",
            currentPublishedDate: null,
            historicPublishedThrough: null,
            historicDirtyFrom: null,
            historicDirtyThrough: null,
            expectedPublishedDate: "2026-08-02",
          }
        : {
            id: 1,
            revision: "0",
            currentPublishedDate: null,
            historicPublishedThrough: null,
            historicDirtyFrom: null,
            historicDirtyThrough: null,
            expectedPublishedDate: null,
          },
    "The statistic publication state seed is inconsistent with the active publication",
  );

  const [invalidReferences] = await dataSource.query(`
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
  assert.deepEqual(
    {
      arreteRestrictions: Number(invalidReferences?.arreteRestrictions || 0),
      arreteCadres: Number(invalidReferences?.arreteCadres || 0),
      customizations: Number(invalidReferences?.customizations || 0),
    },
    { arreteRestrictions: 0, arreteCadres: 0, customizations: 0 },
    "An operational order references a disabled alert zone",
  );
  const [customizationUniqueness] = await dataSource.query(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_constraint constraint_definition
      WHERE constraint_definition.conrelid =
          '"arrete_cadre_zone_alerte_communes"'::regclass
        AND constraint_definition.conname =
          'UQ_ac_za_communes_arrete_cadre_zone'
        AND constraint_definition.contype = 'u'
        AND ARRAY(
          SELECT attribute.attname::text
          FROM unnest(constraint_definition.conkey) WITH ORDINALITY
            AS key_column(attnum, position)
          JOIN pg_attribute attribute
            ON attribute.attrelid = constraint_definition.conrelid
            AND attribute.attnum = key_column.attnum
          ORDER BY key_column.position
        ) = ARRAY['arreteCadreId', 'zoneAlerteId']::text[]
    ) AS "exists"
  `);
  assert.equal(
    customizationUniqueness.exists,
    true,
    "The framework-order customization uniqueness constraint is missing",
  );
  const durabilityConstraints = await dataSource.query(`
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = '"zone_publication_aggregate"'::regclass
      AND conname IN (
        'FK_zone_publication_aggregate_publication',
        'CHK_zone_publication_aggregate_payload'
      )
  `);
  assert.deepEqual(
    durabilityConstraints.map(({ conname }) => conname).sort(),
    [
      "CHK_zone_publication_aggregate_payload",
      "FK_zone_publication_aggregate_publication",
    ],
    "The publication aggregate durability constraints are missing",
  );
  if (upgrade) {
    const [historicCursors] = await dataSource.query(`
      SELECT
        "computeMapDate"::text AS "computeMapDate",
        "computeStatsDate"::text AS "computeStatsDate",
        "computeMapGeneration"::text AS "computeMapGeneration",
        "computeStatsGeneration"::text AS "computeStatsGeneration",
        "computeMapUpdatedAt" AS "computeMapUpdatedAt",
        "computeStatsUpdatedAt" AS "computeStatsUpdatedAt"
      FROM "config"
      WHERE "id" = 1
    `);
    assert.deepEqual(
      historicCursors,
      {
        computeMapDate: "2026-07-30",
        computeStatsDate: "2026-07-29",
        computeMapGeneration: "0",
        computeStatsGeneration: "0",
        computeMapUpdatedAt: null,
        computeStatsUpdatedAt: null,
      },
      "The upgrade did not preserve historic cursors with fresh generations",
    );
    const legacyRows = await dataSource.query(`
      SELECT statistic.restrictions
      FROM statistic_commune statistic
      JOIN commune ON commune.id = statistic."communeId"
      WHERE commune.code LIKE 'UPG%'
      ORDER BY commune.code
    `);
    assert.deepEqual(
      legacyRows.map(({ restrictions }) => restrictions),
      upgrade.legacyRestrictions,
      "The upgrade rewrote legacy commune statistics",
    );
    const snapshotRows = await dataSource.query(`
      SELECT "snapshotDate"::text AS "snapshotDate", "scope", "status",
             "expectedCommuneCount", "processedCommuneCount"
      FROM statistic_commune_snapshot
      ORDER BY "snapshotDate", "scope"
    `);
    assert.deepEqual(
      snapshotRows,
      [
        {
          snapshotDate: "1970-01-01",
          scope: "bootstrap",
          status: "failed",
          expectedCommuneCount: 0,
          processedCommuneCount: 0,
        },
      ],
      "The upgrade did not activate the commune export barrier fail-closed",
    );
  }
  await verifyStatisticCachePublication();
  await verifySandreReferenceGuards();

  console.log(
    JSON.stringify({
      status: "ok",
      mode,
      database: databaseName,
      baseSha: upgrade?.baseSha,
      simulatedPauseColumnDrift: upgrade?.simulatedPauseColumnDrift,
      appliedMigrations: applied.map(({ name }) => name),
    }),
  );
} finally {
  await dataSource.destroy();
}
