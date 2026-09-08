import {
  ArreteComputationState,
  getArreteHistoricStatisticRanges,
  getArreteLifecycleStatus,
  getCurrentParisCivilDate,
  getPredecessorEndDateConstraint,
  getPublicationEndDateProvenance,
  getReconciledArreteLifecycleStatus,
  hasArreteComputationStateChanged,
  hasArretePublicationStateChanged,
  normalizeCivilDate,
  resolveArreteEndDate,
  UnknownArreteEndDateProvenanceError,
} from './arrete-date-continuity';

describe('arrete date continuity', () => {
  describe('getArreteHistoricStatisticRanges', () => {
    const state = (
      dateDebut: string | null = '2026-07-11',
      dateFin: string | null = '2026-08-20',
      statut: ArreteComputationState['statut'] = 'publie',
    ): ArreteComputationState => ({ dateDebut, dateFin, statut });

    it.each([
      ['publie', 'publie'],
      ['publie', 'abroge'],
      ['abroge', 'publie'],
      ['abroge', 'abroge'],
    ] as const)(
      'keeps an identical %s to %s historical interval',
      (before, after) => {
        expect(
          getArreteHistoricStatisticRanges(
            state('2026-07-11', '2026-08-20', before),
            state('2026-07-11', '2026-08-20', after),
          ),
        ).toEqual([]);
      },
    );

    it('preserves the status change guard even when historic statistic days are identical', () => {
      const before = state('2026-07-11', '2026-08-20', 'publie');
      const after = state('2026-07-11', '2026-08-20', 'abroge');
      expect(hasArreteComputationStateChanged(before, after)).toBe(true);
      expect(getArreteHistoricStatisticRanges(before, after)).toEqual([]);
    });

    it('bounds the impact of changing only the start of an open-ended interval', () => {
      expect(
        getArreteHistoricStatisticRanges(
          state('2026-07-11', null),
          state('2026-07-15', null),
        ),
      ).toEqual([{ from: '2026-07-11', through: '2026-07-14' }]);
    });

    it.each([
      ['2026-08-20', '2026-08-25', '2026-08-21', '2026-08-25'],
      ['2026-08-25', '2026-08-20', '2026-08-21', '2026-08-25'],
      ['2026-08-20', null, '2026-08-21', null],
      [null, '2026-08-20', '2026-08-21', null],
      ['2026-08-31', '2026-09-01', '2026-09-01', '2026-09-01'],
    ])(
      'limits the change from end %s to %s',
      (before, after, from, through) => {
        expect(
          getArreteHistoricStatisticRanges(
            state('2026-07-11', before),
            state('2026-07-11', after),
          ),
        ).toEqual([{ from, through }]);
      },
    );

    it('handles two changed boundaries without invalidating their common days', () => {
      expect(
        getArreteHistoricStatisticRanges(
          state('2026-07-11', '2026-08-20'),
          state('2026-07-15', '2026-08-25'),
        ),
      ).toEqual([
        { from: '2026-07-11', through: '2026-07-14' },
        { from: '2026-08-21', through: '2026-08-25' },
      ]);
    });

    it('keeps disjoint ranges separate, but merges adjacent changed days', () => {
      expect(
        getArreteHistoricStatisticRanges(
          state('2026-07-11', '2026-07-15'),
          state('2026-07-20', '2026-07-25'),
        ),
      ).toEqual([
        { from: '2026-07-11', through: '2026-07-15' },
        { from: '2026-07-20', through: '2026-07-25' },
      ]);
      expect(
        getArreteHistoricStatisticRanges(
          state('2026-07-11', '2026-07-15'),
          state('2026-07-16', '2026-07-20'),
        ),
      ).toEqual([{ from: '2026-07-11', through: '2026-07-20' }]);
    });

    it.each(['a_valider', 'a_venir'] as const)(
      'adds or removes the whole interval for a transition involving %s',
      (inactiveStatus) => {
        const inactive = state('2026-07-11', '2026-08-20', inactiveStatus);
        const active = state();
        expect(getArreteHistoricStatisticRanges(inactive, active)).toEqual([
          { from: '2026-07-11', through: '2026-08-20' },
        ]);
        expect(getArreteHistoricStatisticRanges(active, inactive)).toEqual([
          { from: '2026-07-11', through: '2026-08-20' },
        ]);
      },
    );

    it('supports creation, deletion and incomplete inactive drafts', () => {
      expect(getArreteHistoricStatisticRanges(null, state())).toEqual([
        { from: '2026-07-11', through: '2026-08-20' },
      ]);
      expect(getArreteHistoricStatisticRanges(state(), null)).toEqual([
        { from: '2026-07-11', through: '2026-08-20' },
      ]);
      expect(
        getArreteHistoricStatisticRanges(
          state(null, null, 'a_valider'),
          state('2026-07-11', null, 'a_venir'),
        ),
      ).toEqual([]);
    });

    it.each([state(null), state('2026-08-21', '2026-08-20')])(
      'treats an empty legacy active interval like the historic SQL predicate: %p',
      (emptyState) => {
        expect(getArreteHistoricStatisticRanges(emptyState, state())).toEqual([
          { from: '2026-07-11', through: '2026-08-20' },
        ]);
        expect(getArreteHistoricStatisticRanges(state(), emptyState)).toEqual([
          { from: '2026-07-11', through: '2026-08-20' },
        ]);
        expect(getArreteHistoricStatisticRanges(null, emptyState)).toEqual([]);
      },
    );

    it('normalizes civil dates and preserves inclusive leap-day and year boundaries', () => {
      expect(
        getArreteHistoricStatisticRanges(
          state('2024-02-01T12:00:00.000Z', '2024-02-28'),
          state('2024-02-01', '2024-03-01'),
        ),
      ).toEqual([{ from: '2024-02-29', through: '2024-03-01' }]);
      expect(
        getArreteHistoricStatisticRanges(
          state('2025-01-01', '2025-12-31'),
          state('2025-01-01', '2026-01-01'),
        ),
      ).toEqual([{ from: '2026-01-01', through: '2026-01-01' }]);
    });

    it('never reaches unchanged July dates during successive September replacements', () => {
      let before = state('2026-07-11', null);
      for (const dateFin of ['2026-09-07', '2026-09-14', '2026-09-06']) {
        const after = state('2026-07-11', dateFin, 'abroge');
        expect(
          getArreteHistoricStatisticRanges(before, after).every(
            ({ from }) => from >= '2026-09-07',
          ),
        ).toBe(true);
        before = after;
      }
    });

    it.each([
      state(''),
      state('2026-02-29'),
      state('2026-07-11', ''),
      state('2026-07-11', 'invalid'),
      state('invalid', null, 'a_valider'),
    ])(
      'rejects an invalid state instead of silently shrinking the impact: %p',
      (invalid) => {
        expect(() =>
          getArreteHistoricStatisticRanges(state(), invalid),
        ).toThrow();
        expect(() =>
          getArreteHistoricStatisticRanges(invalid, state()),
        ).toThrow();
      },
    );
  });

  describe('normalizeCivilDate', () => {
    it.each([
      ['2026-08-05', '2026-08-05'],
      ['2026-08-05T12:30:00.000Z', '2026-08-05'],
      ['2024-02-29T23:00:00+02:00', '2024-02-29'],
    ])('normalizes %p to %p', (date, expected) => {
      expect(normalizeCivilDate(date)).toBe(expected);
    });

    it.each(['', '2026-8-05', '2026-02-29', '2026-02-31'])(
      'rejects invalid civil date %p',
      (date) => {
        expect(() => normalizeCivilDate(date)).toThrow(
          `Invalid civil date: ${date}`,
        );
      },
    );
  });

  describe('getPredecessorEndDateConstraint', () => {
    it.each([
      [['2026-08-05'], '2026-08-04'],
      [['2026-08-10', '2026-08-05'], '2026-08-04'],
      [['2026-03-01'], '2026-02-28'],
      [['2024-03-01'], '2024-02-29'],
      [['2026-01-01'], '2025-12-31'],
      [[], null],
    ])(
      'returns the earliest successor constraint for %p',
      (dates, expected) => {
        expect(getPredecessorEndDateConstraint(dates)).toBe(expected);
      },
    );
  });

  describe('resolveArreteEndDate', () => {
    it('tracks and moves an automatically calculated open-ended date', () => {
      const first = resolveArreteEndDate(
        {
          dateFin: null,
          dateFinSaisie: null,
          dateFinCalculee: false,
          dateFinSaisieConnue: true,
        },
        ['2026-08-03'],
      );
      expect(first).toEqual({
        dateFin: '2026-08-03',
        dateFinSaisie: null,
        dateFinCalculee: true,
        dateFinSaisieConnue: true,
      });

      expect(resolveArreteEndDate(first, ['2026-08-04'])).toEqual({
        dateFin: '2026-08-04',
        dateFinSaisie: null,
        dateFinCalculee: true,
        dateFinSaisieConnue: true,
      });
    });

    it('never extends beyond the original entered end date', () => {
      expect(
        resolveArreteEndDate(
          {
            dateFin: '2026-08-04',
            dateFinSaisie: '2026-08-10',
            dateFinCalculee: true,
            dateFinSaisieConnue: true,
          },
          ['2026-08-19'],
        ),
      ).toEqual({
        dateFin: '2026-08-10',
        dateFinSaisie: null,
        dateFinCalculee: false,
        dateFinSaisieConnue: true,
      });
    });

    it('keeps tracking a later legal end while a constraint remains tighter', () => {
      expect(
        resolveArreteEndDate(
          {
            dateFin: '2026-08-04',
            dateFinSaisie: '2026-08-10',
            dateFinCalculee: true,
            dateFinSaisieConnue: true,
          },
          ['2026-08-06'],
        ),
      ).toEqual({
        dateFin: '2026-08-06',
        dateFinSaisie: '2026-08-10',
        dateFinCalculee: true,
        dateFinSaisieConnue: true,
      });
    });

    it('preserves an explicit end before the replacement constraint', () => {
      expect(
        resolveArreteEndDate(
          {
            dateFin: '2026-08-02',
            dateFinSaisie: null,
            dateFinCalculee: false,
            dateFinSaisieConnue: true,
          },
          ['2026-08-04'],
        ),
      ).toEqual({
        dateFin: '2026-08-02',
        dateFinSaisie: null,
        dateFinCalculee: false,
        dateFinSaisieConnue: true,
      });
    });

    it('rejects an extension when the original end is unknown', () => {
      expect(() =>
        resolveArreteEndDate(
          {
            dateFin: '2026-08-03',
            dateFinSaisie: null,
            dateFinCalculee: true,
            dateFinSaisieConnue: false,
          },
          ['2026-08-04'],
        ),
      ).toThrow(UnknownArreteEndDateProvenanceError);
    });

    it('rejects an extension when a legacy import kept its conservative end as source', () => {
      expect(() =>
        resolveArreteEndDate(
          {
            dateFin: '2026-08-03',
            dateFinSaisie: '2026-08-03',
            dateFinCalculee: true,
            dateFinSaisieConnue: false,
          },
          ['2026-08-04'],
        ),
      ).toThrow(UnknownArreteEndDateProvenanceError);
    });

    it('rejects shortening an unknown legacy boundary', () => {
      expect(() =>
        resolveArreteEndDate(
          {
            dateFin: '2026-08-04',
            dateFinSaisie: '2026-08-04',
            dateFinCalculee: true,
            dateFinSaisieConnue: false,
          },
          ['2026-08-03'],
        ),
      ).toThrow(UnknownArreteEndDateProvenanceError);
    });

    it('rejects restoring an unknown legacy boundary', () => {
      expect(() =>
        resolveArreteEndDate(
          {
            dateFin: '2026-08-03',
            dateFinSaisie: '2026-08-04',
            dateFinCalculee: true,
            dateFinSaisieConnue: false,
          },
          ['2026-08-04'],
        ),
      ).toThrow(UnknownArreteEndDateProvenanceError);
    });

    it('keeps a conservative legacy end during scheduled reconciliation', () => {
      expect(
        resolveArreteEndDate(
          {
            dateFin: '2026-08-03',
            dateFinSaisie: null,
            dateFinCalculee: true,
            dateFinSaisieConnue: false,
          },
          ['2026-08-04'],
          { rejectUnknownExtension: false },
        ),
      ).toEqual({
        dateFin: '2026-08-03',
        dateFinSaisie: null,
        dateFinCalculee: true,
        dateFinSaisieConnue: false,
      });
    });

    it('does not shorten an unknown legacy boundary during scheduled reconciliation', () => {
      expect(
        resolveArreteEndDate(
          {
            dateFin: '2026-08-04',
            dateFinSaisie: '2026-08-04',
            dateFinCalculee: true,
            dateFinSaisieConnue: false,
          },
          ['2026-08-03'],
          { rejectUnknownExtension: false },
        ),
      ).toEqual({
        dateFin: '2026-08-04',
        dateFinSaisie: '2026-08-04',
        dateFinCalculee: true,
        dateFinSaisieConnue: false,
      });
    });
  });

  describe('publication provenance', () => {
    it('preserves an automatic source when the effective end is unchanged', () => {
      expect(
        getPublicationEndDateProvenance(
          {
            dateFin: '2026-08-04',
            dateFinSaisie: null,
            dateFinCalculee: true,
            dateFinSaisieConnue: true,
          },
          '2026-08-04',
        ),
      ).toEqual({
        dateFinSaisie: null,
        dateFinCalculee: true,
        dateFinSaisieConnue: true,
      });
    });

    it('preserves unknown legacy provenance on an identical republication', () => {
      expect(
        getPublicationEndDateProvenance(
          {
            dateFin: '2026-08-03',
            dateFinSaisie: '2026-08-04',
            dateFinCalculee: true,
            dateFinSaisieConnue: false,
          },
          '2026-08-03',
        ),
      ).toEqual({
        dateFinSaisie: '2026-08-04',
        dateFinCalculee: true,
        dateFinSaisieConnue: false,
      });
    });

    it('records a changed end as an explicit source', () => {
      expect(
        getPublicationEndDateProvenance(
          {
            dateFin: '2026-08-04',
            dateFinSaisie: null,
            dateFinCalculee: true,
            dateFinSaisieConnue: true,
          },
          '2026-08-06',
        ),
      ).toEqual({
        dateFinSaisie: null,
        dateFinCalculee: false,
        dateFinSaisieConnue: true,
      });
    });
  });

  describe('computation impact', () => {
    it('ignores provenance-only changes', () => {
      expect(
        hasArreteComputationStateChanged(
          {
            dateDebut: '2026-08-01',
            dateFin: '2026-08-04',
            statut: 'publie',
          },
          {
            dateDebut: '2026-08-01T00:00:00.000Z',
            dateFin: '2026-08-04T00:00:00.000Z',
            statut: 'publie',
          },
        ),
      ).toBe(false);
    });

    it('detects a draft publication with previously empty dates', () => {
      expect(
        hasArreteComputationStateChanged(
          { dateDebut: null, dateFin: null, statut: 'a_valider' },
          { dateDebut: '2026-08-05', dateFin: null, statut: 'a_venir' },
        ),
      ).toBe(true);
    });

    it('detects a provenance-only public change', () => {
      expect(
        hasArretePublicationStateChanged(
          {
            dateDebut: '2026-08-01',
            dateFin: '2026-08-04',
            dateFinSaisie: '2026-08-10',
            dateFinCalculee: true,
            dateFinSaisieConnue: true,
            statut: 'publie',
          },
          {
            dateDebut: '2026-08-01',
            dateFin: '2026-08-04',
            dateFinSaisie: '2026-08-12',
            dateFinCalculee: true,
            dateFinSaisieConnue: true,
            statut: 'publie',
          },
        ),
      ).toBe(true);
    });
  });

  describe('getArreteLifecycleStatus', () => {
    it.each([
      ['2026-08-05', null, '2026-08-04', 'a_venir'],
      ['2026-08-04', null, '2026-08-04', 'publie'],
      ['2026-08-01', '2026-08-04', '2026-08-04', 'publie'],
      ['2026-08-01', '2026-08-03', '2026-08-04', 'abroge'],
    ])(
      'returns the expected status for %p through %p on %p',
      (dateDebut, dateFin, businessDate, expected) => {
        expect(getArreteLifecycleStatus(dateDebut, dateFin, businessDate)).toBe(
          expected,
        );
      },
    );
  });

  describe('getReconciledArreteLifecycleStatus', () => {
    it('preserves an explicitly repealed legacy order without any end evidence', () => {
      expect(
        getReconciledArreteLifecycleStatus(
          {
            dateDebut: '2011-06-07',
            dateFin: null,
            dateFinCalculee: false,
            resolvedDateFin: null,
            statut: 'abroge',
          },
          '2026-08-05',
        ),
      ).toBe('abroge');
    });

    it.each([
      ['abroge', '2026-08-03', true, '2026-08-09', 'publie'],
      ['abroge', null, false, '2026-08-09', 'publie'],
      ['abroge', '2050-12-31', false, '2050-12-31', 'abroge'],
      ['abroge', '2050-12-31', false, '2026-08-09', 'publie'],
      ['abroge', '2026-08-05', false, '2026-08-05', 'publie'],
      ['a_venir', null, false, null, 'publie'],
      ['publie', null, false, null, 'publie'],
      ['publie', '2026-08-03', false, '2026-08-03', 'abroge'],
    ] as const)(
      'reconciles %p with current end %p, calculated=%p and resolved end %p to %p',
      (statut, dateFin, dateFinCalculee, resolvedDateFin, expected) => {
        expect(
          getReconciledArreteLifecycleStatus(
            {
              dateDebut: '2026-08-01',
              dateFin,
              dateFinCalculee,
              resolvedDateFin,
              statut,
            },
            '2026-08-05',
          ),
        ).toBe(expected);
      },
    );
  });

  it.each([
    ['2026-08-04T22:30:00.000Z', '2026-08-05'],
    ['2026-10-24T22:30:00.000Z', '2026-10-25'],
    ['2026-10-25T23:30:00.000Z', '2026-10-26'],
  ])('uses the Europe/Paris civil date at %s', (now, expected) => {
    expect(getCurrentParisCivilDate(new Date(now))).toBe(expected);
  });
});
