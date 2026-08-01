import { SandreDisabledZoneReferenceGuard1785859200000 } from '../migrations/1785859200000-SandreDisabledZoneReferenceGuard';
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
          "zoneAlerteId" integer NOT NULL REFERENCES zone_alerte(id),
          UNIQUE ("arreteRestrictionId", "zoneAlerteId")
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
          "zoneAlerteId" integer NOT NULL REFERENCES zone_alerte(id),
          UNIQUE ("arreteCadreId", "zoneAlerteId")
        );
      `);

      await new SandreDisabledZoneReferenceGuard1785859200000().up(setupRunner);
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
          (101, false, 65, 'SOU', 'SANDRE-65-ACTIVE');
        INSERT INTO sandre_zone_alias (
          "departementId",
          "zoneType",
          "aliasType",
          "aliasValue",
          "zoneAlerteId"
        ) VALUES (65, 'SOU', 'cd_zas', 'SANDRE-65', 101);
        INSERT INTO arrete_restriction (id, statut)
        VALUES (200, 'abroge');
      `);
    }, 30_000);

    beforeEach(async () => {
      await Promise.all([
        rollbackIfNeeded(insertRunner),
        rollbackIfNeeded(reactivationRunner),
      ]);
      await setupRunner.query('DELETE FROM restriction');
      await setupRunner.query(
        `UPDATE arrete_restriction SET statut = 'abroge' WHERE id = 200`,
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
  },
);
