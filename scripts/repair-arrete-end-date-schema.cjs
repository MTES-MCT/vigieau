const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const appRequire = createRequire(`${process.cwd()}/package.json`);
const { Client } = appRequire('pg');

const expectedFingerprint = process.argv[2];
const fingerprint = createHash('sha256').update([
  process.env.DATABASE_HOST, process.env.DATABASE_PORT, process.env.DATABASE_NAME,
].join(':')).digest('hex').slice(0, 16);

if (process.env.APP !== 'regleau-back-preprod' || process.env.SENTRY_ENV !== 'preprod' ||
    !expectedFingerprint || expectedFingerprint !== fingerprint) {
  throw new Error('Refusing schema repair outside the explicitly inspected preproduction database');
}

const { ArreteEndDateProvenance1786305600000 } = appRequire(
  './dist/apps/backend-admin/src/migrations/1786305600000-ArreteEndDateProvenance.js',
);
const client = new Client({
  host: process.env.DATABASE_HOST, port: Number(process.env.DATABASE_PORT || 5432),
  user: process.env.DATABASE_USER, password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME,
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000,
  application_name: 'sentry-preprod-end-date-schema-repair',
});

(async () => {
  await client.connect();
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '1s'");
  await client.query("SET LOCAL statement_timeout = '30s'");
  const recorded = await client.query('SELECT 1 FROM migrations WHERE name = $1', ['ArreteEndDateProvenance1786305600000']);
  if (recorded.rowCount !== 1) throw new Error('Expected already-recorded migration; use the normal migration workflow');
  await new ArreteEndDateProvenance1786305600000().up({ query: (sql) => client.query(sql) });
  const columns = await client.query(`SELECT table_name, column_name, data_type, is_nullable
    FROM information_schema.columns WHERE table_schema='public'
    AND table_name IN ('arrete_cadre','arrete_restriction')
    AND column_name IN ('dateFinSaisie','dateFinCalculee','dateFinSaisieConnue')
    ORDER BY table_name,column_name`);
  if (columns.rowCount !== 6) throw new Error('Expected six end-date columns after reconciliation');
  const indexes = await client.query(`SELECT indexname FROM pg_indexes WHERE schemaname='public'
    AND indexname IN ('IDX_arrete_restriction_replaced_order','IDX_arrete_cadre_replaced_order')`);
  if (indexes.rowCount !== 2) throw new Error('Expected both replacement indexes');
  await client.query('COMMIT');
  console.log(JSON.stringify({status: 'reconciled', fingerprint, columns: columns.rows, indexes: indexes.rows}));
})().catch(async (error) => {
  await client.query('ROLLBACK').catch(() => undefined);
  console.error(JSON.stringify({status: 'rolled_back', code: error.code || error.name, message: error.message}));
  process.exitCode = 1;
}).finally(() => client.end());
