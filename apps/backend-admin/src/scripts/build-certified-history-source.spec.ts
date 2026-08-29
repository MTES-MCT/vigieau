import {
  CERTIFIED_HISTORY_PLAN,
  codeDigest,
  parseBuildCertifiedHistorySourceOptions,
  validateCommuneDay,
  validateDepartmentDay,
  validateStatisticDay,
} from './build-certified-history-source';

const part = CERTIFIED_HISTORY_PLAN[3];
const dumpSha256 = 'a'.repeat(64);

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CERTIFIED_HISTORY_BACKUP_DATABASE_URL:
      'postgresql://reader:test@127.0.0.1:55433/backup_aug27',
    CERTIFIED_HISTORY_ACCUMULATOR_DATABASE_URL:
      'postgresql://writer:test@127.0.0.1:55433/certified_accumulator',
    CERTIFIED_HISTORY_FROM: part.from,
    CERTIFIED_HISTORY_THROUGH: part.through,
    CERTIFIED_HISTORY_BACKUP_ID: part.backupId,
    CERTIFIED_HISTORY_DUMP_SHA256: dumpSha256,
    ...overrides,
  };
}

function departmentRestriction(date = part.from): Record<string, unknown> {
  const areas = {
    vigilance: 0,
    alerte: '1.25',
    alerte_renforcee: 2,
    crise: '0.00',
  };
  return {
    date,
    SOU: { ...areas },
    SUP: { ...areas },
    AEP: { ...areas },
  };
}

function departmentCodes(): string[] {
  return Array.from({ length: 101 }, (_, index) =>
    String(index).padStart(3, '0'),
  );
}

function statisticPayload(
  date = part.from,
  codes = departmentCodes(),
): Record<string, unknown> {
  return {
    date,
    visits: null,
    departementSituation: Object.fromEntries(
      codes.map((code) => [
        code,
        { max: null, sup: 'alerte', sou: null, aep: 'crise' },
      ]),
    ),
  };
}

describe('build-certified-history-source safeguards', () => {
  it('accepts only the audited backup/date mapping and two local databases', () => {
    expect(parseBuildCertifiedHistorySourceOptions(environment())).toEqual({
      sourceDatabaseUrl:
        'postgresql://reader:test@127.0.0.1:55433/backup_aug27',
      accumulatorDatabaseUrl:
        'postgresql://writer:test@127.0.0.1:55433/certified_accumulator',
      from: part.from,
      through: part.through,
      backupId: part.backupId,
      dumpSha256,
    });

    expect(() =>
      parseBuildCertifiedHistorySourceOptions(
        environment({ CERTIFIED_HISTORY_FROM: '2026-08-25' }),
      ),
    ).toThrow('must cover 2026-08-26/2026-08-26');
    expect(() =>
      parseBuildCertifiedHistorySourceOptions(
        environment({
          CERTIFIED_HISTORY_ACCUMULATOR_DATABASE_URL:
            'postgresql://writer:test@prod.example/certified',
        }),
      ),
    ).toThrow('loopback-only');
    expect(() =>
      parseBuildCertifiedHistorySourceOptions(
        environment({
          CERTIFIED_HISTORY_BACKUP_DATABASE_URL:
            'postgresql://reader:test@127.0.0.1:55433/backup_aug27?host=prod.example',
        }),
      ),
    ).toThrow('must not override host');
    expect(() =>
      parseBuildCertifiedHistorySourceOptions(
        environment({
          CERTIFIED_HISTORY_BACKUP_DATABASE_URL:
            'postgresql://reader:test@127.0.0.1:55433/backup_aug27?port=5432',
        }),
      ),
    ).toThrow('must not override port');
    expect(() =>
      parseBuildCertifiedHistorySourceOptions(
        environment({
          CERTIFIED_HISTORY_ACCUMULATOR_DATABASE_URL:
            'postgresql://writer:test@127.0.0.1:55433/backup_aug27',
        }),
      ),
    ).toThrow('must differ');
    expect(() =>
      parseBuildCertifiedHistorySourceOptions(
        environment({
          CERTIFIED_HISTORY_BACKUP_DATABASE_URL:
            'postgresql://reader:test@localhost:55433/backup_aug27',
          CERTIFIED_HISTORY_ACCUMULATOR_DATABASE_URL:
            'postgresql://writer:test@127.0.0.1:55433/backup_aug27',
        }),
      ),
    ).toThrow('must differ');
    expect(() =>
      parseBuildCertifiedHistorySourceOptions(
        environment({ CERTIFIED_HISTORY_DUMP_SHA256: 'ABC' }),
      ),
    ).toThrow('lowercase SHA256');
  });

  it('retains an explicit all-null commune day', () => {
    expect(
      validateCommuneDay(
        '77132',
        { date: part.from, SOU: null, SUP: null, AEP: null },
        part.from,
        part.through,
      ),
    ).toEqual({
      code: '77132',
      date: part.from,
      SOU: null,
      SUP: null,
      AEP: null,
    });
  });

  it('rejects missing, extra and invalid commune values instead of normalizing them', () => {
    expect(() =>
      validateCommuneDay(
        '77132',
        { date: part.from, SOU: null, SUP: null },
        part.from,
        part.through,
      ),
    ).toThrow('missing AEP');
    expect(() =>
      validateCommuneDay(
        '77132',
        {
          date: part.from,
          SOU: null,
          SUP: null,
          AEP: null,
          legacy: true,
        },
        part.from,
        part.through,
      ),
    ).toThrow('exactly date,SOU,SUP,AEP');
    expect(() =>
      validateCommuneDay(
        '77132',
        { date: part.from, SOU: 'grave', SUP: null, AEP: null },
        part.from,
        part.through,
      ),
    ).toThrow('invalid severity');
    expect(() =>
      validateCommuneDay(
        '77132',
        { date: '2026-02-30', SOU: null, SUP: null, AEP: null },
        '2026-02-01',
        '2026-03-01',
      ),
    ).toThrow('not a valid civil date');
  });

  it('validates the complete department payload and non-negative areas', () => {
    expect(
      validateDepartmentDay(
        '77',
        departmentRestriction(),
        part.from,
        part.through,
      ),
    ).toEqual({
      code: '77',
      date: part.from,
      restriction: departmentRestriction(),
    });
    const invalid = departmentRestriction();
    (invalid.SUP as Record<string, unknown>).crise = -1;
    expect(() =>
      validateDepartmentDay('77', invalid, part.from, part.through),
    ).toThrow('non-negative area');
  });

  it('requires one exact 101-department national situation with valid severities', () => {
    const codes = departmentCodes();
    expect(
      validateStatisticDay(
        part.from,
        statisticPayload(part.from, codes),
        codes,
        part.from,
        part.through,
      ).date,
    ).toBe(part.from);

    const missing = statisticPayload(part.from, codes);
    delete (missing.departementSituation as Record<string, unknown>)[codes[0]];
    expect(() =>
      validateStatisticDay(part.from, missing, codes, part.from, part.through),
    ).toThrow('department coverage mismatch');

    const invalid = statisticPayload(part.from, codes);
    (
      (invalid.departementSituation as Record<string, unknown>)[
        codes[0]
      ] as Record<string, unknown>
    ).max = 'catastrophe';
    expect(() =>
      validateStatisticDay(part.from, invalid, codes, part.from, part.through),
    ).toThrow('invalid severity');
  });

  it('computes a stable order-independent code digest', () => {
    expect(codeDigest(['77132', '01001'])).toBe(codeDigest(['01001', '77132']));
    expect(codeDigest(['01001', '77132'])).toMatch(/^[a-f0-9]{64}$/);
  });
});
