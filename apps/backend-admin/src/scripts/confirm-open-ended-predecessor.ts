import 'reflect-metadata';
import 'dotenv/config';
import { DataSource, QueryRunner } from 'typeorm';
import { shiftCivilDate } from '../core/scheduling/daily-job-schedule';
import { normalizeCivilDate } from '../shared/arrete-date-continuity';

export interface ConfirmPredecessorOptions {
  apply: boolean;
  successorId: number;
  expectedStart: string;
  expectedPredecessorEnd: string;
}

interface ChainRow {
  successorId: number;
  successorStart: string;
  successorStatus: string;
  successorDepartmentId: number;
  predecessorId: number;
  predecessorEnd: string;
  predecessorStatus: string;
  predecessorDepartmentId: number;
  dateFinSaisie: string | null;
  dateFinCalculee: boolean;
  dateFinSaisieConnue: boolean;
}

export function parseConfirmPredecessorOptions(
  args: string[],
): ConfirmPredecessorOptions {
  const valueArguments = new Set([
    '--successor-id',
    '--expected-start',
    '--expected-predecessor-end',
  ]);
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--apply') {
      if (apply) {
        throw new Error('Duplicate argument: --apply');
      }
      apply = true;
      continue;
    }
    if (!valueArguments.has(arg)) {
      throw new Error(`Invalid argument: ${arg}`);
    }
    if (values.has(arg)) {
      throw new Error(`Duplicate argument: ${arg}`);
    }
    if (!args[index + 1] || args[index + 1].startsWith('--')) {
      throw new Error(`Missing value for argument: ${arg}`);
    }
    values.set(arg, args[index + 1]);
    index += 1;
  }

  const successorId = Number(values.get('--successor-id'));
  if (!Number.isSafeInteger(successorId) || successorId <= 0) {
    throw new Error('--successor-id must be a positive integer');
  }
  const expectedStart = normalizeCivilDate(
    values.get('--expected-start') ?? '',
  );
  const expectedPredecessorEnd = normalizeCivilDate(
    values.get('--expected-predecessor-end') ?? '',
  );
  if (shiftCivilDate(expectedStart, -1) !== expectedPredecessorEnd) {
    throw new Error(
      '--expected-predecessor-end must be the day before --expected-start',
    );
  }
  return { apply, successorId, expectedStart, expectedPredecessorEnd };
}

export async function confirmOpenEndedPredecessor(
  queryRunner: QueryRunner,
  options: ConfirmPredecessorOptions,
): Promise<Record<string, unknown>> {
  await queryRunner.startTransaction('SERIALIZABLE');
  try {
    await queryRunner.query(
      `SELECT pg_advisory_xact_lock(hashtext('vigieau:arrete-continuity'))`,
    );
    const rows = (await queryRunner.query(
      `
        SELECT
          successor.id AS "successorId",
          successor."dateDebut"::text AS "successorStart",
          successor.statut::text AS "successorStatus",
          successor."departementId" AS "successorDepartmentId",
          predecessor.id AS "predecessorId",
          predecessor."dateFin"::text AS "predecessorEnd",
          predecessor.statut::text AS "predecessorStatus",
          predecessor."departementId" AS "predecessorDepartmentId",
          predecessor."dateFinSaisie"::text AS "dateFinSaisie",
          predecessor."dateFinCalculee" AS "dateFinCalculee",
          predecessor."dateFinSaisieConnue" AS "dateFinSaisieConnue"
        FROM arrete_restriction successor
        JOIN arrete_restriction predecessor
          ON predecessor.id = successor."arreteRestrictionAbrogeId"
        WHERE successor.id = $1
        FOR UPDATE OF predecessor, successor
      `,
      [options.successorId],
    )) as ChainRow[];
    if (rows.length !== 1) {
      throw new Error('Expected exactly one successor/predecessor chain');
    }
    const row = rows[0];
    const [successorCount] = await queryRunner.query(
      `
        SELECT count(*)::integer AS count
        FROM arrete_restriction
        WHERE "arreteRestrictionAbrogeId" = $1
          AND statut <> 'a_valider'
      `,
      [row.predecessorId],
    );
    if (successorCount?.count !== 1) {
      throw new Error('The predecessor does not have exactly one active chain');
    }
    if (
      normalizeCivilDate(row.successorStart) !== options.expectedStart ||
      normalizeCivilDate(row.predecessorEnd) !==
        options.expectedPredecessorEnd ||
      row.successorDepartmentId !== row.predecessorDepartmentId ||
      row.successorStatus === 'a_valider' ||
      row.predecessorStatus === 'a_valider'
    ) {
      throw new Error('The chain no longer matches the approved facts');
    }

    const alreadyApplied =
      row.dateFinSaisie === null &&
      row.dateFinCalculee === true &&
      row.dateFinSaisieConnue === true;
    const isExactMigrationState =
      row.dateFinSaisie !== null &&
      normalizeCivilDate(row.dateFinSaisie) ===
        options.expectedPredecessorEnd &&
      row.dateFinCalculee === true &&
      row.dateFinSaisieConnue === false;
    if (!alreadyApplied && !isExactMigrationState) {
      throw new Error(
        'The predecessor provenance no longer matches the migration state',
      );
    }
    if (options.apply && !alreadyApplied) {
      const updated = await queryRunner.query(
        `
          UPDATE arrete_restriction
          SET
            "dateFinSaisie" = NULL,
            "dateFinCalculee" = true,
            "dateFinSaisieConnue" = true
          WHERE id = $1
            AND "dateFin" = $2::date
            AND "dateFinSaisie" = $2::date
            AND "dateFinCalculee" IS TRUE
            AND "dateFinSaisieConnue" IS FALSE
          RETURNING id
        `,
        [row.predecessorId, options.expectedPredecessorEnd],
      );
      if (updated.length !== 1) {
        throw new Error('The guarded provenance update did not affect one row');
      }
    }

    const result = {
      status: alreadyApplied
        ? 'ALREADY_APPLIED'
        : options.apply
          ? 'APPLIED'
          : 'DRY_RUN',
      successorId: row.successorId,
      predecessorId: row.predecessorId,
      departmentId: row.predecessorDepartmentId,
      successorStart: options.expectedStart,
      predecessorEnd: options.expectedPredecessorEnd,
    };
    if (options.apply) {
      await queryRunner.commitTransaction();
    } else {
      await queryRunner.rollbackTransaction();
    }
    return result;
  } catch (error) {
    if (queryRunner.isTransactionActive) {
      await queryRunner.rollbackTransaction();
    }
    throw error;
  }
}

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing environment variable ${name}`);
  }
  return value;
}

function createDataSource(): DataSource {
  const sslEnabled = process.env.NODE_ENV !== 'local';
  return new DataSource({
    type: 'postgres',
    url: `postgres://${requiredEnvironmentVariable('DATABASE_USER')}:${requiredEnvironmentVariable('DATABASE_PASSWORD')}@${requiredEnvironmentVariable('DATABASE_HOST')}:${requiredEnvironmentVariable('DATABASE_PORT')}/${requiredEnvironmentVariable('DATABASE_NAME')}`,
    ssl: sslEnabled,
    extra: sslEnabled ? { ssl: { rejectUnauthorized: false } } : {},
  });
}

async function main(): Promise<void> {
  const options = parseConfirmPredecessorOptions(process.argv.slice(2));
  const dataSource = createDataSource();
  await dataSource.initialize();
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  try {
    const result = await confirmOpenEndedPredecessor(queryRunner, options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[confirm-open-ended-predecessor] failed');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
