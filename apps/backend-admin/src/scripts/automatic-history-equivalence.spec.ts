import { DataSource } from 'typeorm';
import { CurrentStatisticPriorityError } from './restore-missing-commune-history';
import * as equivalence from './attest-history-by-source-equivalence';
import { CERTIFIED_HISTORY_V2_CERTIFIED_MANIFEST as PINNED } from './restore-certified-commune-history';
import { CERTIFIED_HISTORY_V2_SOURCE_RUN_ID } from './build-certified-history-source';
import {
  AUTOMATIC_HISTORY_EQUIVALENCE_LOCK,
  AUTOMATIC_HISTORY_EQUIVALENCE_PREFLIGHT_SQL,
  automaticallyAttestHistoryBySourceEquivalence,
} from './automatic-history-equivalence';

jest.mock('./attest-history-by-source-equivalence', () => ({
  ...jest.requireActual('./attest-history-by-source-equivalence'),
  inspectEquivalenceState: jest.fn(),
  equivalenceOperatorDigest: jest.fn(),
  equivalenceProof: jest.fn(),
  applyEquivalenceAttestation: jest.fn(),
}));

const { EQUIVALENCE_ANCHOR: anchor } = equivalence;
const validAudit = {
  id: anchor.repairId,
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

describe('automatic pinned history equivalence recovery', () => {
  let state: Record<string, unknown>;
  let locked: boolean;
  let lease: any;
  let target: DataSource;
  const inspect = jest.mocked(equivalence.inspectEquivalenceState);
  const apply = jest.mocked(equivalence.applyEquivalenceAttestation);

  beforeEach(() => {
    jest.clearAllMocks();
    locked = true;
    state = {
      database: 'isolated_history_test',
      audit: structuredClone(validAudit),
      latestRepairId: anchor.repairId,
      activeAttestationId: null,
      anchorPresent: true,
    };
    lease = {
      isTransactionActive: false,
      isReleased: false,
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn(async () => {
        lease.isTransactionActive = true;
      }),
      commitTransaction: jest.fn(async () => {
        lease.isTransactionActive = false;
      }),
      rollbackTransaction: jest.fn(async () => {
        lease.isTransactionActive = false;
      }),
      release: jest.fn(async () => {
        lease.isReleased = true;
      }),
      releasePostgresConnection: jest.fn(async () => {
        lease.isReleased = true;
      }),
      query: jest.fn(async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) return [{ locked }];
        if (sql.includes('pg_advisory_unlock')) return [{ unlocked: true }];
        if (sql === AUTOMATIC_HISTORY_EQUIVALENCE_PREFLIGHT_SQL) return [state];
        return [];
      }),
    };
    target = {
      createQueryRunner: jest.fn(() => lease),
    } as unknown as DataSource;
    inspect.mockResolvedValue({
      inputs: { digest: anchor.inputDigest },
    } as equivalence.Inspection);
    jest
      .mocked(equivalence.equivalenceOperatorDigest)
      .mockResolvedValue('operator');
    jest.mocked(equivalence.equivalenceProof).mockReturnValue('proof');
    apply.mockResolvedValue({
      status: 'ATTESTED',
      attestationId: 'new',
      revision: '159',
    });
  });

  it('recovers a later invalidation only after pinned input/output inspection', async () => {
    inspect.mockImplementation(async () => {
      expect(lease.isTransactionActive).toBe(false);
      expect(lease.isReleased).toBe(false);
      return {
        inputs: { digest: anchor.inputDigest },
      } as equivalence.Inspection;
    });
    await expect(
      automaticallyAttestHistoryBySourceEquivalence(target),
    ).resolves.toEqual({
      status: 'ATTESTED',
      attestationId: 'new',
      revision: '159',
      proof: 'proof',
    });
    expect(inspect).toHaveBeenCalledWith(
      target,
      state.database,
      false,
      'operator',
      true,
    );
    expect(apply).toHaveBeenCalledWith(target, expect.anything(), 'proof');
    expect(lease.query).toHaveBeenCalledWith('SET TRANSACTION READ ONLY');
    expect(lease.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked',
      [AUTOMATIC_HISTORY_EQUIVALENCE_LOCK],
    );
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('is idempotent without any national scan for already active history', async () => {
    state.activeAttestationId = 'already-valid';
    await expect(
      automaticallyAttestHistoryBySourceEquivalence(target),
    ).resolves.toEqual({
      status: 'ALREADY_ATTESTED',
      attestationId: 'already-valid',
    });
    expect(inspect).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it.each([
    ['no repair', { audit: null }],
    ['newer restoration', { latestRepairId: 'another-repair' }],
  ])('never activates the pinned repair with %s', async (_label, change) => {
    Object.assign(state, change);
    await expect(
      automaticallyAttestHistoryBySourceEquivalence(target),
    ).resolves.toEqual({ status: 'NOT_APPLICABLE' });
    expect(inspect).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('requires the original trust attestation to still exist', async () => {
    state.anchorPresent = false;
    await expect(
      automaticallyAttestHistoryBySourceEquivalence(target),
    ).rejects.toThrow('trust anchor');
    expect(inspect).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('rejects an altered audit even when its repair id still matches', async () => {
    state.audit = { ...validAudit, communeHistoryDigest: '0'.repeat(64) };
    await expect(
      automaticallyAttestHistoryBySourceEquivalence(target),
    ).rejects.toThrow('audit mismatch');
    expect(inspect).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('does not queue behind another recovery worker', async () => {
    locked = false;
    await expect(
      automaticallyAttestHistoryBySourceEquivalence(target),
    ).resolves.toEqual({ status: 'BUSY' });
    expect(inspect).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(lease.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(lease.query).not.toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked',
      expect.anything(),
    );
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('supports a deployment preflight without publishing anything', async () => {
    await expect(
      automaticallyAttestHistoryBySourceEquivalence(target, { apply: false }),
    ).resolves.toEqual({ status: 'DRY_RUN', proof: 'proof' });
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
  });

  it.each(['inspection', 'publication'] as const)(
    'defers current priority during %s without claiming certification',
    async (phase) => {
      const error = new CurrentStatisticPriorityError(
        'Current computation has priority',
      );
      if (phase === 'inspection') inspect.mockRejectedValueOnce(error);
      else apply.mockRejectedValueOnce(error);
      await expect(
        automaticallyAttestHistoryBySourceEquivalence(target),
      ).resolves.toEqual({ status: 'BUSY' });
      if (phase === 'inspection') expect(apply).not.toHaveBeenCalled();
      expect(lease.release).toHaveBeenCalledTimes(1);
    },
  );

  it.each([{ code: '55P03' }, { driverError: { code: '55P03' } }])(
    'defers PostgreSQL lock contention %j',
    async (error) => {
      apply.mockRejectedValueOnce(error);
      await expect(
        automaticallyAttestHistoryBySourceEquivalence(target),
      ).resolves.toEqual({ status: 'BUSY' });
      expect(lease.release).toHaveBeenCalledTimes(1);
    },
  );

  it('does not hide a slow inspection behind the contention classification', async () => {
    const error = Object.assign(new Error('statement timeout'), {
      code: '57014',
    });
    inspect.mockRejectedValueOnce(error);
    await expect(
      automaticallyAttestHistoryBySourceEquivalence(target),
    ).rejects.toBe(error);
    expect(apply).not.toHaveBeenCalled();
  });

  it('propagates an unlock failure even after otherwise expected contention', async () => {
    inspect.mockRejectedValueOnce(
      new CurrentStatisticPriorityError('Current computation has priority'),
    );
    lease.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
      if (sql === AUTOMATIC_HISTORY_EQUIVALENCE_PREFLIGHT_SQL) return [state];
      if (sql.includes('pg_advisory_unlock')) throw new Error('unlock failed');
      return [];
    });
    await expect(
      automaticallyAttestHistoryBySourceEquivalence(target),
    ).rejects.toThrow('unlock failed');
    expect(lease.releasePostgresConnection).toHaveBeenCalledWith(
      expect.any(Error),
    );
    expect(lease.release).not.toHaveBeenCalled();
  });

  it('refuses to certify genuinely changed statistical inputs', async () => {
    inspect.mockResolvedValue({
      inputs: { digest: '0'.repeat(64) },
    } as equivalence.Inspection);
    await expect(
      automaticallyAttestHistoryBySourceEquivalence(target),
    ).rejects.toThrow('inputs differ');
    expect(apply).not.toHaveBeenCalled();
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it.each([
    'incomplete snapshots',
    'changed output digest',
    'unexplained invalidation',
    'statement timeout',
  ])('never publishes after inspection failure: %s', async (message) => {
    inspect.mockRejectedValue(new Error(message));
    await expect(
      automaticallyAttestHistoryBySourceEquivalence(target),
    ).rejects.toThrow(message);
    expect(apply).not.toHaveBeenCalled();
    expect(lease.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked',
      [AUTOMATIC_HISTORY_EQUIVALENCE_LOCK],
    );
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('propagates the publication concurrency guard instead of claiming success', async () => {
    apply.mockRejectedValue(
      new Error('Publication context changed after validation'),
    );
    await expect(
      automaticallyAttestHistoryBySourceEquivalence(target),
    ).rejects.toThrow('changed after validation');
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('preserves the real inspection failure if cleanup also fails', async () => {
    inspect.mockRejectedValue(new Error('real cause'));
    lease.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
      if (sql === AUTOMATIC_HISTORY_EQUIVALENCE_PREFLIGHT_SQL) return [state];
      if (sql.includes('pg_advisory_unlock')) throw new Error('cleanup error');
      return [];
    });
    await expect(
      automaticallyAttestHistoryBySourceEquivalence(target),
    ).rejects.toThrow('real cause');
    expect(lease.releasePostgresConnection).toHaveBeenCalledWith(
      expect.any(Error),
    );
    expect(lease.release).not.toHaveBeenCalled();
  });

  it('does not strand a session lock when preflight rollback fails', async () => {
    lease.commitTransaction.mockRejectedValue(new Error('commit failed'));
    lease.rollbackTransaction.mockRejectedValue(new Error('rollback failed'));
    await expect(
      automaticallyAttestHistoryBySourceEquivalence(target),
    ).rejects.toThrow('commit failed');
    expect(lease.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked',
      [AUTOMATIC_HISTORY_EQUIVALENCE_LOCK],
    );
    expect(lease.releasePostgresConnection).toHaveBeenCalledTimes(1);
    expect(lease.release).not.toHaveBeenCalled();
  });

  it('refuses a pool of one before holding a connection', async () => {
    Object.assign(target, { options: { extra: { max: 1 } } });
    await expect(
      automaticallyAttestHistoryBySourceEquivalence(target),
    ).rejects.toThrow('pool of at least 2');
    expect(target.createQueryRunner).not.toHaveBeenCalled();
  });
});
