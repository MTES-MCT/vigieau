import {
  isSandreBlockedRetryDue,
  isStrictOneToOneGeometry,
  parseSandreForceFullAuditAfter,
  parseSandreZoneSyncMode,
  SANDRE_BLOCKED_RETRY_INTERVAL_MS,
  STRICT_GEOMETRY_THRESHOLDS,
} from './sandre-zone-governance';

describe('Sandre zone governance', () => {
  it('defaults to paused and accepts only the three explicit modes', () => {
    expect(parseSandreZoneSyncMode(undefined)).toBe('paused');
    expect(parseSandreZoneSyncMode(' audit ')).toBe('audit');
    expect(parseSandreZoneSyncMode('safe')).toBe('safe');
    expect(parseSandreZoneSyncMode('enabled')).toBeNull();
  });

  it('parses only explicit ISO UTC forced-audit cutoffs', () => {
    expect(parseSandreForceFullAuditAfter(undefined)).toBeNull();
    expect(parseSandreForceFullAuditAfter('   ')).toBeNull();
    expect(
      parseSandreForceFullAuditAfter(
        '2026-08-02T12:00:00Z',
        new Date('2026-08-02T13:00:00Z'),
      ),
    ).toEqual(new Date('2026-08-02T12:00:00Z'));
    expect(
      parseSandreForceFullAuditAfter(
        '2026-08-02T12:00:00.123Z',
        new Date('2026-08-02T13:00:00Z'),
      ),
    ).toEqual(new Date('2026-08-02T12:00:00.123Z'));
    expect(() => parseSandreForceFullAuditAfter('2026-08-02 12:00:00')).toThrow(
      'SANDRE_FORCE_FULL_AUDIT_AFTER',
    );
    expect(() =>
      parseSandreForceFullAuditAfter('2026-02-30T12:00:00Z'),
    ).toThrow('SANDRE_FORCE_FULL_AUDIT_AFTER');
    expect(() =>
      parseSandreForceFullAuditAfter(
        '2026-08-02T14:00:00Z',
        new Date('2026-08-02T13:00:00Z'),
      ),
    ).toThrow('must not be in the future');
  });

  it('accepts a strict unambiguous one-to-one geometry', () => {
    expect(
      isStrictOneToOneGeometry({
        sourceCoverage: STRICT_GEOMETRY_THRESHOLDS.sourceCoverage,
        targetCoverage: STRICT_GEOMETRY_THRESHOLDS.targetCoverage,
        iou: STRICT_GEOMETRY_THRESHOLDS.iou,
        secondIou: 0,
        secondSourceCoverage: 0,
      }),
    ).toBe(true);
  });

  it('rejects a candidate when another active zone also covers the source', () => {
    expect(
      isStrictOneToOneGeometry({
        sourceCoverage: 0.999,
        targetCoverage: 0.999,
        iou: 0.98,
        secondIou: 0.02,
        secondSourceCoverage: 0.999,
      }),
    ).toBe(false);
  });

  it('retries a blocked department after the short retry interval', () => {
    const now = new Date('2026-08-01T12:00:00.000Z').getTime();

    expect(
      isSandreBlockedRetryDue(
        new Date(now - SANDRE_BLOCKED_RETRY_INTERVAL_MS),
        now,
      ),
    ).toBe(true);
    expect(
      isSandreBlockedRetryDue(
        new Date(now - SANDRE_BLOCKED_RETRY_INTERVAL_MS + 1),
        now,
      ),
    ).toBe(false);
    expect(isSandreBlockedRetryDue(null, now)).toBe(false);
    expect(isSandreBlockedRetryDue('not-a-date', now)).toBe(false);
  });
});
