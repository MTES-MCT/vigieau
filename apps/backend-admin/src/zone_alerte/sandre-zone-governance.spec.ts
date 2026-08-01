import {
  isSandreBlockedRetryDue,
  isStrictOneToOneGeometry,
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
