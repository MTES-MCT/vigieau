import * as fsPromises from 'fs/promises';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  acquireSandreGlobalLock,
  acquireHistoricalRecomputeLock,
  assertNoOldReferences,
  currentTargetFingerprint,
  earliestOperationRestrictionDate,
  fetchText,
  loadDatabaseState,
  loadReferenceCounts,
  lockAffectedRows,
  moveOperationalReferences,
  parseCliOptions,
  readOperationReportIfPresent,
  RECONCILIATION_REPORT_VERSION,
  SANDRE_OPERATION_REPORT_VERSION,
  releaseReconciliationResources,
  rollbackAndReleaseQueryRunner,
  releaseSandreGlobalLock,
  verifySandrePostSafeConvergence,
  writeReportFile,
} from './reconcile-sandre-zones';
import { fingerprint } from '../zone_alerte/sandre-zone-reconciliation';

describe('reconcile-sandre-zones CLI safeguards', () => {
  const originalEnvironment = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnvironment,
      DATABASE_HOST: 'db.example.test',
      DATABASE_PORT: '5432',
      DATABASE_NAME: 'vigieau-preprod',
      SCALINGO_APP: 'regleau-back-preprod',
      NODE_ENV: 'preprod',
    };
  });

  it('keeps the earliest civil date when pg returns Date objects', () => {
    const postgresDate = (year: number, month: number, day: number) =>
      new Date(year, month - 1, day);

    expect(
      earliestOperationRestrictionDate({
        restrictions: [
          {
            arreteRestrictionDateDebut: postgresDate(2022, 9, 30),
          },
          {
            arreteRestrictionDateDebut: postgresDate(2016, 7, 18),
          },
          { arreteRestrictionDateDebut: null },
        ],
      } as any),
    ).toBe('2016-07-18');
  });

  afterAll(() => {
    process.env = originalEnvironment;
  });

  it('uses dry-run by default', () => {
    expect(parseCliOptions(['--department', '65,31'])).toEqual({
      apply: false,
      departments: ['31', '65'],
      mappingPairs: [],
      operationPlanPath: null,
      recordDecisions: false,
      reportPath: null,
      verifyPostSafe: false,
    });
  });

  it('parses explicit one-to-one mappings for a traceable dry-run', () => {
    expect(
      parseCliOptions([
        '--department',
        '2A,66',
        '--mapping',
        '16581:16773,16582:16772,8412:12060',
        '--record-decisions',
      ]),
    ).toEqual({
      apply: false,
      departments: ['2A', '66'],
      mappingPairs: [
        { oldZoneId: 8412, newZoneId: 12060 },
        { oldZoneId: 16581, newZoneId: 16773 },
        { oldZoneId: 16582, newZoneId: 16772 },
      ],
      operationPlanPath: null,
      recordDecisions: true,
      reportPath: null,
      verifyPostSafe: false,
    });
  });

  it('rejects split, merge and apply attempts for manual mappings', () => {
    expect(() =>
      parseCliOptions([
        '--department',
        '66',
        '--mapping',
        '8417:12064,8418:12064',
      ]),
    ).toThrow('not one-to-one');
    expect(() =>
      parseCliOptions([
        '--department',
        '66',
        '--mapping',
        '8412:12060',
        '--apply',
        '--report',
        '/tmp/report.json',
      ]),
    ).toThrow('dry-run options only');
  });

  it('rejects contradictory dry-run and apply flags', () => {
    expect(() =>
      parseCliOptions([
        '--dry-run',
        '--apply',
        '--report',
        '/tmp/approved.json',
      ]),
    ).toThrow('--apply and --dry-run are mutually exclusive');
  });

  describe('report file persistence', () => {
    let directory: string;

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), 'vigieau-sandre-report-'));
    });

    afterEach(async () => {
      jest.restoreAllMocks();
      await rm(directory, { force: true, recursive: true });
    });

    it('writes the exact content, syncs it and closes the file handle', async () => {
      const reportPath = join(directory, 'approved.json');
      const content = '{\n  "status": "approved"\n}\n';
      const realOpen = fsPromises.open;
      let syncSpy: jest.SpyInstance<Promise<void>, []>;
      let closeSpy: jest.SpyInstance<Promise<void>, []>;

      jest
        .spyOn(fsPromises, 'open')
        .mockImplementation(async (path, flags, mode) => {
          const handle = await realOpen(path, flags, mode);
          syncSpy = jest.spyOn(handle, 'sync');
          closeSpy = jest.spyOn(handle, 'close');
          return handle;
        });

      await writeReportFile(reportPath, content);

      await expect(readFile(reportPath, 'utf8')).resolves.toBe(content);
      expect(syncSpy).toHaveBeenCalledTimes(1);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(syncSpy.mock.invocationCallOrder[0]).toBeLessThan(
        closeSpy.mock.invocationCallOrder[0],
      );
    });

    it('preserves exclusive creation and never overwrites an existing report', async () => {
      const reportPath = join(directory, 'approved.json');
      await writeFile(reportPath, 'already approved', 'utf8');

      await expect(
        writeReportFile(reportPath, 'replacement'),
      ).rejects.toMatchObject({ code: 'EEXIST' });
      await expect(readFile(reportPath, 'utf8')).resolves.toBe(
        'already approved',
      );
    });

    it('preserves a write error when closing the file also fails', async () => {
      const writeError = new Error('write failed');
      const closeError = new Error('close failed');
      jest.spyOn(fsPromises, 'open').mockResolvedValue({
        writeFile: jest.fn().mockRejectedValue(writeError),
        sync: jest.fn(),
        close: jest.fn().mockRejectedValue(closeError),
      } as any);
      const consoleError = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);

      await expect(
        writeReportFile(join(directory, 'approved.json'), 'content'),
      ).rejects.toBe(writeError);
      expect(consoleError).toHaveBeenCalledWith(
        '[sandre-reconcile] report file cleanup failed',
        closeError,
      );
    });
  });

  it('parses an audited operation plan only in dry-run mode', () => {
    expect(parseCliOptions(['--plan', 'plans/sandre.json'])).toEqual({
      apply: false,
      departments: [],
      mappingPairs: [],
      operationPlanPath: 'plans/sandre.json',
      recordDecisions: false,
      reportPath: null,
      verifyPostSafe: false,
    });
    expect(() =>
      parseCliOptions(['--plan', 'plans/sandre.json', '--department', '2A']),
    ).toThrow('--plan cannot be combined');
  });

  it('parses post-safe verification as a report-only read', () => {
    expect(
      parseCliOptions(['--verify-post-safe', '--report', '/tmp/approved.json']),
    ).toEqual({
      apply: false,
      departments: [],
      mappingPairs: [],
      operationPlanPath: null,
      recordDecisions: false,
      reportPath: '/tmp/approved.json',
      verifyPostSafe: true,
    });
    expect(() => parseCliOptions(['--verify-post-safe'])).toThrow(
      '--verify-post-safe requires --report',
    );
    expect(() =>
      parseCliOptions([
        '--verify-post-safe',
        '--report',
        '/tmp/approved.json',
        '--department',
        '2A',
      ]),
    ).toThrow('accepts only an approved --report');
  });

  it('binds reports to the non-secret database target', () => {
    const preprodFingerprint = currentTargetFingerprint();
    process.env.DATABASE_NAME = 'vigieau-prod';
    process.env.SCALINGO_APP = 'regleau-back-prod';

    expect(currentTargetFingerprint()).not.toBe(preprodFingerprint);
  });

  it('invalidates reports created with the previous fingerprint semantics', () => {
    expect(RECONCILIATION_REPORT_VERSION).toBe(6);
    expect(SANDRE_OPERATION_REPORT_VERSION).toBe(4);
  });

  it('rejects audited operation reports from the previous evidence epoch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vigieau-sandre-v3-'));
    const reportPath = join(directory, 'approved-v3.json');
    await writeFile(
      reportPath,
      JSON.stringify({ kind: 'audited_sandre_operation', version: 3 }),
      'utf8',
    );

    try {
      await expect(readOperationReportIfPresent(reportPath)).rejects.toThrow(
        'Unsupported operation report version 3',
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('verifies exact post-safe snapshot and global health convergence', async () => {
    const snapshot = {
      departmentCode: '2A',
      snapshotHash:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sourceUpdatedAt: '2026-08-15',
      featureCount: 2,
      features: [],
    };
    const executor = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('LEFT JOIN LATERAL')) {
          return [
            {
              departmentCode: '2A',
              appliedSnapshotHash: snapshot.snapshotHash,
              appliedSourceUpdatedAt: snapshot.sourceUpdatedAt,
              appliedFeatureCount: 2,
              lastAppliedAt: '2026-08-15T10:00:00.000Z',
              blockedAt: null,
              needsRecompute: false,
              latestBatchStatus: 'applied',
            },
          ];
        }
        if (sql.includes('AS "arreteRestrictions"')) {
          return [
            {
              arreteRestrictions: 0,
              arreteCadres: 0,
              customizations: 0,
            },
          ];
        }
        return [
          {
            totalDepartments: 101,
            trackedDepartments: 101,
            staleDepartments: 0,
            forcedAuditCompletedDepartments: 101,
            appliedDepartments: 101,
            staleAppliedDepartments: 0,
            pendingApplicationDepartments: 0,
            blockedDepartments: 0,
            recomputePendingDepartments: 0,
            failedBatches: 0,
            blockedBatches: 0,
          },
        ];
      }),
    };

    const verification = await verifySandrePostSafeConvergence(
      executor,
      [snapshot],
      {
        staleAfterSeconds: 30 * 60 * 60,
        forceFullAuditAfter: new Date('2026-08-14T00:00:00.000Z'),
      },
    );

    expect(verification.health.totalDepartments).toBe(101);
    expect(verification.invalidReferences.total).toBe(0);
    expect(verification.departments).toEqual([
      expect.objectContaining({
        departmentCode: '2A',
        latestBatchStatus: 'applied',
      }),
    ]);
  });

  it('rejects post-safe verification while a plan department is blocked', async () => {
    const snapshot = {
      departmentCode: '49',
      snapshotHash:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sourceUpdatedAt: '2026-08-15',
      featureCount: 1,
      features: [],
    };
    const executor = {
      query: jest.fn().mockResolvedValue([
        {
          departmentCode: '49',
          appliedSnapshotHash: snapshot.snapshotHash,
          appliedSourceUpdatedAt: snapshot.sourceUpdatedAt,
          appliedFeatureCount: 1,
          lastAppliedAt: '2026-08-15T10:00:00.000Z',
          blockedAt: '2026-08-15T10:01:00.000Z',
          needsRecompute: false,
          latestBatchStatus: 'blocked',
        },
      ]),
    };

    await expect(
      verifySandrePostSafeConvergence(executor, [snapshot], {
        staleAfterSeconds: 30 * 60 * 60,
        forceFullAuditAfter: new Date('2026-08-14T00:00:00.000Z'),
      }),
    ).rejects.toThrow('has not converged for department 49');
  });

  it('counts only references attached to operational parent orders', async () => {
    const executor = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM arrete_cadre_zone_alerte az')) {
          return [{ id: 1, count: 2 }];
        }
        if (sql.includes('FROM restriction r')) {
          return [{ id: 1, count: 3 }];
        }
        return [{ id: 1, count: 4 }];
      }),
    };

    const counts = await loadReferenceCounts(executor, [65]);

    expect(counts.get(1)).toEqual({
      arreteCadre: 2,
      nonAbrogeArreteCadre: 2,
      restrictions: 3,
      customizations: 4,
    });
    const statements = executor.query.mock.calls.map(([sql]) => sql);
    expect(statements[0]).toContain("ac.statut IN ('a_venir', 'publie')");
    expect(statements[1]).toContain(
      'JOIN arrete_restriction ar ON ar.id = r."arreteRestrictionId"',
    );
    expect(statements[1]).toContain("ar.statut IN ('a_venir', 'publie')");
    expect(statements[2]).toContain(
      'JOIN arrete_cadre ac ON ac.id = c."arreteCadreId"',
    );
    expect(statements[2]).toContain("ac.statut IN ('a_venir', 'publie')");
  });

  it('excludes historical references from the approved database fingerprint', async () => {
    const mappings = [
      {
        departmentId: 65,
        departmentCode: '65',
        zoneType: 'SUP' as const,
        oldZoneId: 1,
        oldCodeSandre: 'OLD',
        newZoneId: 2,
        newCodeSandre: 'NEW',
      },
    ];
    const createExecutor = (historicalDate: string) => ({
      query: jest.fn(async (sql: string, parameters?: any[]) => {
        void parameters;
        if (/\n\s+FROM zone_alerte\n/.test(sql)) {
          return [
            {
              id: 1,
              idSandre: 1,
              codeSandre: 'OLD',
              disabled: true,
              departementId: 65,
              type: 'SUP',
              sandrePayloadHash: 'old-hash',
            },
            {
              id: 2,
              idSandre: 2,
              codeSandre: 'NEW',
              disabled: false,
              departementId: 65,
              type: 'SUP',
              sandrePayloadHash: 'new-hash',
            },
          ];
        }
        if (sql.includes('FROM arrete_cadre_zone_alerte link')) {
          return [
            {
              arreteCadreId: 10,
              arreteCadreStatut: 'publie',
              zoneAlerteId: 1,
            },
            {
              arreteCadreId: 11,
              arreteCadreStatut: 'abroge',
              zoneAlerteId: 1,
            },
          ];
        }
        if (sql.includes('FROM restriction restriction_row')) {
          return [
            {
              id: 20,
              arreteRestrictionId: 100,
              arreteRestrictionStatut: 'publie',
              arreteRestrictionDateDebut: '2026-07-01',
              zoneAlerteId: 1,
              arreteCadreId: 10,
              nomGroupementAep: null,
              niveauGravite: 'alerte',
            },
            {
              id: 21,
              arreteRestrictionId: 101,
              arreteRestrictionStatut: 'abroge',
              arreteRestrictionDateDebut: historicalDate,
              zoneAlerteId: 1,
              arreteCadreId: 11,
              nomGroupementAep: null,
              niveauGravite: 'crise',
            },
          ];
        }
        if (
          sql.includes('FROM arrete_cadre_zone_alerte_communes customization')
        ) {
          return [
            {
              id: 30,
              arreteCadreId: 10,
              arreteCadreStatut: 'publie',
              zoneAlerteId: 1,
            },
            {
              id: 31,
              arreteCadreId: 11,
              arreteCadreStatut: 'abroge',
              zoneAlerteId: 1,
            },
          ];
        }
        if (sql.includes('FROM sandre_zone_alias')) {
          return [
            {
              departementId: 65,
              zoneAlerteId: 1,
              zoneType: 'SUP',
              aliasType: 'cd_zas',
              aliasValue: 'OLD',
              source: 'official_sync',
            },
          ];
        }
        if (sql.includes('FROM ac_za_communes')) {
          return [
            {
              id: 30,
              communeId: 65000,
            },
          ];
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    });
    const firstExecutor = createExecutor('2020-01-01');
    const secondExecutor = createExecutor('2021-01-01');

    const firstState = await loadDatabaseState(firstExecutor, mappings);
    const secondState = await loadDatabaseState(secondExecutor, mappings);

    expect(firstState.arreteCadreLinks).toHaveLength(1);
    expect(firstState.restrictions).toEqual([
      expect.objectContaining({ id: 20, zoneAlerteId: 1 }),
    ]);
    expect(firstState.customizations).toEqual([
      expect.objectContaining({ id: 30, communeIds: [65000] }),
    ]);
    expect(fingerprint(firstState)).toBe(fingerprint(secondState));

    const statements = firstExecutor.query.mock.calls.map(([sql]) => sql);
    expect(
      statements.join('\n').match(/statut IN \('a_venir', 'publie'\)/g),
    ).toHaveLength(3);
    expect(statements.join('\n')).toContain(
      'ar."dateDebut"::text AS "arreteRestrictionDateDebut"',
    );
    const communeQuery = firstExecutor.query.mock.calls.find(([sql]) =>
      sql.includes('FROM ac_za_communes'),
    );
    expect(communeQuery?.[1]).toEqual([[30]]);
  });

  it('moves only operational references', async () => {
    const executor = { query: jest.fn().mockResolvedValue([]) };

    await moveOperationalReferences(executor);

    const statements = executor.query.mock.calls.map(([sql]) => sql);
    expect(statements).toHaveLength(4);
    statements.forEach((sql) =>
      expect(sql).toContain("parent.statut IN ('a_venir', 'publie')"),
    );
    expect(statements[0]).toContain('JOIN arrete_cadre parent');
    expect(statements[1]).toContain('arrete_cadre parent');
    expect(statements[2]).toContain('arrete_restriction parent');
    expect(statements[3]).toContain('arrete_cadre parent');
  });

  it('locks parent statuses before their operational references', async () => {
    const queryRunner = { query: jest.fn().mockResolvedValue([]) };

    await lockAffectedRows(queryRunner as any, [1, 2]);

    const statements = queryRunner.query.mock.calls.map(([sql]) => sql);
    expect(statements).toHaveLength(7);
    expect(statements[1]).toContain('FROM arrete_cadre parent');
    expect(statements[1]).toContain('UNION');
    expect(statements[2]).toContain('FROM arrete_restriction parent');
    statements.slice(3, 6).forEach((sql) => {
      expect(sql).toContain("parent.statut IN ('a_venir', 'publie')");
      expect(sql).toContain('FOR UPDATE OF');
    });
  });

  it('allows historical business links to remain on old zones', async () => {
    const executor = { query: jest.fn().mockResolvedValue([]) };
    const mappings = [
      {
        departmentId: 65,
        departmentCode: '65',
        zoneType: 'SUP' as const,
        oldZoneId: 1,
        oldCodeSandre: 'OLD',
        newZoneId: 2,
        newCodeSandre: 'NEW',
      },
    ];

    await expect(
      assertNoOldReferences(executor, mappings),
    ).resolves.toBeUndefined();

    const sql = executor.query.mock.calls[0][0];
    expect(sql.match(/parent.statut IN \('a_venir', 'publie'\)/g)).toHaveLength(
      3,
    );
    expect(sql).toContain('FROM sandre_zone_alias');
  });

  it('skips the historical lock when no historical recompute is needed', async () => {
    const executor = { query: jest.fn() };

    await expect(acquireHistoricalRecomputeLock(executor, null)).resolves.toBe(
      false,
    );
    expect(executor.query).not.toHaveBeenCalled();
  });

  it('acquires the historical session lock', async () => {
    const executor = {
      query: jest.fn().mockResolvedValue([{ locked: true }]),
    };

    await expect(
      acquireHistoricalRecomputeLock(executor, '2024-01-15'),
    ).resolves.toBe(true);
    expect(executor.query).toHaveBeenCalledWith(
      "SELECT pg_try_advisory_lock(hashtext('vigieau'), hashtext('zone-compute-historic')) AS locked",
    );
  });

  it('bounds the historical lock wait', async () => {
    const executor = {
      query: jest.fn().mockResolvedValue([{ locked: false }]),
    };

    await expect(
      acquireHistoricalRecomputeLock(executor, '2024-01-15', 0),
    ).rejects.toThrow('Timed out waiting for the historic zone compute lock');
    expect(executor.query).toHaveBeenCalledTimes(1);
  });

  it('releases its connection when the global Sandre lock is busy', async () => {
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([{ locked: false }]),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunner),
    };

    await expect(acquireSandreGlobalLock(dataSource as any)).rejects.toThrow(
      'already running',
    );
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('falls back before releasing a failed global Sandre unlock', async () => {
    const unlockError = new Error('connection interrupted');
    const queryRunner = {
      query: jest
        .fn()
        .mockRejectedValueOnce(unlockError)
        .mockResolvedValueOnce([]),
      release: jest.fn().mockResolvedValue(undefined),
    };

    await expect(releaseSandreGlobalLock(queryRunner as any)).rejects.toBe(
      unlockError,
    );
    expect(queryRunner.query).toHaveBeenNthCalledWith(
      2,
      'SELECT pg_advisory_unlock_all()',
    );
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('releases the query runner even when the historical unlock fails', async () => {
    const queryRunner = {
      query: jest.fn().mockResolvedValue([{ unlocked: false }]),
      release: jest.fn().mockResolvedValue(undefined),
    };

    await expect(
      releaseReconciliationResources(queryRunner as any, true),
    ).rejects.toThrow('Unable to release the historic zone compute lock');
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('falls back to unlocking all session locks before releasing the runner', async () => {
    const unlockError = new Error('connection interrupted');
    const queryRunner = {
      query: jest
        .fn()
        .mockRejectedValueOnce(unlockError)
        .mockResolvedValueOnce([]),
      release: jest.fn().mockResolvedValue(undefined),
    };

    await expect(
      releaseReconciliationResources(queryRunner as any, true),
    ).rejects.toBe(unlockError);
    expect(queryRunner.query).toHaveBeenNthCalledWith(
      2,
      'SELECT pg_advisory_unlock_all()',
    );
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('does not issue an unlock query when no historical lock was acquired', async () => {
    const queryRunner = {
      query: jest.fn(),
      release: jest.fn().mockResolvedValue(undefined),
    };

    await expect(
      releaseReconciliationResources(queryRunner as any, false),
    ).resolves.toBeUndefined();
    expect(queryRunner.query).not.toHaveBeenCalled();
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('releases the runner without masking a primary error when rollback fails', async () => {
    const primaryError = new Error('business invariant failed');
    const rollbackError = new Error('rollback failed');
    const queryRunner = {
      isTransactionActive: true,
      rollbackTransaction: jest.fn().mockRejectedValue(rollbackError),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const operation = async () => {
      let operationError: unknown;
      try {
        throw primaryError;
      } catch (error) {
        operationError = error;
        throw error;
      } finally {
        await rollbackAndReleaseQueryRunner(
          queryRunner as any,
          operationError,
          'test',
        );
      }
    };

    await expect(operation()).rejects.toBe(primaryError);
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      '[sandre-reconcile] test cleanup failed',
      rollbackError,
    );
  });

  it('keeps a primary error when releasing the transaction runner fails', async () => {
    const primaryError = new Error('business invariant failed');
    const releaseError = new Error('release failed');
    const queryRunner = {
      isTransactionActive: true,
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockRejectedValue(releaseError),
    };
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const operation = async () => {
      let operationError: unknown;
      try {
        throw primaryError;
      } catch (error) {
        operationError = error;
        throw error;
      } finally {
        await rollbackAndReleaseQueryRunner(
          queryRunner as any,
          operationError,
          'test',
        );
      }
    };

    await expect(operation()).rejects.toBe(primaryError);
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      '[sandre-reconcile] test cleanup failed',
      releaseError,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses a supported language header for Sandre metadata', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue('<metadata />'),
    } as unknown as Response);

    await expect(
      fetchText('https://www.sandre.eaufrance.fr/metadata.xml'),
    ).resolves.toBe('<metadata />');
    expect(fetch).toHaveBeenCalledWith(
      'https://www.sandre.eaufrance.fr/metadata.xml',
      expect.objectContaining({
        headers: expect.objectContaining({
          'accept-language': 'fr',
        }),
      }),
    );
  });
});
