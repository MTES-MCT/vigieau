import {
  CERTIFIED_HISTORY_PLAN,
  CERTIFIED_HISTORY_V2_CODE_COMMIT,
  CERTIFIED_HISTORY_V2_CORRECTION_SOURCE,
  CERTIFIED_HISTORY_V2_CORRECTIONS,
  CERTIFIED_HISTORY_V2_FINAL_BACKUP_SHA256,
  CERTIFIED_HISTORY_V2_GEOMETRY_EVIDENCE_FINGERPRINT,
  CERTIFIED_HISTORY_V2_PARENT_COMMUNE_DELTA,
  CERTIFIED_HISTORY_V2_PLAN,
  CERTIFIED_HISTORY_V2_SOURCE_RUN_ID,
  CERTIFIED_HISTORY_V2_VARIANT,
  certifiedSourceFingerprint,
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

  it('keeps v1 as the default and requires the exact fail-closed v2 selector', () => {
    const finalPart = CERTIFIED_HISTORY_V2_PLAN.at(-1)!;
    const v2Environment = environment({
      CERTIFIED_HISTORY_SOURCE_VARIANT: CERTIFIED_HISTORY_V2_VARIANT,
      CERTIFIED_HISTORY_FROM: finalPart.from,
      CERTIFIED_HISTORY_THROUGH: finalPart.through,
      CERTIFIED_HISTORY_BACKUP_ID: finalPart.backupId,
      CERTIFIED_HISTORY_DUMP_SHA256: CERTIFIED_HISTORY_V2_FINAL_BACKUP_SHA256,
    });
    expect(parseBuildCertifiedHistorySourceOptions(v2Environment)).toEqual({
      sourceDatabaseUrl:
        'postgresql://reader:test@127.0.0.1:55433/backup_aug27',
      accumulatorDatabaseUrl:
        'postgresql://writer:test@127.0.0.1:55433/certified_accumulator',
      from: '2026-08-28',
      through: '2026-08-31',
      backupId: '6a97672299826944b38141dd',
      dumpSha256: CERTIFIED_HISTORY_V2_FINAL_BACKUP_SHA256,
      variant: CERTIFIED_HISTORY_V2_VARIANT,
    });

    expect(() =>
      parseBuildCertifiedHistorySourceOptions(
        environment({
          CERTIFIED_HISTORY_SOURCE_VARIANT: 'v2',
        }),
      ),
    ).toThrow(`must equal ${CERTIFIED_HISTORY_V2_VARIANT}`);
    expect(() =>
      parseBuildCertifiedHistorySourceOptions({
        ...v2Environment,
        CERTIFIED_HISTORY_SOURCE_VARIANT: undefined,
      }),
    ).toThrow('Unknown certified backup 6a97672299826944b38141dd');
    expect(() =>
      parseBuildCertifiedHistorySourceOptions({
        ...v2Environment,
        CERTIFIED_HISTORY_DUMP_SHA256: 'b'.repeat(64),
      }),
    ).toThrow('not the audited artifact');
    expect(() =>
      parseBuildCertifiedHistorySourceOptions(
        environment({
          CERTIFIED_HISTORY_SOURCE_VARIANT: CERTIFIED_HISTORY_V2_VARIANT,
        }),
      ),
    ).toThrow('only from the audited final clone and inherited v1 parts');
  });

  it('freezes the incident-specific v2 plan, commit and correction manifest', () => {
    expect(CERTIFIED_HISTORY_V2_SOURCE_RUN_ID).toBe(
      'vigieau-2026-07-11-2026-08-31-isolated-recompute-v2',
    );
    expect(CERTIFIED_HISTORY_V2_CODE_COMMIT).toBe(
      '7bd55680297c2f85b4baa08792eab9eefc0578a0',
    );
    expect(CERTIFIED_HISTORY_V2_PLAN).toEqual([
      ...CERTIFIED_HISTORY_PLAN,
      {
        backupId: '6a97672299826944b38141dd',
        from: '2026-08-28',
        through: '2026-08-31',
      },
    ]);
    expect(CERTIFIED_HISTORY_V2_CORRECTIONS).toEqual([
      {
        correctionId: 'pa64-level-37316',
        departmentCode: '64',
        from: '2026-07-17',
        through: '2026-08-31',
        reason: 'certified-human-level-correction',
        arreteId: 37316,
        restrictionIds: [98039, 98040],
        zoneIds: [14768, 14771],
        fromLevel: 'alerte',
        toLevel: 'alerte_renforcee',
        areaKm2: '266.97',
      },
      {
        correctionId: 'd64-late-import-37695',
        departmentCode: '64',
        from: '2026-08-12',
        through: '2026-08-12',
        reason: 'late-decree-import',
        arreteId: 37695,
        predecessorArreteId: 37627,
        restrictionIds: [105191, 105192],
        zoneIds: [14732, 14744],
        departmentAreaFromLevel: 'alerte',
        departmentAreaToLevel: 'vigilance',
        areaKm2: '30.47',
        sourceCreatedAt: '2026-08-13 06:43:51.290354',
        sourceUpdatedAt: '2026-08-13 06:44:10.812809',
      },
      {
        correctionId: 'd15-late-import-37897',
        departmentCode: '15',
        from: '2026-08-31',
        through: '2026-08-31',
        reason: 'late-decree-import',
        arreteId: 37897,
        predecessorArreteId: 37699,
        restrictionIdFrom: 108365,
        restrictionIdThrough: 108390,
        restrictionCount: 26,
        restrictionDigest:
          '29f346d995c1dcb0bbd276d346c08c253caa6529d1464ea1df331e12aca641f4',
      },
      {
        correctionId: 'd68-late-import-37898',
        departmentCode: '68',
        from: '2026-08-31',
        through: '2026-08-31',
        reason: 'late-decree-import',
        arreteId: 37898,
        predecessorArreteId: 37360,
        restrictionIds: [108391],
        zoneIds: [15475],
        restrictionDigest:
          '9ab098385094defe01be15c06abea5a6cfea01914e8ff801866c3bf4de1b56ae',
      },
    ]);
    expect(CERTIFIED_HISTORY_V2_GEOMETRY_EVIDENCE_FINGERPRINT).toBe(
      '2def5d18ad10a61c173ab25c8b69003dadc5a2387333abc749eb31ddb6c1abdb',
    );
    expect(CERTIFIED_HISTORY_V2_CORRECTION_SOURCE).toMatchObject({
      backupId: '6a97672299826944b38141dd',
      dumpSha256: CERTIFIED_HISTORY_V2_FINAL_BACKUP_SHA256,
      correctionArreteIds: [37316, 37695, 37897, 37898],
      geometryEvidenceFingerprint:
        CERTIFIED_HISTORY_V2_GEOMETRY_EVIDENCE_FINGERPRINT,
      operatorCommuneDelta: {
        departmentCode: '64',
        changedPayloadCount: 486,
      },
    });
    expect(CERTIFIED_HISTORY_V2_PARENT_COMMUNE_DELTA).toMatchObject({
      changedPayloadCount: 462,
      changedCommuneCount: 12,
      changedDateCount: 42,
      changedCommuneDigest:
        '8921260cf3c007af711eec35d2079be7a1fba06e3cae8a5080ec878be5687d21',
    });
  });

  it('uses the same canonical parent fingerprint field order as completion', () => {
    const input = {
      communeDigest: 'a'.repeat(64),
      communeHistoryDigest: 'b'.repeat(64),
      departmentDigest: 'c'.repeat(64),
      departmentHistoryDigest: 'd'.repeat(64),
      statisticDigest: 'e'.repeat(64),
      provenanceDigest: 'f'.repeat(64),
    };
    expect(certifiedSourceFingerprint(input)).toBe(
      '54bcec2670c1ae53ead3d4484fe287e2fc6b1680067b2881c23ae401f5d5648b',
    );
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
