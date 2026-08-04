import {
  getArreteLifecycleStatus,
  getCurrentParisCivilDate,
  getPredecessorEndDateConstraint,
  getPublicationEndDateProvenance,
  hasArreteComputationStateChanged,
  normalizeCivilDate,
  resolveArreteEndDate,
  UnknownArreteEndDateProvenanceError,
} from './arrete-date-continuity';

describe('arrete date continuity', () => {
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

    it('allows an unknown legacy boundary to be shortened', () => {
      expect(
        resolveArreteEndDate(
          {
            dateFin: '2026-08-04',
            dateFinSaisie: '2026-08-04',
            dateFinCalculee: true,
            dateFinSaisieConnue: false,
          },
          ['2026-08-03'],
        ),
      ).toEqual({
        dateFin: '2026-08-03',
        dateFinSaisie: '2026-08-04',
        dateFinCalculee: true,
        dateFinSaisieConnue: false,
      });
    });

    it('restores a tightened legacy boundary up to its conservative ceiling', () => {
      expect(
        resolveArreteEndDate(
          {
            dateFin: '2026-08-03',
            dateFinSaisie: '2026-08-04',
            dateFinCalculee: true,
            dateFinSaisieConnue: false,
          },
          ['2026-08-04'],
        ),
      ).toEqual({
        dateFin: '2026-08-04',
        dateFinSaisie: '2026-08-04',
        dateFinCalculee: true,
        dateFinSaisieConnue: false,
      });
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
        dateFinSaisie: '2026-08-03',
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

  it.each([
    ['2026-08-04T22:30:00.000Z', '2026-08-05'],
    ['2026-10-24T22:30:00.000Z', '2026-10-25'],
    ['2026-10-25T23:30:00.000Z', '2026-10-26'],
  ])('uses the Europe/Paris civil date at %s', (now, expected) => {
    expect(getCurrentParisCivilDate(new Date(now))).toBe(expected);
  });
});
