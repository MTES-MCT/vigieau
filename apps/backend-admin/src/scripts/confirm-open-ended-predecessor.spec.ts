import { QueryRunner } from 'typeorm';
import {
  confirmOpenEndedPredecessor,
  ConfirmPredecessorOptions,
  parseConfirmPredecessorOptions,
} from './confirm-open-ended-predecessor';

interface ProvenanceState {
  dateFinSaisie: string | null;
  dateFinCalculee: boolean;
  dateFinSaisieConnue: boolean;
}

const options = (
  overrides: Partial<ConfirmPredecessorOptions> = {},
): ConfirmPredecessorOptions => ({
  apply: false,
  successorId: 37577,
  expectedStart: '2026-08-05',
  expectedPredecessorEnd: '2026-08-04',
  ...overrides,
});

const migrationState: ProvenanceState = {
  dateFinSaisie: '2026-08-04',
  dateFinCalculee: true,
  dateFinSaisieConnue: false,
};

const legacyState: ProvenanceState = {
  dateFinSaisie: null,
  dateFinCalculee: false,
  dateFinSaisieConnue: true,
};

function createQueryRunner(
  provenance: ProvenanceState = migrationState,
  updateResult: unknown = [[{ id: 37487 }], 1],
  facts: { predecessorStart?: string; frameworkEnd?: string | null } = {},
): QueryRunner & {
  query: jest.Mock;
  startTransaction: jest.Mock;
  commitTransaction: jest.Mock;
  rollbackTransaction: jest.Mock;
} {
  let transactionActive = false;
  const queryRunner = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) {
        return [];
      }
      if (sql.includes('FROM arrete_restriction successor')) {
        return [
          {
            successorId: 37577,
            successorStart: '2026-08-05',
            successorStatus: 'a_venir',
            successorDepartmentId: 53,
            predecessorId: 37487,
            predecessorStart: facts.predecessorStart ?? '2026-07-28',
            predecessorEnd: '2026-08-04',
            predecessorStatus: 'publie',
            predecessorDepartmentId: 53,
            ...provenance,
          },
        ];
      }
      if (sql.includes('SELECT count(*)::integer AS count')) {
        return [{ count: 1 }];
      }
      if (sql.includes('MIN(framework_order."dateFin")')) {
        return [{ frameworkEnd: facts.frameworkEnd ?? null }];
      }
      if (sql.includes('UPDATE arrete_restriction')) {
        return updateResult;
      }
      throw new Error(`Unexpected SQL in test: ${sql}`);
    }),
    startTransaction: jest.fn(async () => {
      transactionActive = true;
    }),
    commitTransaction: jest.fn(async () => {
      transactionActive = false;
    }),
    rollbackTransaction: jest.fn(async () => {
      transactionActive = false;
    }),
    get isTransactionActive() {
      return transactionActive;
    },
  };
  return queryRunner as unknown as ReturnType<typeof createQueryRunner>;
}

describe('confirm-open-ended-predecessor', () => {
  describe('CLI parser', () => {
    it('parses an explicit guarded apply command', () => {
      expect(
        parseConfirmPredecessorOptions([
          '--successor-id',
          '37577',
          '--expected-start',
          '2026-08-05',
          '--expected-predecessor-end',
          '2026-08-04',
          '--apply',
        ]),
      ).toEqual(options({ apply: true }));
    });

    it('rejects unknown, duplicate, missing and inconsistent arguments', () => {
      expect(() =>
        parseConfirmPredecessorOptions(['--unknown', 'value']),
      ).toThrow('Invalid argument');
      expect(() =>
        parseConfirmPredecessorOptions([
          '--successor-id',
          '37577',
          '--successor-id',
          '37578',
        ]),
      ).toThrow('Duplicate argument');
      expect(() =>
        parseConfirmPredecessorOptions(['--successor-id', '--apply']),
      ).toThrow('Missing value');
      expect(() =>
        parseConfirmPredecessorOptions([
          '--successor-id',
          '37577',
          '--expected-start',
          '2026-08-05',
          '--expected-predecessor-end',
          '2026-08-03',
        ]),
      ).toThrow('must be the day before');
    });
  });

  it('validates the exact migration provenance in dry-run and rolls back', async () => {
    const queryRunner = createQueryRunner();

    await expect(
      confirmOpenEndedPredecessor(queryRunner, options()),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'DRY_RUN',
        successorId: 37577,
        predecessorId: 37487,
      }),
    );

    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(
      queryRunner.query.mock.calls.some(([sql]) =>
        sql.includes('UPDATE arrete_restriction'),
      ),
    ).toBe(false);
  });

  it('applies only with all provenance guards and commits', async () => {
    const queryRunner = createQueryRunner();

    await expect(
      confirmOpenEndedPredecessor(queryRunner, options({ apply: true })),
    ).resolves.toEqual(expect.objectContaining({ status: 'APPLIED' }));

    const [updateSql, updateParameters] = queryRunner.query.mock.calls.find(
      ([sql]) => sql.includes('UPDATE arrete_restriction'),
    );
    expect(updateSql).toContain('"dateFin" = $2::date');
    expect(updateSql).toContain('"dateFinSaisie" = $2::date');
    expect(updateSql).toContain('"dateFinCalculee" IS TRUE');
    expect(updateSql).toContain('"dateFinSaisieConnue" IS FALSE');
    expect(updateSql).toContain('"dateFinSaisie" IS NULL');
    expect(updateSql).toContain('"dateFinCalculee" IS FALSE');
    expect(updateSql).toContain('"dateFinSaisieConnue" IS TRUE');
    expect(updateParameters).toEqual([37487, '2026-08-04']);
    const [frameworkSql, frameworkParameters] =
      queryRunner.query.mock.calls.find(([sql]) =>
        sql.includes('MIN(framework_order."dateFin")'),
      );
    expect(frameworkSql).toContain('framework_order."dateFin" >= $2::date');
    expect(frameworkParameters).toEqual([37487, '2026-07-28']);
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
  });

  it('confirms the exact conservative legacy state created by the migration', async () => {
    const queryRunner = createQueryRunner(legacyState);

    await expect(
      confirmOpenEndedPredecessor(queryRunner, options({ apply: true })),
    ).resolves.toEqual(expect.objectContaining({ status: 'APPLIED' }));
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('is idempotent only for the exact confirmed state', async () => {
    const queryRunner = createQueryRunner({
      dateFinSaisie: null,
      dateFinCalculee: true,
      dateFinSaisieConnue: true,
    });

    await expect(
      confirmOpenEndedPredecessor(queryRunner, options({ apply: true })),
    ).resolves.toEqual(expect.objectContaining({ status: 'ALREADY_APPLIED' }));
    expect(
      queryRunner.query.mock.calls.some(([sql]) =>
        sql.includes('UPDATE arrete_restriction'),
      ),
    ).toBe(false);
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('rejects an explicit legal end even during dry-run', async () => {
    const queryRunner = createQueryRunner({
      dateFinSaisie: '2026-08-04',
      dateFinCalculee: false,
      dateFinSaisieConnue: true,
    });

    await expect(
      confirmOpenEndedPredecessor(queryRunner, options()),
    ).rejects.toThrow('provenance no longer matches an approved legacy state');
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
  });

  it('rejects confirmation when the predecessor range would be inverted', async () => {
    const queryRunner = createQueryRunner(legacyState, undefined, {
      predecessorStart: '2026-08-05',
    });

    await expect(
      confirmOpenEndedPredecessor(queryRunner, options()),
    ).rejects.toThrow('chain no longer matches the approved facts');
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it('rejects confirmation when a linked AC imposes an earlier end', async () => {
    const queryRunner = createQueryRunner(legacyState, undefined, {
      frameworkEnd: '2026-08-03',
    });

    await expect(
      confirmOpenEndedPredecessor(queryRunner, options()),
    ).rejects.toThrow('chain no longer matches the approved facts');
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it('rolls back if the guarded update loses its provenance precondition', async () => {
    const queryRunner = createQueryRunner(migrationState, [[], 0]);

    await expect(
      confirmOpenEndedPredecessor(queryRunner, options({ apply: true })),
    ).rejects.toThrow('guarded provenance update did not affect one row');
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
  });
});
