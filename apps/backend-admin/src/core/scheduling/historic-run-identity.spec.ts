import {
  buildHistoricRunIdentity,
  buildHistoricRunIdentityFromConfig,
  normalizeHistoricCursorDate,
} from './historic-run-identity';

describe('historic run identity', () => {
  it('builds the same normalized identity from persisted config values', () => {
    expect(
      buildHistoricRunIdentityFromConfig(
        {
          computeMapDate: new Date('2026-07-31T00:00:00.000Z'),
          computeStatsDate: '2026-07-31T12:00:00.000Z',
          computeMapGeneration: 12,
          computeStatsGeneration: '8',
        },
        { sourceRevision: '42', materializationVersion: 3 },
      ),
    ).toEqual({
      sourceRevision: '42',
      materializationVersion: 3,
      historicMapCursor: '2026-07-31',
      historicStatsCursor: '2026-07-31',
      historicMapGeneration: '12',
      historicStatsGeneration: '8',
    });
  });

  it('builds a legacy identity from worker state without optional context', () => {
    expect(
      buildHistoricRunIdentity({
        mapCursor: '2026-07-31',
        statsCursor: null,
        mapGeneration: '13',
        statsGeneration: undefined,
      }),
    ).toEqual({
      historicMapCursor: '2026-07-31',
      historicStatsCursor: null,
      historicMapGeneration: '13',
      historicStatsGeneration: '0',
    });
  });

  it('rejects an invalid persisted cursor date', () => {
    expect(() => normalizeHistoricCursorDate('2026-02-30')).toThrow(
      'Invalid historic cursor date: 2026-02-30',
    );
  });
});
