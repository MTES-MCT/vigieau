import { DataController } from './data.controller';
import { DataService } from './data.service';
import { CommonDataQueryDto } from './dto/data.dto';
import { validate } from 'class-validator';
import * as provisional from './provisional-department-statistics';

const codes = Array.from({ length: 101 }, (_, index) =>
  String(index + 1).padStart(2, '0'),
);
const rawDay = (date: string): provisional.ProvisionalDepartmentRow[] =>
  codes.map((departement) => ({
    departement,
    date,
    restriction: {
      date,
      ...Object.fromEntries(
        ['SUP', 'SOU', 'AEP'].map((zone) => [
          zone,
          {
            vigilance: 0,
            alerte: 0.5,
            alerte_renforcee: 0,
            crise: 0,
          },
        ]),
      ),
    },
  }));

describe('completeProvisionalDepartmentDays', () => {
  const complete = (rows = rawDay('2026-07-11'), expected = codes) =>
    provisional.completeProvisionalDepartmentDays(
      rows,
      expected,
      '2026-07-11',
      '2026-07-12',
    );

  it('preserves complete persisted fractional surfaces without inventing missing days', () => {
    expect(complete()).toEqual([
      {
        date: '2026-07-11',
        departements: rawDay('2026-07-11').map((row) => ({
          ...row.restriction,
          departement: row.departement,
        })),
      },
    ]);
  });

  it('excludes only the incomplete day and rejects a wrong reference coverage', () => {
    expect(
      complete([...rawDay('2026-07-11').slice(1), ...rawDay('2026-07-12')]).map(
        ({ date }) => date,
      ),
    ).toEqual(['2026-07-12']);
    expect(complete(rawDay('2026-07-11'), codes.slice(1))).toEqual([]);
    expect(
      complete(rawDay('2026-07-11'), [...codes.slice(1), codes[1]]),
    ).toEqual([]);
  });

  it('rejects duplicate or unexpected departments even with 101 distinct rows', () => {
    expect(
      complete([...rawDay('2026-07-11'), rawDay('2026-07-11')[0]]),
    ).toEqual([]);
    const rows = rawDay('2026-07-11');
    rows[0].departement = 'unexpected';
    expect(complete(rows)).toEqual([]);
  });

  it.each([null, -1, NaN, Infinity, '', 'invalid', '-1'])(
    'excludes malformed surfaces (%s)',
    (value) => {
      const rows = rawDay('2026-07-11');
      rows[0].restriction.SUP.alerte = value;
      expect(complete(rows)).toEqual([]);
    },
  );

  it('normalizes persisted numeric strings without accepting missing values', () => {
    const rows = rawDay('2026-07-11');
    rows[0].restriction.SUP.alerte = '10110.82';
    expect(complete(rows)[0].departements[0].SUP.alerte).toBe(10110.82);
  });

  it('excludes mismatched dates and anything outside the requested range', () => {
    const rows = rawDay('2026-07-11');
    rows[0].restriction.date = '2026-07-10';
    expect(complete(rows)).toEqual([]);
    expect(complete(rawDay('2027-01-01'))).toEqual([]);
  });

  it('ignores malformed legacy dates without hiding valid days', () => {
    const rows = [
      ...rawDay('invalid'),
      ...rawDay('2026-02-30'),
      ...rawDay('2026-07-11'),
    ];
    expect(
      provisional
        .completeProvisionalDepartmentDays(
          rows,
          codes,
          '2026-01-01',
          '2026-12-31',
        )
        .map(({ date }) => date),
    ).toEqual(['2026-07-11']);
  });
});

describe('readProvisionalDepartmentDays', () => {
  const runner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    query: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
  };
  const source = { createQueryRunner: () => runner };

  beforeEach(() => jest.resetAllMocks());

  it('uses a bounded read-only snapshot and releases its connection', async () => {
    runner.query.mockImplementation(async (sql: string) =>
      sql.includes('SELECT department.code') ? rawDay('2026-07-11') : [],
    );
    expect(
      await provisional.readProvisionalDepartmentDays(
        source as any,
        '2026-07-11',
        '2026-07-12',
        codes,
      ),
    ).toHaveLength(1);
    expect(runner.startTransaction).toHaveBeenCalledWith('REPEATABLE READ');
    expect(runner.query).toHaveBeenCalledWith('SET TRANSACTION READ ONLY');
    expect(runner.query).toHaveBeenCalledWith(
      "SET LOCAL statement_timeout = '5s'",
    );
    expect(runner.query).toHaveBeenCalledWith(
      expect.stringContaining('BETWEEN $1::text AND $2::text'),
      ['2026-07-11', '2026-07-12'],
    );
    expect(
      runner.query.mock.calls.find(([sql]) =>
        sql.includes('SELECT department.code'),
      )[0],
    ).not.toContain('statistic_commune_snapshot');
    expect(
      runner.query.mock.calls.find(([sql]) =>
        sql.includes('SELECT department.code'),
      )[0],
    ).not.toContain('::date');
    expect(runner.commitTransaction).toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalled();
  });

  it('rolls back a failed or timed-out read', async () => {
    runner.query.mockRejectedValue(new Error('query timeout'));
    await expect(
      provisional.readProvisionalDepartmentDays(
        source as any,
        '2026-07-11',
        '2026-07-12',
        codes,
      ),
    ).rejects.toThrow('query timeout');
    expect(runner.rollbackTransaction).toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalled();
  });
});

describe('provisional public department and area opt-in', () => {
  let service: DataService;
  let state: any;
  let cache: any;
  let read: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-10T12:00:00Z'));
    service = new DataService(null, null, null, null, null, null);
    state = {
      revision: '12',
      currentPublishedDate: '2026-09-10',
      historicDirtyFrom: '2026-07-11',
      historicDirtyThrough: '2026-08-31',
    };
    const departments = codes.map((code, index) => ({
      id: index + 1,
      code,
      area: 1,
      departements: [{ id: index + 1 }],
    }));
    cache = {
      departements: departments,
      regions: [{ id: 1, departements: [{ id: 1 }] }],
      bassinsVersants: [{ id: 1, departements: [{ id: 2 }] }],
      fullArea: 101,
      metropoleArea: 101,
      dataArea: [{ date: '2026-09-10', ESO: {}, ESU: {}, AEP: {} }],
      dataDepartement: [
        {
          date: '2026-09-10',
          departements: [{ code: codes[0], niveauGravite: 'crise' }],
        },
      ],
    };
    jest
      .spyOn(service as any, 'ensureCertifiedDataCache')
      .mockResolvedValue(cache);
    jest
      .spyOn(service as any, 'getPublicationState')
      .mockImplementation(async () => state);
    read = jest
      .spyOn(provisional, 'readProvisionalDepartmentDays')
      .mockResolvedValue(
        provisional.completeProvisionalDepartmentDays(
          rawDay('2026-07-11'),
          codes,
          '2026-07-11',
          '2026-08-31',
        ),
      );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const departments = (
    include = true,
    from = '2026-07-01',
    through = '2026-09-10',
  ) =>
    service.departementFindByDate(
      from,
      through,
      undefined,
      undefined,
      undefined,
      include,
    );

  it('does not change the certified default API or query persisted provisional data', async () => {
    expect(await departments(false)).toEqual(cache.dataDepartement);
    expect(await service.areaFindByDate('2026-07-01', '2026-09-10')).toEqual(
      cache.dataArea,
    );
    expect(read).not.toHaveBeenCalled();
  });

  it('reconstructs provisional history from persisted data on a new process instance', async () => {
    const first = await departments();
    const restarted = new DataService(null, null, null, null, null, null);
    jest
      .spyOn(restarted as any, 'ensureCertifiedDataCache')
      .mockResolvedValue(cache);
    jest
      .spyOn(restarted as any, 'getPublicationState')
      .mockResolvedValue(state);
    const second = await restarted.departementFindByDate(
      '2026-07-01',
      '2026-09-10',
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(second).toEqual(first);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('marks only missing dirty dates and keeps all internal certified collections untouched', async () => {
    const before = structuredClone(cache);
    service['data'] = [{ sentinel: true }];
    const result = await departments();
    expect(result.map(({ date }) => date)).toEqual([
      '2026-07-11',
      '2026-09-10',
    ]);
    expect(result[0]).toMatchObject(provisional.PROVISIONAL_STATISTIC_STATUS);
    expect(result[0].departements).toHaveLength(101);
    expect(result[1]).not.toHaveProperty('dataStatus');
    expect(cache).toEqual(before);
    expect(service['data']).toEqual([{ sentinel: true }]);
    expect(read).toHaveBeenCalledWith(null, '2026-07-11', '2026-08-31', codes);
  });

  it('never replaces an existing certified day with a provisional value', async () => {
    cache.dataDepartement.unshift({ date: '2026-07-11', departements: [] });
    const result = await departments();
    expect(result[0]).toEqual({ date: '2026-07-11', departements: [] });
  });

  it.each([
    [undefined, undefined, undefined],
    ['1', undefined, undefined],
    [undefined, '1', undefined],
    [undefined, undefined, '1'],
  ])(
    'preserves provisional status for national or filtered area data (%s %s %s)',
    async (basin, region, department) => {
      const result = await service.areaFindByDate(
        '2026-07-11',
        '2026-07-11',
        basin,
        region,
        department,
        true,
      );
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        ...provisional.PROVISIONAL_STATISTIC_STATUS,
        ESU: { alerte: '50.00' },
      });
    },
  );

  it('applies department geographic filters to provisional data', async () => {
    const result = await service.departementFindByDate(
      '2026-07-11',
      '2026-07-11',
      undefined,
      undefined,
      '1',
      true,
    );
    expect(result[0].departements.map(({ code }) => code)).toEqual([codes[0]]);
    expect(result[0].dataStatus).toBe('provisional');
  });

  it('shares concurrent reads across both endpoints then expires the cache', async () => {
    await Promise.all([
      departments(),
      departments(),
      service.areaFindByDate(
        '2026-07-01',
        '2026-09-10',
        undefined,
        undefined,
        undefined,
        true,
      ),
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(60_001);
    await departments();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('refreshes after a new invalidation and a daily publication rollover', async () => {
    await departments();
    state = { ...state, revision: '13' };
    await departments();
    state = { ...state, currentPublishedDate: '2026-09-11' };
    await departments();
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('uses the publication Paris date for the future-day boundary', async () => {
    jest.setSystemTime(new Date('2026-09-10T22:30:00Z'));
    state = {
      ...state,
      currentPublishedDate: '2026-09-11',
      historicDirtyThrough: '2026-09-11',
    };
    await departments(true, '2026-07-11', '2026-09-12');
    expect(read).toHaveBeenCalledWith(null, '2026-07-11', '2026-09-11', codes);
  });

  it('fails back to the certified response when persisted data cannot be read', async () => {
    read.mockRejectedValue(new Error('timeout'));
    expect(await departments()).toEqual(cache.dataDepartement);
  });

  it('does not read provisional data when its current publication state cannot be verified', async () => {
    jest
      .spyOn(service as any, 'getPublicationState')
      .mockRejectedValue(new Error('state unavailable'));
    expect(await departments()).toEqual(cache.dataDepartement);
    expect(read).not.toHaveBeenCalled();
  });

  it('retries a read overtaken by another publication state', async () => {
    read.mockImplementation(async () => {
      state = { ...state, revision: '13' };
      return provisional.completeProvisionalDepartmentDays(
        rawDay('2026-07-11'),
        codes,
        '2026-07-11',
        '2026-08-31',
      );
    });
    expect((await departments()).map(({ date }) => date)).toEqual([
      '2026-07-11',
      '2026-09-10',
    ]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('does not query clean or out-of-range history and never goes past today', async () => {
    await departments(true, '2027-01-01', '2027-01-31');
    expect(read).not.toHaveBeenCalled();
    state = {
      ...state,
      historicDirtyThrough: '2027-01-01',
      currentPublishedDate: '2027-01-01',
    };
    await departments(true, '2026-07-01', '2027-01-31');
    expect(read).toHaveBeenCalledWith(null, '2026-07-11', '2026-09-10', codes);
    read.mockClear();
    state = { ...state, historicDirtyFrom: null };
    await departments();
    expect(read).not.toHaveBeenCalled();
  });

  it('evicts settled ranges without hiding results after the eighth range', async () => {
    read.mockImplementation(async (_source, from: string) =>
      provisional.completeProvisionalDepartmentDays(
        rawDay(from),
        codes,
        from,
        '2026-08-31',
      ),
    );
    for (let day = 11; day < 25; day += 1)
      expect(
        (await departments(true, `2026-07-${day}`, '2026-08-31'))[0].dataStatus,
      ).toBe('provisional');
    expect(read).toHaveBeenCalledTimes(14);
    expect(service['provisionalDepartmentCache'].size).toBe(8);
  });

  it('limits concurrent database reads without dropping a ninth distinct range', async () => {
    let active = 0;
    let maximumActive = 0;
    read.mockImplementation(async (_source, from: string) => {
      active += 1;
      maximumActive = Math.max(active, maximumActive);
      await Promise.resolve();
      active -= 1;
      return provisional.completeProvisionalDepartmentDays(
        rawDay(from),
        codes,
        from,
        '2026-08-31',
      );
    });
    const result = await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        departments(true, `2026-07-${index + 11}`, '2026-08-31'),
      ),
    );
    expect(result.every((days) => days[0].dataStatus === 'provisional')).toBe(
      true,
    );
    expect(maximumActive).toBeLessThanOrEqual(2);
    expect(read).toHaveBeenCalledTimes(9);
    expect(service['provisionalDepartmentCache'].size).toBe(8);
  });
});

describe('provisional query validation and controller forwarding', () => {
  it.each(['true', 'false'])(
    'accepts an explicit boolean string %s',
    async (value) => {
      expect(
        await validate(
          Object.assign(new CommonDataQueryDto(), {
            includeProvisional: value,
          }),
        ),
      ).toHaveLength(0);
    },
  );

  it.each(['yes', '0', '1', 'False', 'false ', 'false,true', '', false])(
    'rejects an ambiguous query value %s',
    async (value) => {
      expect(
        await validate(
          Object.assign(new CommonDataQueryDto(), {
            includeProvisional: value,
          }),
        ),
      ).toHaveLength(1);
    },
  );

  it.each(['true', 'false'])(
    'forwards the explicit %s choice on both endpoints',
    (value) => {
      const service = {
        areaFindByDate: jest.fn(),
        departementFindByDate: jest.fn(),
      };
      const controller = new DataController(service as any);
      controller.area({ includeProvisional: value });
      controller.departement({ includeProvisional: value });
      expect(service.areaFindByDate).toHaveBeenCalledWith(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        value === 'true',
      );
      expect(service.departementFindByDate).toHaveBeenCalledWith(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        value === 'true',
      );
    },
  );
});
