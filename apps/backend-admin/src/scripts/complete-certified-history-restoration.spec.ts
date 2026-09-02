import { DataSource, QueryRunner } from 'typeorm';
import {
  CERTIFIED_COMPLETION_APPLY_DEPARTMENT_BATCH_SQL,
  CERTIFIED_COMPLETION_ATTESTATION_RETAG_SQL,
  CERTIFIED_COMPLETION_ATTESTATION_SQL,
  CERTIFIED_COMPLETION_INITIAL_ATTESTATION_SQL,
  CERTIFIED_COMPLETION_INSPECT_DEPARTMENT_BATCH_SQL,
  CERTIFIED_COMPLETION_PROMOTION_PREFLIGHT_SQL,
  CERTIFIED_COMPLETION_PROMOTION_SQL,
  CERTIFIED_COMPLETION_SOURCE_SCOPE_SQL,
  CERTIFIED_HISTORY_V2_CERTIFIED_MANIFEST,
  RepairPublicationContext,
  assertPinnedV2CertifiedSource,
  assertPromotionPreflight,
  assertRangeMatchesDirtyWindow,
  buildStatisticApplySql,
  buildStatisticInspectionSql,
  certifiedCompletionContextSql,
  certifiedCompletionRepairAuditSql,
  chunkCertifiedValidationRows,
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

const v2RequiredEnvironment = {
  ...requiredEnvironment,
  CERTIFIED_HISTORY_COMPLETION_THROUGH: '2026-08-31',
  CERTIFIED_HISTORY_COMPLETION_SOURCE_RUN_ID:
    'vigieau-2026-07-11-2026-08-31-isolated-recompute-v2',
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
    expect(() =>
      parseCertifiedHistoryCompletionOptions({
        ...requiredEnvironment,
        CERTIFIED_HISTORY_COMPLETION_MODE: 'attest',
        CERTIFIED_HISTORY_COMPLETION_APPLY: 'true',
        CERTIFIED_HISTORY_COMPLETION_CONFIRMATION: 'PROMOTE_CERTIFIED_HISTORY',
      }),
    ).toThrow('ATTEST_CERTIFIED_HISTORY');
  });

  it('accepts only the exact approved v1 and v2 run/scope pairs', () => {
    expect(
      parseCertifiedHistoryCompletionOptions(v2RequiredEnvironment),
    ).toMatchObject({
      from: '2026-07-11',
      through: '2026-08-31',
      sourceRunId: 'vigieau-2026-07-11-2026-08-31-isolated-recompute-v2',
    });
    expect(() =>
      parseCertifiedHistoryCompletionOptions({
        ...requiredEnvironment,
        CERTIFIED_HISTORY_COMPLETION_FROM: '2026-07-10',
        CERTIFIED_HISTORY_COMPLETION_THROUGH: '2026-08-26',
      }),
    ).toThrow('approved v1 or v2 source run and exact scope');
    expect(() =>
      parseCertifiedHistoryCompletionOptions({
        ...v2RequiredEnvironment,
        CERTIFIED_HISTORY_COMPLETION_THROUGH: '2026-08-27',
      }),
    ).toThrow('approved v1 or v2 source run and exact scope');
    expect(() =>
      parseCertifiedHistoryCompletionOptions({
        ...requiredEnvironment,
        CERTIFIED_HISTORY_COMPLETION_SOURCE_RUN_ID:
          'vigieau-2026-07-11-2026-08-31-isolated-recompute-v2',
      }),
    ).toThrow('approved v1 or v2 source run and exact scope');
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
  it('bounds target validation batches independently from source reads', () => {
    expect(chunkCertifiedValidationRows([1, 2, 3, 4, 5], 2)).toEqual([
      [1, 2],
      [3, 4],
      [5],
    ]);
    expect(() => chunkCertifiedValidationRows([1], 0)).toThrow(
      'batch size must be positive',
    );
  });

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
  it('requires the exact incident dirty window for both approved scopes', () => {
    expect(() =>
      assertRangeMatchesDirtyWindow(
        {
          mode: 'restore',
          from: '2026-07-11',
          through: '2026-08-27',
          sourceRunId: 'vigieau-2026-07-11-2026-08-27-backup-repair-v1',
        },
        { ...publication, currentPublishedDate: '2026-09-02' },
      ),
    ).not.toThrow();
    expect(() =>
      assertRangeMatchesDirtyWindow(
        {
          mode: 'restore',
          from: '2026-07-11',
          through: '2026-08-27',
          sourceRunId: 'vigieau-2026-07-11-2026-08-27-backup-repair-v1',
        },
        { ...publication, historicDirtyThrough: '2026-08-26' },
      ),
    ).toThrow('requires dirty window 2026-07-11/2026-08-27');

    expect(() =>
      assertRangeMatchesDirtyWindow(
        {
          mode: 'promote',
          from: '2026-07-11',
          through: '2026-08-31',
          sourceRunId: 'vigieau-2026-07-11-2026-08-31-isolated-recompute-v2',
        },
        { ...publication, currentPublishedDate: '2026-09-02' },
      ),
    ).not.toThrow();
    expect(() =>
      assertRangeMatchesDirtyWindow(
        {
          mode: 'promote',
          from: '2026-07-11',
          through: '2026-08-31',
          sourceRunId: 'vigieau-2026-07-11-2026-08-31-isolated-recompute-v2',
        },
        {
          ...publication,
          currentPublishedDate: '2026-09-02',
          historicDirtyThrough: '2026-08-30',
        },
      ),
    ).toThrow('requires dirty window 2026-07-11/2026-08-27');
  });

  it('rejects null, differently-started or out-of-range v2 dirty windows', () => {
    const options = {
      mode: 'promote' as const,
      from: '2026-07-11',
      through: '2026-08-31',
      sourceRunId: 'vigieau-2026-07-11-2026-08-31-isolated-recompute-v2',
    };
    expect(() =>
      assertRangeMatchesDirtyWindow(options, {
        ...publication,
        historicDirtyThrough: null,
      }),
    ).toThrow('non-null dirty window');
    expect(() =>
      assertRangeMatchesDirtyWindow(options, {
        ...publication,
        historicDirtyFrom: '2026-07-12',
      }),
    ).toThrow('start at dirty window');
    expect(() =>
      assertRangeMatchesDirtyWindow(options, {
        ...publication,
        historicDirtyThrough: '2026-09-01',
      }),
    ).toThrow('promote requires dirty window 2026-07-11/2026-08-27');
  });

  it('allows v2 attestation only after the dirty boundary is expanded', () => {
    const options = {
      mode: 'attest' as const,
      from: '2026-07-11',
      through: '2026-08-31',
      sourceRunId: 'vigieau-2026-07-11-2026-08-31-isolated-recompute-v2',
    };
    expect(() =>
      assertRangeMatchesDirtyWindow(options, {
        ...publication,
        currentPublishedDate: '2026-09-02',
        historicDirtyThrough: '2026-08-31',
      }),
    ).not.toThrow();
    expect(() =>
      assertRangeMatchesDirtyWindow(options, {
        ...publication,
        currentPublishedDate: '2026-09-02',
      }),
    ).toThrow('attest requires dirty window 2026-07-11/2026-08-31');
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

  it('accepts only the exact v2 correction provenance manifest', () => {
    expect(CERTIFIED_COMPLETION_SOURCE_SCOPE_SQL).toContain(
      "'isolated-clone-certified-correction-v2'",
    );
    expect(CERTIFIED_COMPLETION_SOURCE_SCOPE_SQL).toContain(
      "'7bd55680297c2f85b4baa08792eab9eefc0578a0'",
    );
    expect(CERTIFIED_COMPLETION_SOURCE_SCOPE_SQL).toContain(
      "'e73b1ca10cb9af03e234b7340edd46dc66b5fe2172a43aba486ad394a0419d3f'",
    );
    expect(CERTIFIED_COMPLETION_SOURCE_SCOPE_SQL).toContain(
      "'3568717e031455834eb3e2a55cc5e3fd00b8b2bda00999436ddf282cc2c31447'",
    );
    expect(CERTIFIED_COMPLETION_SOURCE_SCOPE_SQL).toContain(
      "'0f9517ae3893103e8fcb4fa0198ca202fd286dba577d261e6244dc400a9e868d'",
    );
    expect(CERTIFIED_COMPLETION_SOURCE_SCOPE_SQL).toContain(
      '"restrictionIds":[98039,98040]',
    );
    expect(CERTIFIED_COMPLETION_SOURCE_SCOPE_SQL).toContain(
      '"zoneIds":[14768,14771]',
    );
    expect(CERTIFIED_COMPLETION_SOURCE_SCOPE_SQL).toContain(
      '"correctionId":"d64-late-import-37695"',
    );
    expect(CERTIFIED_COMPLETION_SOURCE_SCOPE_SQL).toContain(
      "run.provenance -> 'parentDelta'",
    );
    expect(CERTIFIED_COMPLETION_SOURCE_SCOPE_SQL).toContain(
      "run.provenance -> 'correctionSource'",
    );
    expect(CERTIFIED_COMPLETION_SOURCE_SCOPE_SQL).toContain(
      "run.provenance -> 'geometryEvidence'",
    );
    expect(CERTIFIED_COMPLETION_SOURCE_SCOPE_SQL).toContain(
      "date_source.payload -> 'correctionSource'",
    );
    expect(CERTIFIED_COMPLETION_SOURCE_SCOPE_SQL).toContain(
      '2def5d18ad10a61c173ab25c8b69003dadc5a2387333abc749eb31ddb6c1abdb',
    );
    expect(CERTIFIED_COMPLETION_SOURCE_SCOPE_SQL).toContain(
      'run.provenance - ARRAY[',
    );
    expect(CERTIFIED_COMPLETION_SOURCE_SCOPE_SQL).toContain(
      "jsonb_object_keys(\n                  run.provenance -> 'dateSources'",
    );
    expect(CERTIFIED_COMPLETION_SOURCE_SCOPE_SQL).toContain(
      "SELECT parent.provenance -> 'dateSources' ->",
    );
    expect(CERTIFIED_COMPLETION_SOURCE_SCOPE_SQL).toContain(
      'FROM "certified_history_commune_day"',
    );
    for (const value of Object.values(
      CERTIFIED_HISTORY_V2_CERTIFIED_MANIFEST,
    )) {
      expect(CERTIFIED_COMPLETION_SOURCE_SCOPE_SQL).toContain(String(value));
    }
  });

  it('rejects a v2 output even when a tampered manifest is internally consistent', () => {
    const expected = CERTIFIED_HISTORY_V2_CERTIFIED_MANIFEST;
    const source = {
      sourceRunId:
        v2RequiredEnvironment.CERTIFIED_HISTORY_COMPLETION_SOURCE_RUN_ID,
      communeCount: expected.communeCount,
      communeDayCount: expected.communeDayCount,
      departmentCount: expected.departmentCount,
      departmentDayCount: expected.departmentDayCount,
      dayCount: expected.statisticDayCount,
      communeDigest: expected.communeDigest,
      communeHistoryDigest: expected.communeHistoryDigest,
      departmentDigest: expected.departmentDigest,
      departmentHistoryDigest: expected.departmentHistoryDigest,
      statisticDigest: expected.statisticDigest,
      provenanceDigest: expected.provenanceDigest,
      sourceFingerprint: expected.sourceFingerprint,
    };
    expect(() => assertPinnedV2CertifiedSource(source)).not.toThrow();
    expect(() =>
      assertPinnedV2CertifiedSource({
        ...source,
        communeHistoryDigest: 'a'.repeat(64),
        sourceFingerprint: 'b'.repeat(64),
      }),
    ).toThrow('does not match the audited manifest');
    expect(() =>
      assertPinnedV2CertifiedSource({
        ...source,
        provenanceDigest: 'c'.repeat(64),
        sourceFingerprint: 'd'.repeat(64),
      }),
    ).toThrow('does not match the audited manifest');
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
    expect(CERTIFIED_COMPLETION_PROMOTION_SQL).toContain(
      '"historicDirtyThrough" = $4::date',
    );
    expect(CERTIFIED_COMPLETION_PROMOTION_SQL).toContain(
      'publication."historicDirtyThrough" = $18::date',
    );
  });

  it('prepares attestation with a visible retag followed by a revision CAS', () => {
    expect(CERTIFIED_COMPLETION_ATTESTATION_RETAG_SQL).toContain(
      'snapshot."certifiedHistoryRepairId" IS NULL',
    );
    expect(CERTIFIED_COMPLETION_ATTESTATION_RETAG_SQL).not.toContain(
      'statistic_publication_state',
    );
    expect(CERTIFIED_COMPLETION_ATTESTATION_SQL).toContain(
      'publication.revision = $5::bigint',
    );
    expect(CERTIFIED_COMPLETION_ATTESTATION_SQL).not.toContain(
      'certified_history_repair_attestation',
    );
    expect(CERTIFIED_COMPLETION_ATTESTATION_SQL).not.toContain(
      '"historicDirtyFrom" = NULL',
    );
    expect(CERTIFIED_COMPLETION_ATTESTATION_SQL).not.toContain(
      '"computeStatsDate" =',
    );
  });

  it('creates the initial attestation only after promotion is visible', () => {
    expect(CERTIFIED_COMPLETION_PROMOTION_SQL).not.toContain(
      'certified_history_repair_attestation',
    );
    expect(CERTIFIED_COMPLETION_INITIAL_ATTESTATION_SQL).toContain(
      'FROM "certified_history_repair_audit" repair',
    );
    expect(CERTIFIED_COMPLETION_INITIAL_ATTESTATION_SQL).toContain(
      'config."historicComputeEpoch" = $3::bigint',
    );
    expect(CERTIFIED_COMPLETION_INITIAL_ATTESTATION_SQL).toContain(
      'publication.revision = $4::bigint',
    );
    expect(CERTIFIED_COMPLETION_INITIAL_ATTESTATION_SQL).toContain(
      'repair."sourceRevision"',
    );
    expect(CERTIFIED_COMPLETION_INITIAL_ATTESTATION_SQL).toContain(
      'repair."publicationContext" || $5::jsonb',
    );
  });

  it('certifies the dynamic source day count and leaves no repaired scope incomplete', () => {
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
    expect(certifiedCompletionRepairAuditSql(false)).not.toContain('FOR SHARE');
    expect(certifiedCompletionRepairAuditSql(true)).toContain('FOR SHARE');
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
