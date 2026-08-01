import { SandreDisabledZoneReferenceGuard1785859200000 } from '../migrations/1785859200000-SandreDisabledZoneReferenceGuard';
import { SandreOperationalReferenceRepair1786118400000 } from '../migrations/1786118400000-SandreOperationalReferenceRepair';
import { SandreOperationalStatusGuards1786122000000 } from '../migrations/1786122000000-SandreOperationalStatusGuards';
import { SandreCustomizationUniqueness1786125600000 } from '../migrations/1786125600000-SandreCustomizationUniqueness';
import { DataSource, QueryRunner } from 'typeorm';

const postgresUrl = process.env.SANDRE_GUARD_POSTGRES_URL;
const describeWithPostgres = postgresUrl ? describe : describe.skip;

const waitForLock = async (query: Promise<unknown>): Promise<void> => {
  const result = await Promise.race([
    query.then(
      () => 'settled',
      () => 'settled',
    ),
    new Promise<'blocked'>((resolve) =>
      setTimeout(() => resolve('blocked'), 150),
    ),
  ]);

  expect(result).toBe('blocked');
};

describe('SandreDisabledZoneReferenceGuard1785859200000', () => {
  it('remaps every operational reference through an active scoped alias', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => statements.push(sql)),
    };

    await new SandreDisabledZoneReferenceGuard1785859200000().up(
      queryRunner as any,
    );

    const sql = statements.join('\n');
    expect(sql).toContain('resolve_active_sandre_zone_alias');
    expect(sql).toContain('alias."aliasType" = \'cd_zas\'');
    expect(sql).toContain('target.disabled = false');
    expect(sql).toContain('target."departementId" = source."departementId"');
    expect(sql).toContain('target.type = source.type');
    expect(sql).toContain('FOR SHARE OF source, alias, target');
    expect(sql).toContain('NEW."zoneAlerteId" := target_zone_id');
    expect(sql).toContain("TG_OP = 'UPDATE'");
    expect(sql).toContain(
      'NEW."zoneAlerteId" IS NOT DISTINCT FROM OLD."zoneAlerteId"',
    );
    expect(sql).toContain("parent.statut <> 'abroge'");
    expect(sql).toContain('FOR SHARE OF parent');

    for (const table of [
      'restriction',
      'arrete_cadre_zone_alerte',
      'arrete_cadre_zone_alerte_communes',
    ]) {
      expect(sql).toContain(`TRG_${table}_active_sandre_zone`);
      expect(sql).toContain(
        `BEFORE INSERT OR UPDATE OF "zoneAlerteId" ON "${table}"`,
      );
    }
  });

  it('remaps or blocks disabled-zone links when an abrogated parent is reactivated', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => statements.push(sql)),
    };

    await new SandreDisabledZoneReferenceGuard1785859200000().up(
      queryRunner as any,
    );

    const sql = statements.join('\n');
    expect(sql).toContain('remap_sandre_references_before_parent_reactivation');
    expect(sql).toContain(
      "OLD.statut IS DISTINCT FROM 'abroge' OR NEW.statut = 'abroge'",
    );
    expect(sql).toContain(
      'TRG_arrete_restriction_remap_sandre_before_reactivation',
    );
    expect(sql).toContain('TRG_arrete_cadre_remap_sandre_before_reactivation');
    expect(sql).toContain('AFTER UPDATE OF statut ON "arrete_restriction"');
    expect(sql).toContain('AFTER UPDATE OF statut ON "arrete_cadre"');
    expect(sql).toContain('collision de restrictions SANDRE');
    expect(sql).toContain('collision de personnalisations SANDRE');
    expect(sql).toContain(
      'plusieurs zones SANDRE convergent vers la même cible',
    );
    expect(sql).toContain(
      'plusieurs personnalisations SANDRE convergent vers la même cible',
    );
  });

  it('blocks unresolved and colliding references before disabling a zone', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => statements.push(sql)),
    };

    await new SandreDisabledZoneReferenceGuard1785859200000().up(
      queryRunner as any,
    );

    const sql = statements.join('\n');
    expect(sql).toContain('TRG_zone_alerte_remap_references_before_disable');
    expect(sql).toContain("ERRCODE = '23514'");
    expect(sql).toContain('collision de restrictions');
    expect(sql).toContain('collision de personnalisations');
    expect(sql).toContain('ON CONFLICT DO NOTHING');
    expect(sql).toContain('UPDATE restriction');
    expect(sql).toContain('UPDATE arrete_cadre_zone_alerte_communes');
    expect(sql).toContain('USING arrete_cadre parent');
    expect(sql).toContain('FROM arrete_restriction parent');
    expect(sql).toContain('current_reference_id');
    expect(sql).toContain(
      "une autre zone SANDRE de l''arrêté %s converge déjà vers la zone %s",
    );
    expect(sql).toContain(
      "une autre zone SANDRE de l''arrêté cadre %s converge déjà vers la zone %s",
    );
  });

  it('removes triggers before their functions on rollback', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => statements.push(sql)),
    };

    await new SandreDisabledZoneReferenceGuard1785859200000().down(
      queryRunner as any,
    );

    const sql = statements.join('\n');
    expect(sql.indexOf('DROP TRIGGER')).toBeLessThan(
      sql.indexOf(
        'DROP FUNCTION IF EXISTS remap_references_before_sandre_zone_disable()',
      ),
    );
    expect(sql).toContain(
      'DROP FUNCTION IF EXISTS resolve_active_sandre_zone_alias(integer)',
    );
    expect(sql).toContain(
      'DROP FUNCTION IF EXISTS remap_sandre_references_before_parent_reactivation()',
    );
  });
});

describe('SandreOperationalReferenceRepair1786118400000', () => {
  it('repairs only operational references and rejects unsafe targets', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => statements.push(sql)),
    };

    await new SandreOperationalReferenceRepair1786118400000().up(
      queryRunner as any,
    );

    const sql = statements.join('\n');
    expect(sql).toContain('remap_operational_sandre_zone_references');
    expect(sql).toContain('resolve_active_sandre_zone_alias(source_zone_id)');
    expect(sql).toContain('target_zone_id <> expected_target_zone_id');
    expect(sql.match(/FOR SHARE OF parent/g)).toHaveLength(2);
    expect(
      sql.match(/parent\.statut IN \('a_venir', 'publie'\)/g),
    ).toHaveLength(11);
    expect(sql).toContain('collision de restrictions');
    expect(sql).toContain('collision de personnalisations');
    expect(sql).toContain('ON CONFLICT DO NOTHING');
    expect(sql).toContain('UPDATE sandre_zone_alias alias');
    expect(sql).toContain('remaining_reference');
  });

  it('drops only the repair function on rollback', async () => {
    const queryRunner = { query: jest.fn().mockResolvedValue(undefined) };

    await new SandreOperationalReferenceRepair1786118400000().down(
      queryRunner as any,
    );

    expect(queryRunner.query).toHaveBeenCalledWith(
      'DROP FUNCTION IF EXISTS remap_operational_sandre_zone_references(integer, integer)',
    );
  });
});

describe('SandreOperationalStatusGuards1786122000000', () => {
  it('upgrades and can restore the parent status policy', async () => {
    const currentStatements: string[] = [];
    const currentRunner = {
      query: jest.fn(async (sql: string) => currentStatements.push(sql)),
    };
    await new SandreOperationalStatusGuards1786122000000().up(
      currentRunner as any,
    );
    expect(currentStatements.join('\n')).toContain(
      "parent.statut IN ('a_venir', 'publie')",
    );

    const legacyStatements: string[] = [];
    const legacyRunner = {
      query: jest.fn(async (sql: string) => {
        legacyStatements.push(sql);
        return sql.includes('AS "hasUnsafeDraftReferences"')
          ? [{ hasUnsafeDraftReferences: false }]
          : [];
      }),
    };
    await new SandreOperationalStatusGuards1786122000000().down(
      legacyRunner as any,
    );
    expect(legacyStatements.join('\n')).toContain("parent.statut <> 'abroge'");
  });

  it('refuses to restore legacy guards with draft disabled-zone references', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
        return [{ hasUnsafeDraftReferences: true }];
      }),
    };

    await expect(
      new SandreOperationalStatusGuards1786122000000().down(queryRunner as any),
    ).rejects.toThrow('draft references target disabled zones');

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('FROM restriction reference');
    expect(statements[0]).toContain('FROM arrete_cadre_zone_alerte reference');
    expect(statements[0]).toContain(
      'FROM arrete_cadre_zone_alerte_communes reference',
    );
    expect(statements[0]).toContain("parent.statut <> 'abroge'");
    expect(statements[0]).toContain(
      "parent.statut NOT IN ('a_venir', 'publie')",
    );
    expect(statements.join('\n')).not.toContain(
      'CREATE OR REPLACE FUNCTION resolve_active_sandre_zone_alias',
    );
  });
});

describe('SandreCustomizationUniqueness1786125600000', () => {
  it('adds the named unique constraint after checking existing data', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('AS "hasDuplicates"')) {
          return [{ hasDuplicates: false }];
        }
        if (sql.includes('AS "constraintExists"')) {
          return [{ constraintExists: false, constraintMatches: false }];
        }
        return [];
      }),
    };

    await new SandreCustomizationUniqueness1786125600000().up(
      queryRunner as any,
    );

    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain('GROUP BY "arreteCadreId", "zoneAlerteId"');
    expect(statements[1]).toContain("constraint_definition.contype = 'u'");
    expect(statements[2]).toContain(
      'ADD CONSTRAINT "UQ_ac_za_communes_arrete_cadre_zone"',
    );
    expect(statements[2]).toContain('UNIQUE ("arreteCadreId", "zoneAlerteId")');
  });

  it('refuses to add the constraint while duplicates exist', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
        return [{ hasDuplicates: true }];
      }),
    };

    await expect(
      new SandreCustomizationUniqueness1786125600000().up(queryRunner as any),
    ).rejects.toThrow('duplicate (arreteCadreId, zoneAlerteId) rows exist');

    expect(statements).toHaveLength(1);
    expect(statements[0]).not.toContain('ALTER TABLE');
  });

  it('accepts an existing compatible constraint created by synchronization', async () => {
    const queryRunner = {
      query: jest
        .fn()
        .mockResolvedValueOnce([{ hasDuplicates: false }])
        .mockResolvedValueOnce([
          { constraintExists: true, constraintMatches: true },
        ]),
    };

    await new SandreCustomizationUniqueness1786125600000().up(
      queryRunner as any,
    );

    expect(queryRunner.query).toHaveBeenCalledTimes(2);
  });

  it('drops the named constraint on rollback', async () => {
    const queryRunner = { query: jest.fn().mockResolvedValue(undefined) };

    await new SandreCustomizationUniqueness1786125600000().down(
      queryRunner as any,
    );

    expect(queryRunner.query).toHaveBeenCalledWith(
      expect.stringContaining(
        'DROP CONSTRAINT IF EXISTS "UQ_ac_za_communes_arrete_cadre_zone"',
      ),
    );
  });
});

describeWithPostgres(
  'SandreDisabledZoneReferenceGuard1785859200000 PostgreSQL concurrency',
  () => {
    let dataSource: DataSource;
    let setupRunner: QueryRunner;
    let insertRunner: QueryRunner;
    let reactivationRunner: QueryRunner;
    const schema = `sandre_guard_${process.pid}_${Date.now()}`;

    const setSearchPath = async (queryRunner: QueryRunner): Promise<void> => {
      await queryRunner.query(`SET search_path TO "${schema}", public`);
    };

    const rollbackIfNeeded = async (
      queryRunner?: QueryRunner,
    ): Promise<void> => {
      if (queryRunner?.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
    };

    beforeAll(async () => {
      dataSource = await new DataSource({
        type: 'postgres',
        url: postgresUrl,
        entities: [],
        synchronize: false,
        logging: false,
      }).initialize();

      setupRunner = dataSource.createQueryRunner();
      insertRunner = dataSource.createQueryRunner();
      reactivationRunner = dataSource.createQueryRunner();
      await Promise.all([
        setupRunner.connect(),
        insertRunner.connect(),
        reactivationRunner.connect(),
      ]);

      await setupRunner.query(`CREATE SCHEMA "${schema}"`);
      await Promise.all([
        setSearchPath(setupRunner),
        setSearchPath(insertRunner),
        setSearchPath(reactivationRunner),
      ]);
      await setupRunner.query(`
        CREATE TABLE departement (
          id integer PRIMARY KEY
        );
        CREATE TABLE zone_alerte (
          id integer PRIMARY KEY,
          disabled boolean NOT NULL,
          "departementId" integer NOT NULL REFERENCES departement(id),
          type character varying(3) NOT NULL,
          "codeSandre" character varying(64)
        );
        CREATE TABLE sandre_zone_alias (
          id serial PRIMARY KEY,
          "departementId" integer NOT NULL REFERENCES departement(id),
          "zoneType" character varying(3) NOT NULL,
          "aliasType" character varying(30) NOT NULL,
          "aliasValue" character varying(64) NOT NULL,
          "zoneAlerteId" integer NOT NULL REFERENCES zone_alerte(id)
        );
        CREATE TABLE arrete_restriction (
          id integer PRIMARY KEY,
          statut character varying(30) NOT NULL
        );
        CREATE TABLE restriction (
          id serial PRIMARY KEY,
          "arreteRestrictionId" integer NOT NULL
            REFERENCES arrete_restriction(id),
          "zoneAlerteId" integer NOT NULL REFERENCES zone_alerte(id)
        );
        CREATE TABLE arrete_cadre (
          id integer PRIMARY KEY,
          statut character varying(30) NOT NULL
        );
        CREATE TABLE arrete_cadre_zone_alerte (
          "arreteCadreId" integer NOT NULL REFERENCES arrete_cadre(id),
          "zoneAlerteId" integer NOT NULL REFERENCES zone_alerte(id),
          PRIMARY KEY ("arreteCadreId", "zoneAlerteId")
        );
        CREATE TABLE arrete_cadre_zone_alerte_communes (
          id serial PRIMARY KEY,
          "arreteCadreId" integer NOT NULL REFERENCES arrete_cadre(id),
          "zoneAlerteId" integer NOT NULL REFERENCES zone_alerte(id)
        );
      `);

      await new SandreDisabledZoneReferenceGuard1785859200000().up(setupRunner);
      await new SandreOperationalReferenceRepair1786118400000().up(setupRunner);
      await new SandreOperationalStatusGuards1786122000000().up(setupRunner);
      await new SandreCustomizationUniqueness1786125600000().up(setupRunner);
      await setupRunner.query(`
        INSERT INTO departement (id) VALUES (65);
        INSERT INTO zone_alerte (
          id,
          disabled,
          "departementId",
          type,
          "codeSandre"
        ) VALUES
          (100, true, 65, 'SOU', 'SANDRE-65'),
          (101, false, 65, 'SOU', 'SANDRE-65-ACTIVE'),
          (102, true, 65, 'SOU', 'SANDRE-65-SECOND');
        INSERT INTO sandre_zone_alias (
          "departementId",
          "zoneType",
          "aliasType",
          "aliasValue",
          "zoneAlerteId"
        ) VALUES
          (65, 'SOU', 'cd_zas', 'SANDRE-65', 101),
          (65, 'SOU', 'cd_zas', 'SANDRE-65-SECOND', 101);
        INSERT INTO arrete_restriction (id, statut)
          VALUES (200, 'abroge');
        INSERT INTO arrete_cadre (id, statut)
          VALUES (300, 'abroge');
      `);
    }, 30_000);

    beforeEach(async () => {
      await Promise.all([
        rollbackIfNeeded(insertRunner),
        rollbackIfNeeded(reactivationRunner),
      ]);
      await setupRunner.query('DELETE FROM restriction');
      await setupRunner.query('DELETE FROM arrete_cadre_zone_alerte_communes');
      await setupRunner.query('DELETE FROM arrete_cadre_zone_alerte');
      await setupRunner.query(
        `UPDATE arrete_restriction SET statut = 'abroge' WHERE id = 200`,
      );
      await setupRunner.query(
        `UPDATE arrete_cadre SET statut = 'abroge' WHERE id = 300`,
      );
    });

    afterEach(async () => {
      await Promise.all([
        rollbackIfNeeded(insertRunner),
        rollbackIfNeeded(reactivationRunner),
      ]);
    });

    afterAll(async () => {
      if (setupRunner) {
        await setupRunner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
      await Promise.all(
        [setupRunner, insertRunner, reactivationRunner]
          .filter(Boolean)
          .map((queryRunner) => queryRunner.release()),
      );
      if (dataSource?.isInitialized) {
        await dataSource.destroy();
      }
    });

    it('remaps an insert committed before the concurrent reactivation', async () => {
      await insertRunner.startTransaction();
      await insertRunner.query(`
        INSERT INTO restriction ("arreteRestrictionId", "zoneAlerteId")
        VALUES (200, 100)
      `);

      await reactivationRunner.startTransaction();
      const reactivation = reactivationRunner.query(`
        UPDATE arrete_restriction
        SET statut = 'publie'
        WHERE id = 200
      `);
      await waitForLock(reactivation);

      await insertRunner.commitTransaction();
      await reactivation;
      await reactivationRunner.commitTransaction();

      const [reference] = await setupRunner.query(`
        SELECT parent.statut, reference."zoneAlerteId"
        FROM restriction reference
        JOIN arrete_restriction parent
          ON parent.id = reference."arreteRestrictionId"
        WHERE parent.id = 200
      `);
      expect(reference).toEqual({ statut: 'publie', zoneAlerteId: 101 });
    });

    it('remaps an insert started while the reactivation is uncommitted', async () => {
      await reactivationRunner.startTransaction();
      await reactivationRunner.query(`
        UPDATE arrete_restriction
        SET statut = 'publie'
        WHERE id = 200
      `);

      await insertRunner.startTransaction();
      const insert = insertRunner.query(`
        INSERT INTO restriction ("arreteRestrictionId", "zoneAlerteId")
        VALUES (200, 100)
      `);
      await waitForLock(insert);

      await reactivationRunner.commitTransaction();
      await insert;
      await insertRunner.commitTransaction();

      const [reference] = await setupRunner.query(`
        SELECT parent.statut, reference."zoneAlerteId"
        FROM restriction reference
        JOIN arrete_restriction parent
          ON parent.id = reference."arreteRestrictionId"
        WHERE parent.id = 200
      `);
      expect(reference).toEqual({ statut: 'publie', zoneAlerteId: 101 });
    });

    it('keeps a draft reference historical until its parent is published', async () => {
      await setupRunner.query(`
        UPDATE arrete_restriction SET statut = 'a_valider' WHERE id = 200;
        INSERT INTO restriction ("arreteRestrictionId", "zoneAlerteId")
        VALUES (200, 100)
      `);
      let [reference] = await setupRunner.query(`
        SELECT "zoneAlerteId" FROM restriction
        WHERE "arreteRestrictionId" = 200
      `);
      expect(reference.zoneAlerteId).toBe(100);

      await setupRunner.query(`
        UPDATE arrete_restriction SET statut = 'publie' WHERE id = 200
      `);
      [reference] = await setupRunner.query(`
        SELECT "zoneAlerteId" FROM restriction
        WHERE "arreteRestrictionId" = 200
      `);
      expect(reference.zoneAlerteId).toBe(101);
    });

    it('refuses a legacy downgrade that would strand draft references', async () => {
      await setupRunner.query(`
        UPDATE arrete_restriction SET statut = 'a_valider' WHERE id = 200;
        INSERT INTO restriction ("arreteRestrictionId", "zoneAlerteId")
        VALUES (200, 100)
      `);

      await expect(
        new SandreOperationalStatusGuards1786122000000().down(setupRunner),
      ).rejects.toThrow('draft references target disabled zones');

      await setupRunner.query(`
        UPDATE arrete_restriction SET statut = 'publie' WHERE id = 200
      `);
      const [reference] = await setupRunner.query(`
        SELECT "zoneAlerteId" FROM restriction
        WHERE "arreteRestrictionId" = 200
      `);
      expect(reference.zoneAlerteId).toBe(101);
    });

    it('blocks converging disabled zones when a restriction order is published', async () => {
      await setupRunner.query(`
        INSERT INTO restriction ("arreteRestrictionId", "zoneAlerteId")
        VALUES (200, 100), (200, 102)
      `);

      await expect(
        setupRunner.query(`
          UPDATE arrete_restriction SET statut = 'publie' WHERE id = 200
        `),
      ).rejects.toMatchObject({ code: '23514' });

      const [parent] = await setupRunner.query(
        `SELECT statut FROM arrete_restriction WHERE id = 200`,
      );
      const references = await setupRunner.query(`
        SELECT "zoneAlerteId"
        FROM restriction
        WHERE "arreteRestrictionId" = 200
        ORDER BY "zoneAlerteId"
      `);
      expect(parent.statut).toBe('abroge');
      expect(references).toEqual([
        { zoneAlerteId: 100 },
        { zoneAlerteId: 102 },
      ]);
    });

    it('blocks converging disabled zones when a framework order is published', async () => {
      await setupRunner.query(`
        INSERT INTO arrete_cadre_zone_alerte_communes (
          "arreteCadreId", "zoneAlerteId"
        ) VALUES (300, 100), (300, 102)
      `);

      await expect(
        setupRunner.query(`
          UPDATE arrete_cadre SET statut = 'publie' WHERE id = 300
        `),
      ).rejects.toMatchObject({ code: '23514' });

      const [parent] = await setupRunner.query(
        `SELECT statut FROM arrete_cadre WHERE id = 300`,
      );
      const references = await setupRunner.query(`
        SELECT "zoneAlerteId"
        FROM arrete_cadre_zone_alerte_communes
        WHERE "arreteCadreId" = 300
        ORDER BY "zoneAlerteId"
      `);
      expect(parent.statut).toBe('abroge');
      expect(references).toEqual([
        { zoneAlerteId: 100 },
        { zoneAlerteId: 102 },
      ]);
    });

    it('rejects converging restriction inserts on an active parent', async () => {
      await setupRunner.query(
        `UPDATE arrete_restriction SET statut = 'publie' WHERE id = 200`,
      );
      await setupRunner.query(`
        INSERT INTO restriction ("arreteRestrictionId", "zoneAlerteId")
        VALUES (200, 100)
      `);

      await expect(
        setupRunner.query(`
          INSERT INTO restriction ("arreteRestrictionId", "zoneAlerteId")
          VALUES (200, 102)
        `),
      ).rejects.toMatchObject({ code: '23514' });

      const references = await setupRunner.query(`
        SELECT "zoneAlerteId"
        FROM restriction
        WHERE "arreteRestrictionId" = 200
      `);
      expect(references).toEqual([{ zoneAlerteId: 101 }]);
    });

    it('rejects converging customization inserts on an active parent', async () => {
      await setupRunner.query(
        `UPDATE arrete_cadre SET statut = 'publie' WHERE id = 300`,
      );
      await setupRunner.query(`
        INSERT INTO arrete_cadre_zone_alerte_communes (
          "arreteCadreId", "zoneAlerteId"
        ) VALUES (300, 100)
      `);

      await expect(
        setupRunner.query(`
          INSERT INTO arrete_cadre_zone_alerte_communes (
            "arreteCadreId", "zoneAlerteId"
          ) VALUES (300, 102)
        `),
      ).rejects.toMatchObject({ code: '23514' });

      const references = await setupRunner.query(`
        SELECT "zoneAlerteId"
        FROM arrete_cadre_zone_alerte_communes
        WHERE "arreteCadreId" = 300
      `);
      expect(references).toEqual([{ zoneAlerteId: 101 }]);
    });

    it('rejects a concurrent customization collision at the unique constraint', async () => {
      await setupRunner.query(
        `UPDATE arrete_cadre SET statut = 'publie' WHERE id = 300`,
      );

      await insertRunner.startTransaction();
      await insertRunner.query(`
        INSERT INTO arrete_cadre_zone_alerte_communes (
          "arreteCadreId", "zoneAlerteId"
        ) VALUES (300, 100)
      `);

      await reactivationRunner.startTransaction();
      const collidingInsert = reactivationRunner.query(`
        INSERT INTO arrete_cadre_zone_alerte_communes (
          "arreteCadreId", "zoneAlerteId"
        ) VALUES (300, 102)
      `);
      await waitForLock(collidingInsert);

      await insertRunner.commitTransaction();
      await expect(collidingInsert).rejects.toMatchObject({ code: '23505' });
      await reactivationRunner.rollbackTransaction();

      const references = await setupRunner.query(`
        SELECT "zoneAlerteId"
        FROM arrete_cadre_zone_alerte_communes
        WHERE "arreteCadreId" = 300
      `);
      expect(references).toEqual([{ zoneAlerteId: 101 }]);
    });

    it('repairs an operational legacy reference on an already disabled zone', async () => {
      await setupRunner.query(`
        ALTER TABLE restriction
        DISABLE TRIGGER "TRG_restriction_active_sandre_zone";
        INSERT INTO restriction ("arreteRestrictionId", "zoneAlerteId")
        VALUES (200, 100);
        ALTER TABLE restriction
        ENABLE TRIGGER "TRG_restriction_active_sandre_zone";
        ALTER TABLE arrete_restriction
        DISABLE TRIGGER "TRG_arrete_restriction_remap_sandre_before_reactivation";
        UPDATE arrete_restriction SET statut = 'publie' WHERE id = 200;
        ALTER TABLE arrete_restriction
        ENABLE TRIGGER "TRG_arrete_restriction_remap_sandre_before_reactivation";
      `);

      const [result] = await setupRunner.query(
        'SELECT remap_operational_sandre_zone_references($1, $2) AS target',
        [100, 101],
      );
      const [reference] = await setupRunner.query(`
        SELECT "zoneAlerteId"
        FROM restriction
        WHERE "arreteRestrictionId" = 200
      `);

      expect(result.target).toBe(101);
      expect(reference.zoneAlerteId).toBe(101);
    });

    it('keeps draft references on their original zone', async () => {
      await setupRunner.query(
        `UPDATE arrete_restriction SET statut = 'a_valider' WHERE id = 200`,
      );
      await setupRunner.query(`
        ALTER TABLE restriction
        DISABLE TRIGGER "TRG_restriction_active_sandre_zone";
        INSERT INTO restriction ("arreteRestrictionId", "zoneAlerteId")
        VALUES (200, 100);
        ALTER TABLE restriction
        ENABLE TRIGGER "TRG_restriction_active_sandre_zone";
      `);

      await setupRunner.query(
        'SELECT remap_operational_sandre_zone_references($1, $2)',
        [100, 101],
      );
      const [reference] = await setupRunner.query(`
        SELECT "zoneAlerteId"
        FROM restriction
        WHERE "arreteRestrictionId" = 200
      `);

      expect(reference.zoneAlerteId).toBe(100);
    });

    it('does not move a reference concurrently made historical', async () => {
      await setupRunner.query(`
        ALTER TABLE restriction
        DISABLE TRIGGER "TRG_restriction_active_sandre_zone";
        INSERT INTO restriction ("arreteRestrictionId", "zoneAlerteId")
        VALUES (200, 100);
        ALTER TABLE restriction
        ENABLE TRIGGER "TRG_restriction_active_sandre_zone";
        ALTER TABLE arrete_restriction
        DISABLE TRIGGER "TRG_arrete_restriction_remap_sandre_before_reactivation";
        UPDATE arrete_restriction SET statut = 'publie' WHERE id = 200;
        ALTER TABLE arrete_restriction
        ENABLE TRIGGER "TRG_arrete_restriction_remap_sandre_before_reactivation";
      `);

      await reactivationRunner.startTransaction();
      await reactivationRunner.query(`
        UPDATE arrete_restriction SET statut = 'abroge' WHERE id = 200
      `);

      await insertRunner.startTransaction();
      const repair = insertRunner.query(
        'SELECT remap_operational_sandre_zone_references($1, $2)',
        [100, 101],
      );
      await waitForLock(repair);

      await reactivationRunner.commitTransaction();
      await repair;
      await insertRunner.commitTransaction();

      const [reference] = await setupRunner.query(`
        SELECT parent.statut, reference."zoneAlerteId"
        FROM restriction reference
        JOIN arrete_restriction parent
          ON parent.id = reference."arreteRestrictionId"
        WHERE parent.id = 200
      `);
      expect(reference).toEqual({ statut: 'abroge', zoneAlerteId: 100 });
    });

    it('rolls back the repair when source and target restrictions collide', async () => {
      await setupRunner.query(`
        ALTER TABLE restriction
        DISABLE TRIGGER "TRG_restriction_active_sandre_zone";
        INSERT INTO restriction ("arreteRestrictionId", "zoneAlerteId")
        VALUES (200, 100), (200, 101);
        ALTER TABLE restriction
        ENABLE TRIGGER "TRG_restriction_active_sandre_zone";
        ALTER TABLE arrete_restriction
        DISABLE TRIGGER "TRG_arrete_restriction_remap_sandre_before_reactivation";
        UPDATE arrete_restriction SET statut = 'publie' WHERE id = 200;
        ALTER TABLE arrete_restriction
        ENABLE TRIGGER "TRG_arrete_restriction_remap_sandre_before_reactivation";
      `);

      await expect(
        setupRunner.query(
          'SELECT remap_operational_sandre_zone_references($1, $2)',
          [100, 101],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      const references = await setupRunner.query(`
        SELECT "zoneAlerteId"
        FROM restriction
        WHERE "arreteRestrictionId" = 200
        ORDER BY "zoneAlerteId"
      `);

      expect(references).toEqual([
        { zoneAlerteId: 100 },
        { zoneAlerteId: 101 },
      ]);
    });
  },
);
