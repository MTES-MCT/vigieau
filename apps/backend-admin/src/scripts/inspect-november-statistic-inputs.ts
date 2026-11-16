import 'dotenv/config';
import { Client } from 'pg';
import {
  NOVEMBER_RECOVERY_DATES,
  readRecoveryInputEvidence,
} from './import-november-statistics';

/** Read-only source proof; run on each isolated dated clone before export. */
export async function main(): Promise<void> {
  const connectionString = process.env.NOVEMBER_RECOVERY_DATABASE_URL;
  const expectedDatabase = process.env.NOVEMBER_RECOVERY_EXPECTED_DATABASE;
  const date = process.env.NOVEMBER_RECOVERY_DATE;
  if (
    !connectionString ||
    !expectedDatabase ||
    !date ||
    !NOVEMBER_RECOVERY_DATES.includes(
      date as (typeof NOVEMBER_RECOVERY_DATES)[number],
    )
  )
    throw new Error(
      'Set the recovery connection, expected database and approved date',
    );
  const client = new Client({
    connectionString,
    application_name: 'vigieau-november-input-evidence',
  });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(
      "SET LOCAL statement_timeout='120s'; SET LOCAL lock_timeout='1s'; SET LOCAL transaction_timeout='300s'",
    );
    const context = (
      await client.query(
        `SELECT current_database() AS database, source."publicRevision"::text AS "sourceRevision", config."historicComputeEpoch"::text AS "historicComputeEpoch" FROM zone_publication_source_state source CROSS JOIN config WHERE source.id=1 AND config.id=1`,
      )
    ).rows[0];
    if (context?.database !== expectedDatabase)
      throw new Error('Unexpected source database');
    const startedAt = Date.now();
    const evidence = await readRecoveryInputEvidence(client, date);
    await client.query('ROLLBACK');
    process.stdout.write(
      `${JSON.stringify({ date, ...context, evidence, elapsedMs: Date.now() - startedAt })}\n`,
    );
  } finally {
    await client.end();
  }
}
if (require.main === module) {
  void main().catch((error) => {
    console.error(
      `[november-input-evidence] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
