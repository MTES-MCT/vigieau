import {
  CERTIFIED_APPLY_TARGET_BATCH_SQL,
  CERTIFIED_INSPECT_TARGET_BATCH_SQL,
  CERTIFIED_SOURCE_BATCH_SQL,
  CERTIFIED_SOURCE_SCOPE_SQL,
  CertifiedSourceDay,
  assertCertifiedRangeAgainstPublicationContext,
  certifiedHistoryFingerprint,
  encodeCertifiedExecutionContext,
  parseRestoreCertifiedHistoryOptions,
  validateCertifiedSourceDays,
} from './restore-certified-commune-history';
import { RepairPublicationContext } from './restore-missing-commune-history';

const publicationContext: RepairPublicationContext = {
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

const requiredEnvironment = {
  CERTIFIED_HISTORY_SOURCE_RUN_ID:
    'vigieau-2026-07-11-2026-08-27-backup-repair-v1',
  CERTIFIED_HISTORY_FROM: '2026-07-11',
  CERTIFIED_HISTORY_THROUGH: '2026-08-27',
  CERTIFIED_HISTORY_EXPECTED_SOURCE_DATABASE: 'vigieau_certified_source',
  CERTIFIED_HISTORY_EXPECTED_TARGET_DATABASE: 'vigieau_production',
};

function twoDaySource(): Array<Record<string, unknown>> {
  return [
    {
      code: '77132',
      date: '2026-07-11',
      SOU: null,
      SUP: null,
      AEP: null,
    },
    {
      code: '77132',
      date: '2026-07-12',
      SOU: 'alerte',
      SUP: null,
      AEP: 'crise',
    },
  ];
}

describe('restore-certified-commune-history safeguards', () => {
  it('defaults to a read-only dry-run with short bounded batches', () => {
    expect(parseRestoreCertifiedHistoryOptions(requiredEnvironment)).toEqual({
      from: '2026-07-11',
      through: '2026-08-27',
      sourceRunId: 'vigieau-2026-07-11-2026-08-27-backup-repair-v1',
      batchSize: 20,
      communeCodes: null,
      apply: false,
      promotionRequested: false,
      expectedSourceDatabase: 'vigieau_certified_source',
      expectedTargetDatabase: 'vigieau_production',
      expectedPublicationContext: null,
      lockTimeoutMs: 250,
      statementTimeoutMs: 5_000,
      maxRetries: 5,
    });
  });

  it('requires an explicit confirmation and the dry-run token for apply', () => {
    expect(() =>
      parseRestoreCertifiedHistoryOptions({
        ...requiredEnvironment,
        CERTIFIED_HISTORY_APPLY: 'true',
      }),
    ).toThrow(
      'CERTIFIED_HISTORY_CONFIRMATION must equal RESTORE_CERTIFIED_COMMUNE_HISTORY',
    );
    expect(() =>
      parseRestoreCertifiedHistoryOptions({
        ...requiredEnvironment,
        CERTIFIED_HISTORY_APPLY: 'true',
        CERTIFIED_HISTORY_CONFIRMATION: 'RESTORE_CERTIFIED_COMMUNE_HISTORY',
      }),
    ).toThrow('CERTIFIED_HISTORY_EXPECTED_PUBLICATION_CONTEXT is required');
    const token = Buffer.from(JSON.stringify({ valid: true })).toString(
      'base64url',
    );
    expect(
      parseRestoreCertifiedHistoryOptions({
        ...requiredEnvironment,
        CERTIFIED_HISTORY_APPLY: 'true',
        CERTIFIED_HISTORY_CONFIRMATION: 'RESTORE_CERTIFIED_COMMUNE_HISTORY',
        CERTIFIED_HISTORY_EXPECTED_PUBLICATION_CONTEXT: token,
      }),
    ).toMatchObject({ apply: true, expectedPublicationContext: token });
  });

  it('refuses promotion and ambiguous databases', () => {
    expect(() =>
      parseRestoreCertifiedHistoryOptions({
        ...requiredEnvironment,
        CERTIFIED_HISTORY_PROMOTE: 'true',
      }),
    ).toThrow('Certified commune repair cannot promote');
    expect(() =>
      parseRestoreCertifiedHistoryOptions({
        ...requiredEnvironment,
        CERTIFIED_HISTORY_EXPECTED_SOURCE_DATABASE: 'same',
        CERTIFIED_HISTORY_EXPECTED_TARGET_DATABASE: 'same',
      }),
    ).toThrow('source and target databases must differ');
  });

  it('requires the explicit range to equal the complete dirty window', () => {
    expect(() =>
      assertCertifiedRangeAgainstPublicationContext(
        '2026-07-11',
        '2026-08-27',
        publicationContext,
      ),
    ).not.toThrow();
    expect(() =>
      assertCertifiedRangeAgainstPublicationContext(
        '2026-07-12',
        '2026-08-27',
        publicationContext,
      ),
    ).toThrow('must equal target dirty window');
    expect(() =>
      assertCertifiedRangeAgainstPublicationContext(
        '2026-07-11',
        '2026-08-29',
        {
          ...publicationContext,
          historicDirtyThrough: '2026-08-29',
        },
      ),
    ).toThrow('must end before the current statistic publication');
  });

  it('pins source fingerprint, databases and exact range in the apply token', () => {
    const options = parseRestoreCertifiedHistoryOptions(requiredEnvironment);
    const source = {
      sourceRunId: 'vigieau-2026-07-11-2026-08-27-backup-repair-v1',
      communeCount: 34_943,
      dayCount: 1_677_264,
      communeDigest: 'a'.repeat(64),
      sourceFingerprint: 'b'.repeat(64),
      provenanceDigest: 'c'.repeat(64),
    };
    const token = encodeCertifiedExecutionContext(
      publicationContext,
      options,
      source,
    );
    expect(
      JSON.parse(Buffer.from(token, 'base64url').toString('utf8')),
    ).toMatchObject({
      scope: {
        from: '2026-07-11',
        through: '2026-08-27',
        sourceRunId: 'vigieau-2026-07-11-2026-08-27-backup-repair-v1',
        sourceDatabase: 'vigieau_certified_source',
        targetDatabase: 'vigieau_production',
        communeCount: 34_943,
        dayCount: 1_677_264,
        sourceFingerprint: 'b'.repeat(64),
        provenanceDigest: 'c'.repeat(64),
      },
    });
  });
});

describe('certified source validation', () => {
  it('keeps an explicitly all-null day and accepts only complete coverage', () => {
    expect(
      validateCertifiedSourceDays(twoDaySource(), '2026-07-11', '2026-07-12'),
    ).toHaveLength(2);
    expect(() =>
      validateCertifiedSourceDays(
        twoDaySource().slice(0, 1),
        '2026-07-11',
        '2026-07-12',
      ),
    ).toThrow('coverage mismatch');
  });

  it('rejects duplicates, missing fields and unknown severities', () => {
    expect(() =>
      validateCertifiedSourceDays(
        [...twoDaySource(), twoDaySource()[0]],
        '2026-07-11',
        '2026-07-12',
      ),
    ).toThrow('Duplicate certified source day');
    const missing = twoDaySource();
    delete missing[0].AEP;
    expect(() =>
      validateCertifiedSourceDays(missing, '2026-07-11', '2026-07-12'),
    ).toThrow('Certified source value 77132/2026-07-11/AEP is missing');
    const invalid = twoDaySource();
    invalid[0].SUP = 'unknown';
    expect(() =>
      validateCertifiedSourceDays(invalid, '2026-07-11', '2026-07-12'),
    ).toThrow('Invalid source severity');
  });

  it('uses a stable SHA-256 fingerprint including null values', () => {
    const days = validateCertifiedSourceDays(
      twoDaySource(),
      '2026-07-11',
      '2026-07-12',
    );
    const reversed = [...days].reverse();
    expect(certifiedHistoryFingerprint(days)).toMatch(/^[a-f0-9]{64}$/);
    expect(certifiedHistoryFingerprint(days)).toBe(
      certifiedHistoryFingerprint(reversed),
    );
    expect(
      certifiedHistoryFingerprint([
        { ...days[0], SUP: 'crise' },
        days[1],
      ] as CertifiedSourceDay[]),
    ).not.toBe(certifiedHistoryFingerprint(days));
  });
});

describe('certified exact PostgreSQL plan', () => {
  it('extracts every day including all-null and certifies full coverage', () => {
    expect(CERTIFIED_SOURCE_BATCH_SQL).toContain(
      'certified_history_commune_day',
    );
    expect(CERTIFIED_SOURCE_BATCH_SQL).toContain('day."AEP"');
    expect(CERTIFIED_SOURCE_SCOPE_SQL).toContain(
      'certified_history_source_run',
    );
    expect(CERTIFIED_SOURCE_SCOPE_SQL).toContain('sha256');
    expect(CERTIFIED_SOURCE_SCOPE_SQL).toContain('"dateDigest"');
  });

  it('keeps dry-run SQL free of writes and apply SQL exact and CAS-protected', () => {
    expect(CERTIFIED_INSPECT_TARGET_BATCH_SQL).not.toMatch(/\bUPDATE\b/);
    expect(CERTIFIED_INSPECT_TARGET_BATCH_SQL).not.toMatch(/\bINSERT\b/);
    expect(CERTIFIED_APPLY_TARGET_BATCH_SQL).toContain('\'SOU\', source."SOU"');
    expect(CERTIFIED_APPLY_TARGET_BATCH_SQL).toContain('\'SUP\', source."SUP"');
    expect(CERTIFIED_APPLY_TARGET_BATCH_SQL).toContain('\'AEP\', source."AEP"');
    expect(CERTIFIED_APPLY_TARGET_BATCH_SQL).toContain(
      'IS NOT DISTINCT FROM prepared."originalRestrictions"',
    );
    expect(CERTIFIED_APPLY_TARGET_BATCH_SQL).toContain('monthly_weights');
    expect(CERTIFIED_APPLY_TARGET_BATCH_SQL).toContain('jsonb_object_keys');
    expect(CERTIFIED_APPLY_TARGET_BATCH_SQL).not.toContain(
      'statistic_publication_state',
    );
    expect(CERTIFIED_APPLY_TARGET_BATCH_SQL).not.toContain('historicDirtyFrom');
  });
});
