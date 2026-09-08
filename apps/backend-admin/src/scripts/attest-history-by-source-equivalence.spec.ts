import {
  EQUIVALENCE_ANCHOR,
  EQUIVALENCE_ANCHOR_LOOKUP_GUARD,
  EQUIVALENCE_LEDGER_SQL,
  EQUIVALENCE_LOOKUP_GUARD_SQL,
  EQUIVALENCE_RELATIONS_SQL,
  acquireEquivalenceFinalLocks,
  applyEquivalenceAttestation,
  assertEquivalenceAudit,
  assertEquivalenceAnchorInputs,
  assertEquivalenceLedger,
  assertEquivalenceLookupGuard,
  assertVersionValidation,
  outputBatchSql,
  parseEquivalenceOptions,
  validateOutputRows,
  versionValidationSql,
} from './attest-history-by-source-equivalence';
import { CERTIFIED_HISTORY_V2_CERTIFIED_MANIFEST as PINNED } from './restore-certified-commune-history';
import { CERTIFIED_HISTORY_V2_SOURCE_RUN_ID } from './build-certified-history-source';
import {
  HISTORY_SOURCE_EQUIVALENCE_SQL,
  canonicalEquivalenceJson,
  equivalenceDigest,
  sourceEquivalenceEvidence,
} from './history-source-equivalence';
import { DataSource, QueryRunner } from 'typeorm';
import {
  CERTIFIED_COMPLETION_ATTESTATION_SQL,
  CERTIFIED_COMPLETION_INITIAL_ATTESTATION_SQL,
} from './complete-certified-history-restoration';

const environment = {
  HISTORY_EQUIVALENCE_SOURCE_DATABASE: 'history_source_20260903',
  HISTORY_EQUIVALENCE_TARGET_DATABASE: 'regleau_bac_1701',
  HISTORY_EQUIVALENCE_ANCHOR_ARCHIVE: '/private/prod-20260903.tar.gz',
};
const audit = {
  id: EQUIVALENCE_ANCHOR.repairId,
  sourceRunId: CERTIFIED_HISTORY_V2_SOURCE_RUN_ID,
  dateFrom: '2026-07-11',
  dateThrough: '2026-08-31',
  communeCount: 34943,
  departmentCount: 101,
  dayCount: 52,
  activationKind: 'statistics-only',
  communeHistoryDigest: PINNED.communeHistoryDigest,
  departmentHistoryDigest: PINNED.departmentHistoryDigest,
  statisticDigest: PINNED.statisticDigest,
  provenanceDigest: PINNED.provenanceDigest,
  publicationContext: { sourceFingerprint: PINNED.sourceFingerprint },
};
const invalidation = {
  epochAfter: '797',
  cause: 'published-source-mutation',
  fallback: false,
  invalidatesStatistics: true,
  invalidatesMaps: true,
  affectedRange: '[2026-09-01,2026-09-04)',
  sourceRevision: '168710',
  context: {},
};

describe('explicit history source equivalence options', () => {
  it('defaults to read-only, bounded inspection with explicit distinct identities', () => {
    expect(parseEquivalenceOptions(environment)).toEqual({
      apply: false,
      sourceDatabase: 'history_source_20260903',
      targetDatabase: 'regleau_bac_1701',
      archivePath: environment.HISTORY_EQUIVALENCE_ANCHOR_ARCHIVE,
      expectedProof: null,
    });
    expect(() =>
      parseEquivalenceOptions({
        ...environment,
        HISTORY_EQUIVALENCE_TARGET_DATABASE: 'history_source_20260903',
      }),
    ).toThrow('distinct');
    expect(() =>
      parseEquivalenceOptions({
        ...environment,
        HISTORY_EQUIVALENCE_TARGET_DATABASE: 'prod;DROP',
      }),
    ).toThrow('distinct');
  });
  it('requires its own write confirmation and exact dry-run proof', () => {
    expect(() =>
      parseEquivalenceOptions({
        ...environment,
        HISTORY_EQUIVALENCE_APPLY: 'true',
      }),
    ).toThrow('ATTEST_HISTORY_BY_SOURCE_EQUIVALENCE');
    expect(() =>
      parseEquivalenceOptions({
        ...environment,
        HISTORY_EQUIVALENCE_APPLY: 'true',
        HISTORY_EQUIVALENCE_CONFIRMATION: 'ATTEST_CERTIFIED_HISTORY',
        HISTORY_EQUIVALENCE_EXPECTED_PROOF: 'a'.repeat(64),
      }),
    ).toThrow('ATTEST_HISTORY_BY_SOURCE_EQUIVALENCE');
    expect(
      parseEquivalenceOptions({
        ...environment,
        HISTORY_EQUIVALENCE_APPLY: 'true',
        HISTORY_EQUIVALENCE_CONFIRMATION:
          'ATTEST_HISTORY_BY_SOURCE_EQUIVALENCE',
        HISTORY_EQUIVALENCE_EXPECTED_PROOF: 'a'.repeat(64),
      }).apply,
    ).toBe(true);
  });
});

describe('existing certified anchor, not manufactured provenance', () => {
  it('rejects an altered restored clone even when its old audit remains present', () => {
    expect(() =>
      assertEquivalenceAnchorInputs(EQUIVALENCE_ANCHOR.inputDigest),
    ).not.toThrow();
    expect(() => assertEquivalenceAnchorInputs('a'.repeat(64))).toThrow(
      'anchor inputs differ',
    );
  });
  it('requires pinned audit identity, date range, counts and every digest', () => {
    expect(() => assertEquivalenceAudit(audit)).not.toThrow();
    for (const [field, value] of Object.entries({
      id: 'different',
      sourceRunId: 'new-v3',
      dateFrom: '2026-07-12',
      dayCount: 51,
      communeCount: 34942,
      activationKind: 'statistics-and-maps',
      statisticDigest: 'a'.repeat(64),
      communeHistoryDigest: 'a'.repeat(64),
      departmentHistoryDigest: 'a'.repeat(64),
      provenanceDigest: 'a'.repeat(64),
    })) {
      expect(() =>
        assertEquivalenceAudit({ ...audit, [field]: value }),
      ).toThrow('audit mismatch');
    }
    expect(() =>
      assertEquivalenceAudit({ ...audit, publicationContext: {} }),
    ).toThrow('fingerprint');
  });
  it('requires every intervening invalidation and rejects unknown/fallback changes', () => {
    expect(() => assertEquivalenceLedger([], '796')).not.toThrow();
    expect(() => assertEquivalenceLedger([invalidation], '797')).not.toThrow();
    expect(() =>
      assertEquivalenceLedger(
        [{ ...invalidation, sourceRevision: null }],
        '797',
      ),
    ).not.toThrow();
    expect(() =>
      assertEquivalenceLedger(
        [{ ...invalidation, sourceRevision: 'not-a-revision' }],
        '797',
      ),
    ).toThrow('Unexplained');
    expect(() => assertEquivalenceLedger([], '797')).toThrow('Incomplete');
    expect(() =>
      assertEquivalenceLedger([{ ...invalidation, epochAfter: '798' }], '798'),
    ).toThrow('Unexplained');
    expect(() =>
      assertEquivalenceLedger([{ ...invalidation, fallback: true }], '797'),
    ).toThrow('Unexplained');
    expect(() =>
      assertEquivalenceLedger(
        [{ ...invalidation, cause: 'legacy-epoch-writer-fallback' }],
        '797',
      ),
    ).toThrow('Unexplained');
  });
});

describe('exact statistical inputs and output proofs', () => {
  it('canonicalizes object ordering but keeps array membership and payload changes', () => {
    expect(canonicalEquivalenceJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
    expect(equivalenceDigest({ a: 1, b: 2 })).toBe(
      equivalenceDigest({ b: 2, a: 1 }),
    );
    expect(equivalenceDigest({ ressourceInfluencee: false })).not.toBe(
      equivalenceDigest({ ressourceInfluencee: true }),
    );
    expect(equivalenceDigest({ geom: 'one' })).not.toBe(
      equivalenceDigest({ geom: 'two' }),
    );
    expect(equivalenceDigest({ through: '2026-08-31' })).not.toBe(
      equivalenceDigest({ through: '2026-08-30' }),
    );
  });
  it('covers the resource priority, personalization and public grouping inputs', () => {
    for (const input of [
      'ressourceInfluencee',
      'restriction_commune',
      'ac_za_communes',
      'superpositionCommune',
      'ST_AsEWKB',
      'regionId',
      'bassin_versant_departement',
      'niveauGraviteSpecifiqueEap',
    ]) {
      expect(HISTORY_SOURCE_EQUIVALENCE_SQL).toContain(input);
    }
    expect(HISTORY_SOURCE_EQUIVALENCE_SQL).toContain(
      "ar.statut IN ('publie','abroge')",
    );
    expect(HISTORY_SOURCE_EQUIVALENCE_SQL).toContain('greatest(ar."dateDebut"');
    expect(HISTORY_SOURCE_EQUIVALENCE_SQL).toContain(
      '\'dateDebut\',ar."dateDebut"',
    );
    expect(
      equivalenceDigest({ from: '2026-07-11', dateDebut: '2026-07-01' }),
    ).not.toBe(
      equivalenceDigest({ from: '2026-07-11', dateDebut: '2026-07-02' }),
    );
    expect(HISTORY_SOURCE_EQUIVALENCE_SQL).toContain(
      'least(coalesce(ar."dateFin"',
    );
  });
  it('rejects missing sources, duplicate identities and partial national coverage', () => {
    expect(() => sourceEquivalenceEvidence([])).toThrow('Missing source');
    const row = { section: 'orders', key: '1', department: '01', payload: {} };
    expect(() => sourceEquivalenceEvidence([row, row])).toThrow('Duplicate');
    expect(() =>
      sourceEquivalenceEvidence([{ ...row, section: 'unknown' }]),
    ).toThrow('Invalid');
    const rows = [
      'orders',
      'zones',
      'communes',
      'departments',
      'regions',
      'basins',
      'parameters',
    ].map((section) => ({ ...row, section }));
    expect(() => sourceEquivalenceEvidence(rows)).toThrow(
      'Incomplete national',
    );
  });
  it('uses exact PostgreSQL daily payloads, not national situations alone', () => {
    expect(outputBatchSql('commune')).toContain(
      "day-ARRAY['date','SOU','SUP','AEP']",
    );
    expect(outputBatchSql('department')).toContain(
      "jsonb_build_array(day->>'date',day)",
    );
    expect(outputBatchSql('national')).toContain('to_jsonb(statistic)');
    expect(() => validateOutputRows('commune', [])).toThrow('Incomplete');
    expect(() =>
      validateOutputRows('commune', [
        {
          id: 1,
          xmin: '1',
          tableoid: '1',
          code: '01001',
          dayCount: 51,
          distinctDayCount: 51,
          invalidCount: 0,
          digest: 'a'.repeat(64),
        },
      ]),
    ).toThrow('Invalid');
    expect(() =>
      validateOutputRows('commune', [
        {
          id: 1,
          xmin: '1',
          tableoid: '1',
          code: '01001',
          dayCount: 52,
          distinctDayCount: 51,
          invalidCount: 0,
          digest: 'a'.repeat(64),
        },
      ]),
    ).toThrow('Invalid');
  });
});

describe('short optimistic validation boundary', () => {
  it('checks total and unique populations as well as every id/xmin/tableoid', () => {
    const valid = {
      actualCount: 2,
      distinctCount: 2,
      expectedCount: 2,
      uniqueExpectedCount: 2,
      matchedCount: 2,
    };
    expect(() => assertVersionValidation(valid, 2)).not.toThrow();
    for (const field of Object.keys(valid))
      expect(() =>
        assertVersionValidation({ ...valid, [field]: 1 }, 2),
      ).toThrow('changed');
    expect(versionValidationSql('statistic_commune')).toContain(
      'jsonb_to_recordset',
    );
    expect(versionValidationSql('statistic_commune')).toContain(
      'a.tableoid=e.tableoid',
    );
    expect(versionValidationSql('statistic')).toContain(
      "date BETWEEN '2026-07-11' AND '2026-08-31'",
    );
  });
  it('bounds the entire final transaction and never waits for an active writer', async () => {
    const query = jest.fn(async (sql: string) =>
      sql.includes('AS snapshot')
        ? [{ snapshot: true, zone: true, promotion: true }]
        : [],
    );
    await acquireEquivalenceFinalLocks({ query } as unknown as QueryRunner);
    const sql = query.mock.calls.map(([value]) => value).join('\n');
    expect(sql).toContain("transaction_timeout='3s'");
    expect(sql).toContain("statement_timeout='2s'");
    expect(sql).toContain("lock_timeout='50ms'");
    expect(sql).toContain(
      'statistic_commune, statistic_departement, statistic, region, zone_alerte_computed, zone_alerte_computed_historic IN SHARE MODE NOWAIT',
    );
    expect(sql).toContain('IN ROW EXCLUSIVE MODE NOWAIT');
    expect(sql).toContain('vigieau:zone-publication-stable-promotion');
    expect(sql).not.toContain('pg_advisory_lock(');
  });
  it('aborts before table locks when a current computation owns any advisory lock', async () => {
    const query = jest.fn(async (sql: string) =>
      sql.includes('AS snapshot')
        ? [{ snapshot: true, zone: false, promotion: true }]
        : [],
    );
    await expect(
      acquireEquivalenceFinalLocks({ query } as unknown as QueryRunner),
    ).rejects.toThrow('lock busy');
    expect(query.mock.calls).toHaveLength(2);
  });
});

describe('atomic append-only attestation', () => {
  function fixture() {
    const context = {
      statisticRevision: '149',
      currentPublishedDate: '2026-09-08',
      historicPublishedThrough: '2026-08-27',
      historicDirtyFrom: '2026-07-11',
      historicDirtyThrough: '2026-08-31',
      sourceRevision: '187079',
      sourcePublicRevision: '168744',
      legacyDualWrite: false,
      historicComputeEpoch: '823',
      historicBackfillGlobalEpoch: '9',
      computeMapDate: '2026-07-09',
      computeStatsDate: '2026-07-09',
    };
    const versions = [{ id: 1, xmin: '100', tableoid: '200' }];
    const output = { count: 1, days: 52, digest: 'a'.repeat(64), versions };
    const inspection = {
      operatorDigest: 'a'.repeat(64),
      context,
      inputs: { policy: 'test', digest: 'a'.repeat(64), sections: {} },
      outputs: { commune: output, department: output, national: output },
      regionVersions: versions,
      relations: [],
      ledger: [],
      audit,
      active: null,
      lookupGuard: EQUIVALENCE_ANCHOR_LOOKUP_GUARD,
    };
    let changed = false;
    let mismatch = false;
    let existing = false;
    let lookupChanged = false;
    const runner = {
      isTransactionActive: false,
      connect: jest.fn(async () => {}),
      release: jest.fn(async () => {}),
      startTransaction: jest.fn(async () => {
        runner.isTransactionActive = true;
      }),
      commitTransaction: jest.fn(async () => {
        runner.isTransactionActive = false;
      }),
      rollbackTransaction: jest.fn(async () => {
        runner.isTransactionActive = false;
      }),
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('AS snapshot'))
          return [{ snapshot: true, zone: true, promotion: true }];
        if (sql === EQUIVALENCE_LOOKUP_GUARD_SQL)
          return [
            {
              ...EQUIVALENCE_ANCHOR_LOOKUP_GUARD,
              currentMax: lookupChanged
                ? '4093681'
                : EQUIVALENCE_ANCHOR_LOOKUP_GUARD.currentMax,
            },
          ];
        if (
          sql.includes('AS "statisticRevision"') &&
          sql.includes('AS "sourcePublicRevision"')
        )
          return [
            {
              ...context,
              sourceRevision: changed ? '187080' : context.sourceRevision,
              priorityActive: false,
            },
          ];
        if (sql === EQUIVALENCE_RELATIONS_SQL || sql === EQUIVALENCE_LEDGER_SQL)
          return [];
        if (
          sql.includes(
            'SELECT to_jsonb(a) AS value FROM certified_history_repair_audit',
          )
        )
          return [{ value: audit }];
        if (sql.includes('WITH expected AS MATERIALIZED'))
          return [
            {
              actualCount: 1,
              distinctCount: 1,
              expectedCount: 1,
              uniqueExpectedCount: 1,
              matchedCount: mismatch ? 0 : 1,
            },
          ];
        if (sql.includes('SELECT "attestationId" AS id'))
          return existing ? [{ id: 'previous-attestation' }] : [];
        if (sql === CERTIFIED_COMPLETION_ATTESTATION_SQL)
          return [
            { snapshotDayCount: 52, invalidSnapshotCount: 0, revision: '150' },
          ];
        if (sql === CERTIFIED_COMPLETION_INITIAL_ATTESTATION_SQL)
          return [{ attestationId: params?.[0], revision: '150' }];
        return [];
      }),
    };
    const target = { createQueryRunner: () => runner } as unknown as DataSource;
    return {
      runner,
      target,
      inspection,
      setChanged: () => {
        changed = true;
      },
      setMismatch: () => {
        mismatch = true;
      },
      setExisting: () => {
        existing = true;
      },
      setLookupChanged: () => {
        lookupChanged = true;
      },
    };
  }
  it('uses fresh READ COMMITTED checks and only appends attestation plus cache revision', async () => {
    const f = fixture();
    await expect(
      applyEquivalenceAttestation(f.target, f.inspection, 'proof'),
    ).resolves.toMatchObject({ status: 'ATTESTED', revision: '150' });
    expect(f.runner.startTransaction).toHaveBeenCalledWith('READ COMMITTED');
    expect(f.runner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(f.runner.rollbackTransaction).not.toHaveBeenCalled();
    const mutations = f.runner.query.mock.calls
      .map(([sql]) => sql)
      .filter(
        (sql) =>
          /\b(?:UPDATE|INSERT INTO|DELETE FROM)\b/.test(sql) &&
          !sql.includes('FOR UPDATE'),
      );
    expect(mutations).toEqual([
      CERTIFIED_COMPLETION_ATTESTATION_SQL,
      CERTIFIED_COMPLETION_INITIAL_ATTESTATION_SQL,
    ]);
    expect(f.inspection.context.currentPublishedDate).toBe('2026-09-08');
    expect(f.inspection.context.historicDirtyFrom).toBe('2026-07-11');
  });
  it.each(['context', 'outputs', 'lookup'])(
    'rolls back without writes when %s drift',
    async (kind) => {
      const f = fixture();
      if (kind === 'context') f.setChanged();
      else if (kind === 'lookup') f.setLookupChanged();
      else f.setMismatch();
      await expect(
        applyEquivalenceAttestation(f.target, f.inspection, 'proof'),
      ).rejects.toThrow('changed');
      expect(f.runner.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(
        f.runner.query.mock.calls.some(
          ([sql]) => sql === CERTIFIED_COMPLETION_ATTESTATION_SQL,
        ),
      ).toBe(false);
      expect(
        f.runner.query.mock.calls.some(
          ([sql]) => sql === CERTIFIED_COMPLETION_INITIAL_ATTESTATION_SQL,
        ),
      ).toBe(false);
    },
  );
  it('is idempotent for an already active attestation at the same epoch', async () => {
    const f = fixture();
    f.setExisting();
    await expect(
      applyEquivalenceAttestation(f.target, f.inspection, 'proof'),
    ).resolves.toEqual({
      status: 'ALREADY_ATTESTED',
      attestationId: 'previous-attestation',
    });
    expect(
      f.runner.query.mock.calls.some(
        ([sql]) => sql === CERTIFIED_COMPLETION_INITIAL_ATTESTATION_SQL,
      ),
    ).toBe(false);
  });
});

describe('derived AEP lookup cannot affect the existing certificate', () => {
  it('requires disjoint exact integer ranges and a forward-only called sequence', () => {
    expect(() =>
      assertEquivalenceLookupGuard(EQUIVALENCE_ANCHOR_LOOKUP_GUARD),
    ).not.toThrow();
    for (const patch of [
      { currentCount: 0 },
      { historicCount: 0 },
      { currentMax: '33890060' },
      { sequenceLast: '33897146' },
      { sequenceCalled: false },
      { sequenceIncrement: '-1' },
      { sequenceIncrement: '0' },
      { sequenceCycle: true },
      { historicMin: null },
      { historicMin: 'not-a-number' },
    ])
      expect(() =>
        assertEquivalenceLookupGuard({
          ...EQUIVALENCE_ANCHOR_LOOKUP_GUARD,
          ...patch,
        }),
      ).toThrow('Historic AEP');
  });
  it('does not lose precision for big integer sequence values', () => {
    expect(() =>
      assertEquivalenceLookupGuard({
        ...EQUIVALENCE_ANCHOR_LOOKUP_GUARD,
        currentMax: '9007199254740992',
        historicMin: '9007199254740993',
        historicMax: '9007199254740994',
        sequenceLast: '9007199254740994',
      }),
    ).not.toThrow();
    expect(() =>
      assertEquivalenceLookupGuard({
        ...EQUIVALENCE_ANCHOR_LOOKUP_GUARD,
        currentMax: '9007199254740993',
        historicMin: '9007199254740993',
        historicMax: '9007199254740994',
        sequenceLast: '9007199254740994',
      }),
    ).toThrow('overlap');
  });
});
