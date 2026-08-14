import {
  DEFAULT_STATISTIC_PUBLICATION_DEADLINE,
  getPublicationLagDays,
  getStatisticPublicationExpectation,
} from './statistic-publication-freshness';

describe('statistic publication freshness', () => {
  it('expects yesterday before the default Paris deadline', () => {
    expect(
      getStatisticPublicationExpectation(new Date('2026-08-14T03:59:00.000Z')),
    ).toEqual({
      today: '2026-08-14',
      expectedPublishedDate: '2026-08-13',
      deadline: DEFAULT_STATISTIC_PUBLICATION_DEADLINE,
      afterDeadline: false,
    });
  });

  it('expects today from the configured Paris deadline', () => {
    expect(
      getStatisticPublicationExpectation(
        new Date('2026-08-14T03:30:00.000Z'),
        '05:30',
      ),
    ).toEqual({
      today: '2026-08-14',
      expectedPublishedDate: '2026-08-14',
      deadline: '05:30',
      afterDeadline: true,
    });
  });

  it('uses the Europe/Paris civil date across the winter offset', () => {
    expect(
      getStatisticPublicationExpectation(new Date('2026-01-02T05:00:00.000Z')),
    ).toEqual(
      expect.objectContaining({
        today: '2026-01-02',
        expectedPublishedDate: '2026-01-02',
        afterDeadline: true,
      }),
    );
  });

  it('reports lag relative to the expected publication date', () => {
    expect(getPublicationLagDays('2026-08-13', '2026-08-14')).toBe(1);
    expect(getPublicationLagDays('2026-08-14', '2026-08-14')).toBe(0);
    expect(getPublicationLagDays('2026-08-14', '2026-08-13')).toBe(0);
    expect(getPublicationLagDays(null, '2026-08-14')).toBeNull();
  });

  it.each(['6:00', '24:00', '06:60'])(
    'rejects invalid deadline %s',
    (value) => {
      expect(() =>
        getStatisticPublicationExpectation(new Date(), value),
      ).toThrow('STATISTIC_PUBLICATION_DEADLINE');
    },
  );
});
