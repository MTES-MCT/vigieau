import { DataService } from './data.service';
import type {
  StatisticCacheArtifactCandidate,
  StatisticCacheArtifactPayload,
} from './statistic-cache-artifact.service';

describe('sparse statistic publication after missed current days', () => {
  const previousEnvironment = { ...process.env };
  const oldDates = ['2013-01-01', '2013-01-02', '2026-11-11', '2026-11-12'];
  const departments = Array.from({ length: 101 }, (_, index) => ({
    id: index + 1,
    code: String(index + 1),
    area: 1,
  }));
  const areaDay = (date: string) => ({ date, ESO: {}, ESU: {}, AEP: {} });
  const departmentDay = (date: string) => ({ date, departements: departments });
  const references = {
    departements: departments,
    regions: [],
    bassinsVersants: [],
    fullArea: 101,
    metropoleArea: 101,
  };
  let service: DataService;
  let active: StatisticCacheArtifactPayload;
  let candidate: StatisticCacheArtifactCandidate;
  let state: any;
  let certifiedDates: Set<string>;
  let currentCertified: boolean;
  let currentWeight: number;
  let currentSourceRevision: string | null;
  let manager: { query: jest.Mock; getRepository: jest.Mock };
  let artifactService: any;
  let fullBuild: jest.SpyInstance;
  let departmentLoad: jest.SpyInstance;

  beforeEach(() => {
    process.env.STATISTIC_CACHE_MODE = 'versioned';
    process.env.STATISTIC_CACHE_ARTIFACT_MODE = 'read-write';
    process.env.STATISTIC_CACHE_DISTRIBUTED_REFRESH_ENABLED = 'true';
    state = {
      revision: '396',
      activePublicationId: 'zones',
      statisticCachePublicationId: 'active',
      currentPublishedDate: '2026-11-16',
      historicPublishedThrough: '2026-11-10',
      historicDirtyFrom: '2013-01-03',
      historicDirtyThrough: '2026-11-10',
      historicMapCursor: '2010-08-11',
      historicStatsCursor: '2010-08-11',
      historicComputeEpoch: '1448',
      sourceRevision: '169373',
      certifiedHistoryRepairId: null,
    };
    certifiedDates = new Set(['2026-11-11', '2026-11-12', '2026-11-16']);
    currentCertified = true;
    currentWeight = 3;
    currentSourceRevision = null;
    manager = {
      getRepository: jest.fn(),
      query: jest.fn(async (sql: string, [from, through = from]: string[]) => {
        const dates = [...certifiedDates]
          .filter((date) => date >= from && date <= through)
          .sort();
        if (sql.includes('"snapshotDate"::text AS date')) {
          return dates.map((date) => ({ date }));
        }
        if (sql.includes("WHERE status <> 'completed'")) return [];
        if (sql.includes('FROM "statistic_commune_snapshot"')) {
          return dates.map((snapshotDate) => ({
            snapshotDate,
            scope: 'national',
            status: currentCertified ? 'completed' : 'running',
            expectedCommuneCount: 1,
            processedCommuneCount: currentCertified ? 1 : 0,
            communeCount: 1,
            sourceRevision:
              snapshotDate === state.currentPublishedDate
                ? (currentSourceRevision ?? state.sourceRevision)
                : 'historical-source',
          }));
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    };
    artifactService = {
      loadActiveIdentity: jest.fn(async () => active.identity),
      loadActive: jest.fn(async () => active),
      stageCandidate: jest.fn(async (_target, build, options) => {
        candidate = await build(manager);
        if (
          (options?.requiredFirstDate &&
            candidate.firstDate !== options.requiredFirstDate) ||
          candidate.dateCount < (options?.minimumDateCount ?? 0)
        ) {
          throw new Error(
            'Statistic cache candidate does not preserve required history',
          );
        }
        return { ...candidate, id: 'candidate' };
      }),
      activateCandidate: jest.fn(async () => ({
        outcome: 'activated',
        readyInstances: 2,
      })),
    };
    service = new DataService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      manager as any,
      artifactService,
    );
    active = {
      identity: {
        id: 'active',
        statisticRevision: '395',
        currentPublishedDate: '2026-11-12',
        protocolVersion: 1,
        mode: 'versioned',
        materializationStrategy: 'sparse-current',
        historicDirtyFrom: state.historicDirtyFrom,
        historicDirtyThrough: state.historicDirtyThrough,
        historicMapCursor: state.historicMapCursor,
        historicStatsCursor: state.historicStatsCursor,
        historicComputeEpoch: '1430',
        sourceRevision: '169352',
        certifiedHistoryRepairId: null,
        contentFingerprint: '',
        firstDate: oldDates[0],
        latestDate: oldDates.at(-1),
        dateCount: oldDates.length,
        areaCount: oldDates.length,
        departmentCount: 101,
        communeCount: 1,
        readyAt: new Date('2026-11-12T12:00:00Z'),
      },
      dataArea: oldDates.map(areaDay),
      dataDepartement: oldDates.map(departmentDay),
      dataCommune: [
        {
          code: '01001',
          restrictions: [
            { d: '2013-01', p: 2 },
            { d: '2026-11', p: 2 },
          ],
        },
      ],
      latestCommuneWeights: [['01001', 1]],
    };
    jest
      .spyOn(service as any, 'getPublicationState')
      .mockImplementation(async () => state);
    jest
      .spyOn(service as any, 'readPublicationState')
      .mockImplementation(async () => state);
    jest.spyOn(service as any, 'loadRefData').mockResolvedValue(references);
    departmentLoad = jest
      .spyOn(service as any, 'loadDailyDepartmentCollections')
      .mockImplementation(async (from: string, through: string) => {
        expect(from).toBe(state.currentPublishedDate);
        expect(through).toBe(state.currentPublishedDate);
        return {
          dataArea: [areaDay(from)],
          dataDepartement: [departmentDay(from)],
        };
      });
    jest
      .spyOn(service as any, 'loadDailyCommuneWeights')
      .mockImplementation(
        async () =>
          new Map([[state.currentPublishedDate, [['01001', currentWeight]]]]),
      );
    fullBuild = jest
      .spyOn(service as any, 'createFullArtifactCandidate')
      .mockRejectedValue(
        new Error('Full rebuild must not hide a current-day gap'),
      );
  });

  afterEach(() => {
    for (const key of [
      'STATISTIC_CACHE_MODE',
      'STATISTIC_CACHE_ARTIFACT_MODE',
      'STATISTIC_CACHE_DISTRIBUTED_REFRESH_ENABLED',
    ]) {
      if (previousEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnvironment[key];
    }
    jest.restoreAllMocks();
  });

  function activateCandidate() {
    const {
      dataArea,
      dataDepartement,
      dataCommune,
      latestCommuneWeights,
      ...identity
    } = candidate;
    active = {
      identity: {
        ...identity,
        id: 'active',
        protocolVersion: 1,
        areaCount: dataArea.length,
        readyAt: new Date(),
      },
      dataArea,
      dataDepartement,
      dataCommune,
      latestCommuneWeights,
    };
  }

  it('preserves history across 12→16, an unchanged reconciliation, a same-day revision, and 17', async () => {
    const previous = structuredClone(active);
    await expect(
      service.reconcileStatisticCacheCandidate(),
    ).resolves.toMatchObject({ outcome: 'activated' });
    expect(candidate.dataArea).toEqual([
      ...previous.dataArea,
      areaDay('2026-11-16'),
    ]);
    expect(candidate.dataDepartement).toEqual([
      ...previous.dataDepartement,
      departmentDay('2026-11-16'),
    ]);
    expect(candidate.dataCommune[0].restrictions).toEqual([
      { d: '2013-01', p: 2 },
      { d: '2026-11', p: 5 },
    ]);
    expect(artifactService.stageCandidate).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.any(Function),
      {
        requiredFirstDate: oldDates[0],
        minimumDateCount: 5,
      },
    );
    activateCandidate();
    await expect(service.reconcileStatisticCacheCandidate()).resolves.toEqual({
      outcome: 'up-to-date',
      reason: 'active-target-matches',
    });
    expect(artifactService.stageCandidate).toHaveBeenCalledTimes(1);

    state = { ...state, revision: '397', sourceRevision: '169374' };
    currentWeight = 4;
    await expect(
      service.reconcileStatisticCacheCandidate(),
    ).resolves.toMatchObject({ outcome: 'activated' });
    expect(candidate.dateCount).toBe(5);
    expect(candidate.dataCommune[0].restrictions).toEqual([
      { d: '2013-01', p: 2 },
      { d: '2026-11', p: 6 },
    ]);
    activateCandidate();

    state = {
      ...state,
      revision: '398',
      sourceRevision: '169375',
      currentPublishedDate: '2026-11-17',
    };
    certifiedDates.add('2026-11-17');
    currentWeight = 2;
    await expect(
      service.reconcileStatisticCacheCandidate(),
    ).resolves.toMatchObject({ outcome: 'activated' });
    expect(candidate.dataArea.map(({ date }) => date)).toEqual([
      ...oldDates,
      '2026-11-16',
      '2026-11-17',
    ]);
    expect(candidate.dataCommune[0].restrictions).toEqual([
      { d: '2013-01', p: 2 },
      { d: '2026-11', p: 8 },
    ]);
    expect(artifactService.stageCandidate).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.any(Function),
      {
        requiredFirstDate: oldDates[0],
        minimumDateCount: 6,
      },
    );
    expect(fullBuild).not.toHaveBeenCalled();
    expect(candidate.historicDirtyFrom).toBe(state.historicDirtyFrom);
    expect(candidate.historicDirtyThrough).toBe(state.historicDirtyThrough);
    expect(candidate.historicMapCursor).toBe('2010-08-11');
    expect(candidate.historicStatsCursor).toBe('2010-08-11');
  });

  it('still detects a genuinely missing certified historic date', async () => {
    active.identity.dateCount -= 1;
    await expect(
      (service as any).shouldRecoverSparseHistoricArtifact(
        active.identity,
        state,
        manager,
      ),
    ).resolves.toBe(true);
  });

  it('appends all certified intermediate days in contiguous batches and preserves existing values', async () => {
    const previousDates = [
      '2026-08-19',
      '2026-09-07',
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
    ];
    const availableDates = (service as any)
      .generateDateRange('2026-09-11', '2026-11-12')
      .map(({ date }) => date);
    state.historicDirtyFrom = '2011-06-07';
    state.historicDirtyThrough = '2026-08-05';
    active.identity = {
      ...active.identity,
      historicDirtyFrom: state.historicDirtyFrom,
      historicDirtyThrough: state.historicDirtyThrough,
      firstDate: previousDates[0],
      latestDate: previousDates.at(-1),
      currentPublishedDate: previousDates.at(-1),
      dateCount: 5,
      areaCount: 5,
    };
    active.dataArea = previousDates.map(areaDay);
    active.dataDepartement = previousDates.map(departmentDay);
    active.dataCommune = [
      {
        code: '01001',
        restrictions: [
          { d: '2026-08', p: 1 },
          { d: '2026-09', p: 4 },
        ],
      },
    ];
    certifiedDates = new Set([
      ...previousDates,
      ...availableDates,
      '2026-11-16',
    ]);
    const previous = structuredClone(active);
    departmentLoad.mockImplementation(async (from: string, through: string) => {
      const days = (service as any)
        .generateDateRange(from, through)
        .map(({ date }) => date);
      return {
        dataArea: days.map(areaDay),
        dataDepartement: days.map(departmentDay),
      };
    });
    const weightLoad = jest
      .spyOn(service as any, 'loadDailyCommuneWeights')
      .mockImplementation(
        async (from: string, through: string) =>
          new Map(
            (service as any)
              .generateDateRange(from, through)
              .map(({ date }) => [date, [['01001', 3]]]),
          ),
      );

    await expect(
      service.reconcileStatisticCacheCandidate(),
    ).resolves.toMatchObject({ outcome: 'activated' });
    expect(candidate.dateCount).toBe(69);
    expect(candidate.dataArea).toEqual([
      ...previous.dataArea,
      ...availableDates.map(areaDay),
      areaDay('2026-11-16'),
    ]);
    expect(candidate.dataDepartement).toEqual([
      ...previous.dataDepartement,
      ...availableDates.map(departmentDay),
      departmentDay('2026-11-16'),
    ]);
    expect(candidate.dataCommune[0].restrictions).toEqual([
      { d: '2026-08', p: 1 },
      { d: '2026-09', p: 64 },
      { d: '2026-10', p: 93 },
      { d: '2026-11', p: 39 },
    ]);
    expect(
      departmentLoad.mock.calls.map(([from, through]) => [from, through]),
    ).toEqual([
      ['2026-09-11', '2026-11-12'],
      ['2026-11-16', '2026-11-16'],
    ]);
    expect(
      weightLoad.mock.calls.map(([from, through]) => [from, through]),
    ).toEqual([
      ['2026-09-11', '2026-11-12'],
      ['2026-11-16', '2026-11-16'],
    ]);
    expect(artifactService.stageCandidate).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.any(Function),
      {
        requiredFirstDate: '2026-08-19',
        minimumDateCount: 69,
      },
    );
    expect(fullBuild).not.toHaveBeenCalled();
    activateCandidate();
    await expect(
      service.reconcileStatisticCacheCandidate(),
    ).resolves.toMatchObject({ outcome: 'up-to-date' });
  });

  it('requests recovery if a previously missing day becomes certified', async () => {
    await service.reconcileStatisticCacheCandidate();
    activateCandidate();
    certifiedDates.add('2026-11-13');
    await expect(
      (service as any).shouldRecoverSparseHistoricArtifact(
        active.identity,
        state,
        manager,
      ),
    ).resolves.toBe(true);
  });

  it.each([101, 100])(
    'recovers a newly certified day without filling remaining holes, with %i raw departments',
    async (departmentCount) => {
      await service.reconcileStatisticCacheCandidate();
      activateCandidate();
      certifiedDates.add('2026-11-13');
      fullBuild.mockRestore();
      const availableDates = [...oldDates, '2026-11-13', '2026-11-16'];
      manager.getRepository.mockReturnValue({
        find: jest.fn(async () =>
          departments.map((departement, index) => ({
            departement,
            restrictions: availableDates
              .filter(
                (date) => date !== '2026-11-13' || index < departmentCount,
              )
              .map((date) => ({ date, SOU: {}, SUP: {}, AEP: {} })),
          })),
        ),
      });
      jest.spyOn(service, 'loadCommuneData').mockImplementation(async () => {
        (service as any).dataCommune = structuredClone(active.dataCommune);
        return 1;
      });
      const result = service.reconcileStatisticCacheCandidate();
      if (departmentCount === 100) {
        await expect(result).rejects.toThrow('2026-11-13 contain 100/101');
        expect(artifactService.activateCandidate).toHaveBeenCalledTimes(1);
      } else {
        await expect(result).resolves.toMatchObject({ outcome: 'activated' });
        expect(candidate.dataArea.map(({ date }) => date)).toEqual(
          availableDates,
        );
        expect(candidate.dataDepartement.map(({ date }) => date)).toEqual(
          availableDates,
        );
        expect(candidate.dateCount).toBe(6);
        expect(artifactService.stageCandidate).toHaveBeenLastCalledWith(
          expect.anything(),
          expect.any(Function),
          {
            replaceActivePublicationId: 'active',
            requiredFirstDate: oldDates[0],
            minimumDateCount: 6,
          },
        );
      }
    },
  );

  it('rejects a completed current snapshot from a different source revision', async () => {
    state.currentPublishedDate = '2026-11-17';
    certifiedDates.add('2026-11-17');
    currentSourceRevision = 'stale-source';
    await expect(
      service.reconcileStatisticCacheCandidate(),
    ).resolves.toMatchObject({
      outcome: 'retry',
    });
    expect(departmentLoad).not.toHaveBeenCalled();
    expect(artifactService.activateCandidate).not.toHaveBeenCalled();
  });

  it('does not publish when the current snapshot is uncertified', async () => {
    currentCertified = false;
    await expect(
      service.reconcileStatisticCacheCandidate(),
    ).resolves.toMatchObject({ outcome: 'retry' });
    expect(departmentLoad).not.toHaveBeenCalled();
    expect(artifactService.activateCandidate).not.toHaveBeenCalled();
  });
});
