import { Restriction } from '@shared/entities/restriction.entity';
import { getHistoricUsages } from './zone_alerte_computed_historic.service';

describe('getHistoricUsages', () => {
  it.each([50117, 50122])(
    'returns an empty list when historic restriction %s has no loaded usage',
    (id) => {
      const restriction = { id, usages: undefined } as Restriction;

      expect(getHistoricUsages(restriction)).toEqual([]);
    },
  );

  it('preserves loaded historic usages', () => {
    const usages = [{ id: 7, nom: 'Arrosage' }];
    const restriction = { usages } as Restriction;

    expect(getHistoricUsages(restriction)).toBe(usages);
  });
});
