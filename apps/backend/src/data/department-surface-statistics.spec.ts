import { DataService } from './data.service';
import * as provisional from './provisional-department-statistics';

const levels = (alerte: number | string) => ({
  vigilance: typeof alerte === 'string' ? '0.00' : 0,
  alerte,
  alerte_renforcee: typeof alerte === 'string' ? '0.00' : 0,
  crise: typeof alerte === 'string' ? '0.00' : 0,
});
const surface = (alerte: number | string) => ({
  ESO: levels(alerte),
  ESU: levels(alerte),
  AEP: levels(alerte),
});
const rawDay = (date: string) => ({
  date,
  departements: [
    {
      departement: '11',
      date,
      SOU: levels(25),
      SUP: levels(25),
      AEP: levels(25),
    },
  ],
});

describe('department surface statistics', () => {
  let service: DataService;
  let cache: any;
  let state: any;
  let read: jest.SpyInstance;
  const query = (include = true, id = '124') =>
    service.areaFindByDate(
      '2026-07-11',
      '2026-09-10',
      undefined,
      undefined,
      id,
      include,
    );

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-10T12:00:00Z'));
    service = new DataService(null, null, null, null, null, null);
    state = { revision: '12', currentPublishedDate: '2026-09-10' };
    cache = {
      fingerprint: 'artifact-with-invalid-department-percentages',
      departements: [{ id: 124, code: '11', area: 100 }],
      regions: [{ id: 28, departements: [{ id: 124 }] }],
      bassinsVersants: [],
      fullArea: 100,
      dataArea: [
        { date: '2026-07-11', departements: [{ id: 124, ...surface('NaN') }] },
        {
          date: '2026-09-10',
          departements: [{ id: 124, ...surface('50.00') }],
        },
      ],
    };
    jest
      .spyOn(service as any, 'ensureCertifiedDataCache')
      .mockResolvedValue(cache);
    jest
      .spyOn(service as any, 'getPublicationState')
      .mockImplementation(async () => state);
    jest
      .spyOn(service as any, 'getProvisionalDepartmentDays')
      .mockResolvedValue([]);
    read = jest
      .spyOn(provisional, 'readSingleDepartmentSurfaceDays')
      .mockResolvedValue([rawDay('2026-07-11')]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('uses the department itself rather than a nonexistent child relation', () => {
    const [day] = service['computeDataAreaForDays'](
      [rawDay('2026-07-11')],
      cache,
    );
    expect(day.departements).toEqual([{ id: 124, ...surface('25.00') }]);
    expect(day.regions).toEqual([{ id: 28, ...surface('25.00') }]);
    expect(day.ESU.alerte).toBe('25.00');
  });

  it('does not invalidate other statistics for empty reference groups', () => {
    cache.regions.push({ id: 99, departements: [] });
    cache.bassinsVersants.push({ id: 999 });
    const [day] = service['computeDataAreaForDays'](
      [rawDay('2026-07-11')],
      cache,
    );
    expect(day.regions).toHaveLength(1);
    expect(day.bassinsVersants).toEqual([]);
    expect(day.departements[0].ESU.alerte).toBe('25.00');
  });

  it('repairs only existing invalid dates, labels raw data provisional and never changes the artifact', async () => {
    const before = structuredClone(cache);
    read.mockResolvedValue([
      rawDay('2026-07-11'),
      rawDay('2026-07-12'),
      rawDay('2026-09-10'),
    ]);
    const result = await query();
    expect(result).toEqual([
      {
        date: '2026-07-11',
        id: 124,
        ...surface('25.00'),
        ...provisional.PROVISIONAL_STATISTIC_STATUS,
      },
      { date: '2026-09-10', id: 124, ...surface('50.00') },
    ]);
    expect(read).toHaveBeenCalledWith(null, '2026-07-11', '2026-07-11', '11');
    expect(cache).toEqual(before);
  });

  it('does not certify reconstructed values without provisional opt-in', async () => {
    await expect(query(false)).rejects.toMatchObject({ status: 503 });
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps already valid provisional rows and never reads when all values are finite', async () => {
    cache.dataArea[0] = {
      ...cache.dataArea[0],
      ...provisional.PROVISIONAL_STATISTIC_STATUS,
      departements: [{ id: 124, ...surface('0.00') }],
    };
    const result = await query();
    expect(result[0]).toMatchObject({
      ...surface('0.00'),
      ...provisional.PROVISIONAL_STATISTIC_STATUS,
    });
    expect(result[1]).not.toHaveProperty('dataStatus');
    expect(read).not.toHaveBeenCalled();
  });

  it.each([0, null, undefined, NaN, Infinity, -1, 'invalid'])(
    'returns unavailable rather than zero for missing reference area %s',
    async (area) => {
      cache.departements[0].area = area;
      await expect(query()).rejects.toMatchObject({ status: 503 });
      expect(read).not.toHaveBeenCalled();
    },
  );

  it('accepts a numeric reference area serialized by PostgreSQL', async () => {
    cache.departements[0].area = '100';
    expect((await query())[0].ESU.alerte).toBe('25.00');
  });

  it('rejects unknown department IDs explicitly', async () => {
    await expect(query(true, '999999')).rejects.toMatchObject({ status: 404 });
    expect(read).not.toHaveBeenCalled();
  });

  it('does not delete days or invent zeroes when raw data is missing', async () => {
    read.mockResolvedValue([]);
    await expect(query()).rejects.toMatchObject({ status: 503 });
  });

  it('returns unavailable on database failure and releases the failed cache slot', async () => {
    read.mockRejectedValue(new Error('database unavailable'));
    await expect(query()).rejects.toMatchObject({ status: 503 });
    expect(service['departmentSurfaceRecoveryCache'].size).toBe(0);
  });

  it('shares concurrent reads then expires and invalidates on publication change', async () => {
    await Promise.all([query(), query()]);
    expect(read).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(60_001);
    await query();
    expect(read).toHaveBeenCalledTimes(2);
    state = { ...state, revision: '13' };
    await query();
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('rejects a publication change during recovery instead of mixing snapshots', async () => {
    read.mockImplementation(async () => {
      state = { ...state, revision: '13' };
      return [rawDay('2026-07-11')];
    });
    await expect(query()).rejects.toMatchObject({ status: 503 });
    expect(service['departmentSurfaceRecoveryCache'].size).toBe(0);
  });

  it('bounds the recovery cache across different artifact revisions', async () => {
    for (let revision = 0; revision < 12; revision++) {
      state = { ...state, revision: String(revision) };
      await query();
    }
    expect(service['departmentSurfaceRecoveryCache'].size).toBe(8);
  });

  it('limits distinct pending department reads to two', async () => {
    for (const id of [125, 126]) {
      cache.departements.push({ id, code: String(id), area: 100 });
      for (const day of cache.dataArea)
        day.departements.push({ id, ...surface('NaN') });
    }
    const finish: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    read.mockImplementation(() => {
      active++;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve) => {
        finish.push(() => {
          active--;
          resolve([rawDay('2026-07-11'), rawDay('2026-09-10')]);
        });
      });
    });
    const queries = [query(), query(true, '125'), query(true, '126')];
    for (let index = 0; index < 15; index++) await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(2);
    finish[0]();
    await queries[0];
    for (let index = 0; index < 15; index++) await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(3);
    finish[1]();
    finish[2]();
    await Promise.all(queries);
    expect(maxActive).toBe(2);
  });

  it('does not return an infinite percentage after numeric overflow', async () => {
    const day = rawDay('2026-07-11');
    day.departements[0].SUP.alerte = 1e308;
    read.mockResolvedValue([day]);
    await expect(query()).rejects.toMatchObject({ status: 503 });
  });
});
