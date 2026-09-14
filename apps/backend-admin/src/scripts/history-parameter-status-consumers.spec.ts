import moment from 'moment';
import { ZoneAlerteComputedService } from '../zone_alerte_computed/zone_alerte_computed.service';
import {
  createHistoricDepartmentSourceSignature,
  HistoricDepartmentCheckpointService,
} from '../zone_alerte_computed/historic-department-checkpoint.service';
import { ZoneAlerteComputedHistoricService } from '../zone_alerte_computed/zone_alerte_computed_historic.service';
import { CERTIFIED_PARAMETER_ANCHOR } from './certified-history-parameter-anchor';

jest.mock('moment', () => ({
  __esModule: true,
  default: jest.requireActual('moment'),
}));

describe('actual historical parameter consumers', () => {
  async function trace(parametres: unknown[], date: string) {
    const departement = { id: 34, code: '34', nom: 'Herault', parametres };
    const calls: unknown[] = [];
    await (
      ZoneAlerteComputedHistoricService.prototype as any
    ).computeDepartementForDate.call(
      {
        computeRegleAr: async () => [{}],
        computeYesDistinct: async (_department: unknown, aep: boolean) =>
          calls.push(['distinct', aep]),
        computeYesAll: async (_department: unknown, exceptAep: boolean) =>
          calls.push(['all', exceptAep]),
        computeCommunesIntersected: async () => calls.push(['intersections']),
        logger: { error: (message: string) => calls.push(['error', message]) },
      },
      departement,
      moment(date),
      false,
    );
    await ZoneAlerteComputedHistoricService.prototype.computeRegleAr.call(
      {
        arreteResrictionService: { findByDepartementAndDate: async () => [] },
        logger: { log: () => undefined },
        zoneAlerteComputedHistoricRepository: {
          delete: async () => undefined,
          save: async (rows: unknown[]) => rows,
        },
        computeRegleAepNotSpecific: async () =>
          calls.push(['AEP-not-specific']),
      },
      departement,
      moment(date),
    );
    const checkpoints = new HistoricDepartmentCheckpointService(
      {} as any,
      { findByDepartementAndDate: async () => [] } as any,
    );
    const signature = await (checkpoints as any).computeInputSignature(
      departement,
      moment(date),
      '1',
      'same-materialization-version',
    );
    return { calls, signature };
  }

  function department34Parameters() {
    return CERTIFIED_PARAMETER_ANCHOR.filter(
      (row) => row.department === '34',
    ).map((row) => ({
      id: row.key,
      dateDebut: row.payload.from,
      dateFin: row.key === '398' ? '2026-09-10' : row.payload.through,
      superpositionCommune: row.payload.superpositionCommune,
      disabled: row.payload.disabled,
    }));
  }

  function forbidDisabledRead<T extends object>(parameter: T): T {
    return Object.defineProperty({ ...parameter }, 'disabled', {
      get: () => {
        throw new Error('Historic computation read parameter.disabled');
      },
    });
  }

  function expectedSignature(superpositionCommune: string) {
    return createHistoricDepartmentSourceSignature({
      materializationVersion: 'same-materialization-version',
      sourceRevision: '1',
      departement: { id: 34, code: '34', superpositionCommune },
      arretes: [],
    });
  }

  it('never reads disabled in department rules, AEP rules or checkpoint signatures over the certified 52 days', async () => {
    for (const reverse of [false, true]) {
      const original = department34Parameters();
      original.push({
        id: '401',
        dateDebut: '2026-09-10',
        dateFin: null,
        superpositionCommune: 'no_all',
        disabled: false,
      });
      if (reverse) original.reverse();
      const current = original.map((parameter) => ({
        ...parameter,
        disabled: parameter.id === '398' ? true : parameter.disabled,
      }));
      const forbidden = current.map(forbidDisabledRead);
      for (
        const date = moment('2026-07-11');
        date.isSameOrBefore('2026-08-31');
        date.add(1, 'day')
      ) {
        const civilDate = date.format('YYYY-MM-DD');
        const expected = await trace(original, civilDate);
        expect(await trace(current, civilDate)).toEqual(expected);
        expect(await trace(forbidden, civilDate)).toEqual(expected);
      }
    }
  });

  it('preserves the existing first-match behavior at inclusive overlapping boundaries', async () => {
    const original = department34Parameters();
    expect(await trace(original, '2026-08-13')).not.toEqual(
      await trace([...original].reverse(), '2026-08-13'),
    );
    expect(await trace(original, '2026-08-14')).toEqual(
      await trace([...original].reverse(), '2026-08-14'),
    );
  });

  it('selects historical rules by their dates, including a new September rule outside August', async () => {
    // Deliberately disjoint periods: this fixture does not reinterpret the
    // separate inclusive-boundary behavior protected above.
    const parameters = [
      {
        id: '398',
        dateDebut: '2026-08-13',
        dateFin: '2026-09-09',
        superpositionCommune: 'yes_all',
        disabled: true,
      },
      {
        id: '401',
        dateDebut: '2026-09-10',
        dateFin: null,
        superpositionCommune: 'no_all',
        disabled: false,
      },
    ].map(forbidDisabledRead);
    for (const ordered of [parameters, [...parameters].reverse()]) {
      for (const date of ['2026-08-13', '2026-08-20', '2026-09-09']) {
        expect(await trace(ordered, date)).toEqual({
          calls: [['distinct', false], ['all', false], ['intersections']],
          signature: expectedSignature('yes_all'),
        });
      }
      expect(await trace(ordered, '2026-09-10')).toEqual({
        calls: [['intersections'], ['AEP-not-specific']],
        signature: expectedSignature('no_all'),
      });
    }
  });

  it.each([true, false])(
    'keeps disabled meaningful for current computation (old parameter disabled=%s)',
    async (oldDisabled) => {
      const readOldDisabled = jest.fn(() => oldDisabled);
      const readNewDisabled = jest.fn(() => !oldDisabled);
      const departement = {
        id: 34,
        code: '34',
        nom: 'Herault',
        parametres: [
          {
            dateDebut: '2026-08-13',
            dateFin: '2026-09-09',
            superpositionCommune: 'yes_all',
            get disabled() {
              return readOldDisabled();
            },
          },
          {
            dateDebut: '2026-09-10',
            dateFin: null,
            superpositionCommune: 'no_all',
            get disabled() {
              return readNewDisabled();
            },
          },
        ],
      };
      const computeRegleAepNotSpecific = jest.fn(async () => undefined);
      await ZoneAlerteComputedService.prototype.computeRegleAr.call(
        {
          arreteResrictionService: { findByDepartement: async () => [] },
          logger: { log: () => undefined },
          zoneAlerteComputedRepository: {
            delete: async () => undefined,
            save: async (rows: unknown[]) => rows,
          },
          computeRegleAepNotSpecific,
        },
        departement,
      );
      expect(readOldDisabled).toHaveBeenCalledTimes(1);
      expect(readNewDisabled).toHaveBeenCalledTimes(oldDisabled ? 1 : 0);
      expect(computeRegleAepNotSpecific).toHaveBeenCalledTimes(
        oldDisabled ? 1 : 0,
      );
      if (oldDisabled) {
        expect(computeRegleAepNotSpecific).toHaveBeenCalledWith(departement);
      }
    },
  );
});
