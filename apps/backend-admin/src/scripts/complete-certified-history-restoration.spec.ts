import { DataSource, QueryRunner } from 'typeorm';
import {
  CERTIFIED_COMPLETION_APPLY_DEPARTMENT_BATCH_SQL,
  CERTIFIED_COMPLETION_INSPECT_DEPARTMENT_BATCH_SQL,
  CERTIFIED_COMPLETION_PROMOTION_PREFLIGHT_SQL,
  CERTIFIED_COMPLETION_PROMOTION_SQL,
  RepairPublicationContext,
  assertPromotionPreflight,
  assertRangeMatchesDirtyWindow,
  buildStatisticApplySql,
  buildStatisticInspectionSql,
  certifiedCompletionContextSql,
  encodeCertifiedCompletionContext,
  parseCertifiedHistoryCompletionOptions,
  validateCertifiedDepartmentDays,
  validateCertifiedStatisticDays,
  withShortRunnerTransaction,
  withTargetSnapshotLock,
} from './complete-certified-history-restoration';

const requiredEnvironment = {
  CERTIFIED_HISTORY_COMPLETION_FROM: '2026-07-11',
  CERTIFIED_HISTORY_COMPLETION_THROUGH: '2026-08-27',
  CERTIFIED_HISTORY_COMPLETION_SOURCE_RUN_ID:
    'vigieau-2026-07-11-2026-08-27-backup-repair-v1',
  CERTIFIED_HISTORY_COMPLETION_EXPECTED_SOURCE_DATABASE: 'certified_source',
  CERTIFIED_HISTORY_COMPLETION_EXPECTED_TARGET_DATABASE: 'vigieau_prod',
};

const publication: RepairPublicationContext = {
  statisticRevision: '116',
  currentPublishedDate: '2026-08-29',
  historicPublishedThrough: '2026-08-27',
  historicDirtyFrom: '2026-07-11',
  historicDirtyThrough: '2026-08-27',
  sourceRevision: '168691',
  sourcePublicRevision: '168691',
  legacyDualWrite: false,
  historicComputeEpoch: '784',
  historicBackfillGlobalEpoch: '9',
  computeMapDate: '2026-07-11',
  computeStatsDate: '2026-07-11',
};

describe('certified history completion options', () => {
  it('defaults to a bounded read-only restore inspection', () => {
    expect(
      parseCertifiedHistoryCompletionOptions(requiredEnvironment),
    ).toMatchObject({
      mode: 'restore',
      apply: false,
      from: '2026-07-11',
      through: '2026-08-27',
      batchSize: 10,
      lockTimeoutMs: 250,
      statementTimeoutMs: 5_000,
      maxRetries: 5,
      expectedExecutionContext: null,
    });
  });

  it('requires distinct confirmations and the dry-run token for writes', () => {
    expect(() =>
      parseCertifiedHistoryCompletionOptions({
        ...requiredEnvironment,
        CERTIFIED_HISTORY_COMPLETION_APPLY: 'true',
      }),
    ).toThrow('RESTORE_CERTIFIED_DEPARTMENT_NATIONAL_HISTORY');
    expect(() =>
      parseCertifiedHistoryCompletionOptions({
        ...requiredEnvironment,
        CERTIFIED_HISTORY_COMPLETION_MODE: 'promote',
        CERTIFIED_HISTORY_COMPLETION_APPLY: 'true',
        CERTIFIED_HISTORY_COMPLETION_CONFIRMATION:
          'RESTORE_CERTIFIED_DEPARTMENT_NATIONAL_HISTORY',
      }),
    ).toThrow('PROMOTE_CERTIFIED_HISTORY');
  });

  it('cannot be repointed to another 48-day window', () => {
    expect(() =>
      parseCertifiedHistoryCompletionOptions({
        ...requiredEnvironment,
        CERTIFIED_HISTORY_COMPLETION_FROM: '2026-07-10',
        CERTIFIED_HISTORY_COMPLETION_THROUGH: '2026-08-26',
      }),
    ).toThrow('restricted to 2026-07-11..2026-08-27');
  });

  it('pins mode, source fingerprints and dirty context in the token', () => {
    const options = parseCertifiedHistoryCompletionOptions({
      ...requiredEnvironment,
      CERTIFIED_HISTORY_COMPLETION_MODE: 'promote',
    });
    const token = encodeCertifiedCompletionContext(options, publication, {
      sourceRunId: 'vigieau-2026-07-11-2026-08-27-backup-repair-v1',
      communeCount: 34_943,
      communeDayCount: 34_943 * 48,
      departmentCount: 101,
      departmentDayCount: 101 * 48,
      dayCount: 48,
      communeDigest: 'a'.repeat(64),
      communeHistoryDigest: 'b'.repeat(64),
      departmentDigest: 'c'.repeat(64),
      departmentHistoryDigest: 'd'.repeat(64),
      statisticDigest: 'e'.repeat(64),
      provenanceDigest: 'f'.repeat(64),
      sourceFingerprint: '1'.repeat(64),
    });
    expect(
      JSON.parse(Buffer.from(token, 'base64url').toString('utf8')),
    ).toMatchObject({
      mode: 'promote',
      publication: { historicDirtyFrom: '2026-07-11' },
      scope: {
        sourceFingerprint: '1'.repeat(64),
        provenanceDigest: 'f'.repeat(64),
      },
    });
  });
});

describe('certified completion short validation transactions', () => {
  it('keeps one snapshot lock while committing every validation batch separately', async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
      if (sql.includes('pg_advisory_unlock')) return [{ unlocked: true }];
      return [];
    });
    const runner = {
      connect: jest.fn(async () => undefined),
      release: jest.fn(async () => undefined),
      query,
      startTransaction: jest.fn(async () => undefined),
      commitTransaction: jest.fn(async () => undefined),
      rollbackTransaction: jest.fn(async () => undefined),
      isTransactionActive: false,
    } as unknown as QueryRunner;
    const target = {
      createQueryRunner: jest.fn(() => runner),
    } as unknown as DataSource;
    const options = parseCertifiedHistoryCompletionOptions(requiredEnvironment);

    await withTargetSnapshotLock(target, options, async (lockedRunner) => {
      await withShortRunnerTransaction(
        lockedRunner,
        options,
        async () => undefined,
      );
      await withShortRunnerTransaction(
        lockedRunner,
        options,
        async () => undefined,
      );
    });

    expect(target.createQueryRunner).toHaveBeenCalledTimes(1);
    expect(runner.startTransaction).toHaveBeenCalledTimes(2);
    expect(runner.commitTransaction).toHaveBeenCalledTimes(2);
    expect(
      query.mock.calls.filter(([sql]) =>
        String(sql).includes('pg_try_advisory_lock'),
      ),
    ).toHaveLength(1);
    expect(
      query.mock.calls.filter(([sql]) =>
        String(sql).includes('pg_advisory_unlock'),
      ),
    ).toHaveLength(1);
    expect(runner.release).toHaveBeenCalledTimes(1);
  });
});

describe('certified completion validation', () => {
  it('requires the exact dirty window and keeps current out of scope', () => {
    expect(() =>
      assertRangeMatchesDirtyWindow(
        { from: '2026-07-11', through: '2026-08-27' },
        publication,
      ),
    ).not.toThrow();
    expect(() =>
      assertRangeMatchesDirtyWindow(
        { from: '2026-07-12', through: '2026-08-27' },
        publication,
      ),
    ).toThrow('exactly equal dirty window');
  });

  it('validates complete exact department payloads', () => {
    const rows = [
      {
        code: '77',
        date: '2026-07-11',
        restriction: { date: '2026-07-11', SUP: { crise: 1 } },
      },
      {
        code: '77',
        date: '2026-07-12',
        restriction: { date: '2026-07-12', SUP: { crise: 0 } },
      },
    ];
    expect(
      validateCertifiedDepartmentDays(rows, '2026-07-11', '2026-07-12'),
    ).toHaveLength(2);
    expect(() =>
      validateCertifiedDepartmentDays(
        rows.slice(0, 1),
        '2026-07-11',
        '2026-07-12',
      ),
    ).toThrow('coverage mismatch');
  });

  it('accepts a complete national payload while excluding only id', () => {
    expect(
      validateCertifiedStatisticDays(
        [
          {
            date: '2026-07-11',
            payload: { id: 8, date: '2026-07-11', visits: null },
          },
        ],
        '2026-07-11',
        '2026-07-11',
        ['date', 'visits'],
      ),
    ).toHaveLength(1);
    expect(() =>
      validateCertifiedStatisticDays(
        [
          {
            date: '2026-07-11',
            payload: { id: 8, date: '2026-07-11' },
          },
        ],
        '2026-07-11',
        '2026-07-11',
        ['date', 'visits'],
      ),
    ).toThrow('columns mismatch');
  });
});

describe('exact SQL and promotion barriers', () => {
  it('keeps inspection read-only and apply CAS-protected', () => {
    expect(CERTIFIED_COMPLETION_INSPECT_DEPARTMENT_BATCH_SQL).not.toMatch(
      /\bUPDATE\b|\bINSERT\b|\bDELETE\b/,
    );
    expect(buildStatisticInspectionSql()).not.toMatch(
      /\bUPDATE\b|\bINSERT\b|\bDELETE\b/,
    );
    expect(CERTIFIED_COMPLETION_APPLY_DEPARTMENT_BATCH_SQL).toContain(
      'IS NOT DISTINCT FROM',
    );
    const statisticApply = buildStatisticApplySql(['date', 'visits']);
    expect(statisticApply).toContain("payload - 'id'");
    expect(statisticApply).toContain('WHERE false');
    expect(statisticApply).toContain('IS NOT DISTINCT FROM');
  });

  it('never clears dirty or advances either cursor during stats activation', () => {
    expect(CERTIFIED_COMPLETION_PROMOTION_PREFLIGHT_SQL).toContain(
      'computeMapDate',
    );
    expect(CERTIFIED_COMPLETION_PROMOTION_SQL).not.toContain(
      '"historicDirtyFrom" = NULL',
    );
    expect(CERTIFIED_COMPLETION_PROMOTION_SQL).not.toContain(
      '"historicDirtyThrough" = NULL',
    );
    expect(CERTIFIED_COMPLETION_PROMOTION_SQL).not.toContain(
      '"computeMapDate" =',
    );
    expect(CERTIFIED_COMPLETION_PROMOTION_SQL).not.toContain(
      '"computeStatsDate" =',
    );
  });

  it('certifies 48 national days and leaves no existing repaired scope incomplete', () => {
    expect(CERTIFIED_COMPLETION_PROMOTION_SQL).toContain(
      'COUNT(DISTINCT repaired."snapshotDate")',
    );
    expect(CERTIFIED_COMPLETION_PROMOTION_SQL).toContain(
      "repaired.scope = 'national'",
    );
    expect(CERTIFIED_COMPLETION_PROMOTION_SQL).toContain(
      'snapshot_coverage.count = $7::integer',
    );
    expect(CERTIFIED_COMPLETION_PROMOTION_SQL).toContain(
      "repaired.status IS DISTINCT FROM 'completed'",
    );
    expect(CERTIFIED_COMPLETION_PROMOTION_SQL).toContain(
      'repaired."processedCommuneCount" IS DISTINCT FROM',
    );
    expect(CERTIFIED_COMPLETION_PROMOTION_SQL).toContain(
      "snapshot.scope <> 'bootstrap'",
    );
  });

  it('keeps an audit-conflict retry fail-closed and revision-idempotent', () => {
    expect(CERTIFIED_COMPLETION_PROMOTION_SQL).toContain(
      'ON CONFLICT ("sourceRunId", "dateFrom", "dateThrough") DO NOTHING',
    );
    expect(CERTIFIED_COMPLETION_PROMOTION_SQL).toContain(
      'FROM audit_insert, snapshot_coverage',
    );
  });

  it('keeps promotion dry-run context reads compatible with read-only', () => {
    expect(certifiedCompletionContextSql(false)).not.toContain('FOR SHARE');
    expect(certifiedCompletionContextSql(true)).toContain(
      'FOR SHARE OF statistic_state, source_state, config',
    );
  });

  it('blocks stale current state but does not require repaired maps', () => {
    expect(() =>
      assertPromotionPreflight({
        currentDateFresh: true,
        dirtyRangeExact: true,
        computeMapDate: '2026-07-11',
        computeStatsDate: '2026-07-11',
        activeCurrentFresh: true,
        currentSnapshotFresh: true,
        outsideSnapshotsComplete: true,
        jobsIdle: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertPromotionPreflight({
        currentDateFresh: false,
        dirtyRangeExact: true,
        computeMapDate: '2026-07-11',
        computeStatsDate: '2026-07-11',
        activeCurrentFresh: true,
        currentSnapshotFresh: true,
        outsideSnapshotsComplete: true,
        jobsIdle: true,
      }),
    ).toThrow('current date is not fresh');
  });
});
