import moment from 'moment';
import {
  createHistoricDepartmentSourceSignature,
  getHistoricDepartmentMaterializationVersion,
  HISTORIC_DEPARTMENT_CHECKPOINT_ENV,
  HISTORIC_DEPARTMENT_CHECKPOINT_PURGE_BATCH_SIZE,
  HistoricDepartmentCheckpointService,
  isHistoricDepartmentCheckpointEnabled,
} from './historic-department-checkpoint.service';

jest.mock('moment', () => {
  const momentModule = jest.requireActual('moment');
  return {
    __esModule: true,
    default: momentModule,
  };
});

describe('HistoricDepartmentCheckpointService', () => {
  const previousCheckpointEnabled =
    process.env[HISTORIC_DEPARTMENT_CHECKPOINT_ENV];
  const previousSkipIntersections =
    process.env.HISTORIC_SKIP_COMMUNE_INTERSECTIONS;
  const departement = {
    id: 65,
    code: '65',
    nom: 'Hautes-Pyrenees',
    parametres: [
      {
        id: 1,
        dateDebut: '2024-04-29',
        dateFin: null,
        superpositionCommune: 'yes_distinct',
      },
    ],
  } as any;
  const arretes = [
    {
      id: 29959,
      niveauGraviteSpecifiqueEap: false,
      ressourceEapCommunique: 'max',
      restrictions: [
        {
          id: 91,
          nomGroupementAep: null,
          niveauGravite: 'alerte',
          arreteCadre: { id: 12 },
          zoneAlerte: {
            id: 42,
            code: 'SANDRE-42',
            nom: 'Adour amont',
            type: 'SUP',
            disabled: false,
          },
          communes: [{ id: 65440 }, { id: 65001 }],
        },
      ],
    },
  ] as any;
  const outputRows = [
    {
      id: '100',
      idSandre: '42',
      nom: 'Adour amont',
      code: 'SANDRE-42',
      type: 'SUP',
      ressourceInfluencee: false,
      niveauGravite: 'alerte',
      restrictionId: '91',
      bassinVersantId: null,
      geometrySignature: 'geometry-md5',
      communeIds: ['65001', '65440'],
    },
  ];
  const outputSignature = createHistoricDepartmentSourceSignature(outputRows);

  let exactRows: any[];
  let previousRows: any[];
  let currentHistoricComputeEpoch: string;
  let currentSourceRevision: string;
  let dataSource: { query: jest.Mock };
  let arreteRestrictionService: { findByDepartementAndDate: jest.Mock };
  let service: HistoricDepartmentCheckpointService;

  beforeEach(() => {
    process.env[HISTORIC_DEPARTMENT_CHECKPOINT_ENV] = 'true';
    delete process.env.HISTORIC_SKIP_COMMUNE_INTERSECTIONS;
    exactRows = [];
    previousRows = [];
    currentHistoricComputeEpoch = '11';
    currentSourceRevision = '12';
    dataSource = {
      query: jest.fn(async (sql: string, parameters?: unknown[]) => {
        if (sql.includes('FROM "historic_department_checkpoint"')) {
          return parameters?.[1] === '2024-05-01' ? previousRows : exactRows;
        }
        if (sql.includes('FROM "zone_alerte_computed_historic" zone')) {
          return outputRows;
        }
        if (sql.includes('FROM "config" config')) {
          if (sql.includes('INSERT INTO "historic_department_checkpoint"')) {
            return [{ computedFor: parameters?.[0] }];
          }
          return [
            {
              historicComputeEpoch: currentHistoricComputeEpoch,
              sourceRevision: currentSourceRevision,
            },
          ];
        }
        return [];
      }),
    };
    arreteRestrictionService = {
      findByDepartementAndDate: jest.fn().mockResolvedValue(arretes),
    };
    service = new HistoricDepartmentCheckpointService(
      dataSource as any,
      arreteRestrictionService as any,
    );
  });

  afterAll(() => {
    if (previousCheckpointEnabled === undefined) {
      delete process.env[HISTORIC_DEPARTMENT_CHECKPOINT_ENV];
    } else {
      process.env[HISTORIC_DEPARTMENT_CHECKPOINT_ENV] =
        previousCheckpointEnabled;
    }
    if (previousSkipIntersections === undefined) {
      delete process.env.HISTORIC_SKIP_COMMUNE_INTERSECTIONS;
    } else {
      process.env.HISTORIC_SKIP_COMMUNE_INTERSECTIONS =
        previousSkipIntersections;
    }
  });

  it('is disabled by default and rejects ambiguous flag values', () => {
    delete process.env[HISTORIC_DEPARTMENT_CHECKPOINT_ENV];
    expect(isHistoricDepartmentCheckpointEnabled()).toBe(false);
    process.env[HISTORIC_DEPARTMENT_CHECKPOINT_ENV] = 'true';
    expect(isHistoricDepartmentCheckpointEnabled(' TRUE ')).toBe(true);
    expect(isHistoricDepartmentCheckpointEnabled('false')).toBe(false);
    expect(() => isHistoricDepartmentCheckpointEnabled('1')).toThrow(
      'must be "true" or "false"',
    );
  });

  it('includes the commune-link population mode in materialization identity', () => {
    expect(getHistoricDepartmentMaterializationVersion(false)).toContain(
      'commune-links-materialized',
    );
    expect(getHistoricDepartmentMaterializationVersion(true)).toContain(
      'commune-links-skipped',
    );
  });

  it('purges only a bounded batch of checkpoints from obsolete contexts', async () => {
    dataSource.query.mockResolvedValueOnce([
      { contextMatches: true, deletedCount: '5000' },
    ]);

    await expect(
      service.purgeStaleCheckpoints({
        historicComputeEpoch: '11',
        expectedSourceRevision: '12',
      }),
    ).resolves.toBe(HISTORIC_DEPARTMENT_CHECKPOINT_PURGE_BATCH_SIZE);

    const [sql, parameters] = dataSource.query.mock.calls[0];
    expect(sql).toContain('DELETE FROM "historic_department_checkpoint"');
    expect(sql).toContain('checkpoint."historicComputeEpoch" <> $1::bigint');
    expect(sql).toContain('checkpoint."sourceRevision" <> $2::text');
    expect(sql).toContain('LIMIT $3');
    expect(sql).not.toContain('"materializationVersion" <>');
    expect(parameters).toEqual([
      '11',
      '12',
      HISTORIC_DEPARTMENT_CHECKPOINT_PURGE_BATCH_SIZE,
    ]);
  });

  it('fails closed when the guarded cleanup context was invalidated', async () => {
    dataSource.query.mockResolvedValueOnce([
      { contextMatches: false, deletedCount: 0 },
    ]);

    await expect(
      service.purgeStaleCheckpoints({
        historicComputeEpoch: '11',
        expectedSourceRevision: '12',
      }),
    ).rejects.toThrow(
      'checkpoint worker context changed (epoch=11, sourceRevision=12)',
    );
  });

  it('detects a partial next day only with its certified national predecessor', async () => {
    dataSource.query.mockResolvedValueOnce([
      {
        contextMatches: true,
        hasCheckpoint: true,
        snapshotCompleted: true,
      },
    ]);

    await expect(
      service.hasAnyCheckpointForDate(
        moment('2024-05-03'),
        moment('2024-05-02'),
        {
          historicComputeEpoch: '11',
          expectedSourceRevision: '12',
        },
      ),
    ).resolves.toBe(true);

    const [sql, parameters] = dataSource.query.mock.calls[0];
    expect(sql).toContain('checkpoint."computedFor" = $1::date');
    expect(sql).toContain('checkpoint."historicComputeEpoch" = $2::bigint');
    expect(sql).toContain('checkpoint."sourceRevision" = $3::text');
    expect(sql).toContain('checkpoint."materializationVersion" = $4');
    expect(sql).toContain('snapshot."snapshotDate" = $5::date');
    expect(sql).toContain('snapshot."scope" = \'national\'');
    expect(sql).toContain('snapshot."status" = \'completed\'');
    expect(sql).toContain('snapshot."sourceRevision" = $3::bigint');
    expect(parameters).toEqual([
      '2024-05-03',
      '11',
      '12',
      getHistoricDepartmentMaterializationVersion(false),
      '2024-05-02',
    ]);
  });

  it('does not resume from an incomplete predecessor snapshot', async () => {
    dataSource.query.mockResolvedValueOnce([
      {
        contextMatches: true,
        hasCheckpoint: true,
        snapshotCompleted: false,
      },
    ]);

    await expect(
      service.hasAnyCheckpointForDate(
        moment('2024-05-03'),
        moment('2024-05-02'),
        {
          historicComputeEpoch: '11',
          expectedSourceRevision: '12',
        },
      ),
    ).resolves.toBe(false);
  });

  it('does not resume from a checkpoint made in another materialization mode', async () => {
    process.env.HISTORIC_SKIP_COMMUNE_INTERSECTIONS = 'true';
    dataSource.query.mockImplementationOnce(
      async (_sql: string, parameters: unknown[]) => [
        {
          contextMatches: true,
          hasCheckpoint:
            parameters[3] ===
            getHistoricDepartmentMaterializationVersion(false),
          snapshotCompleted: true,
        },
      ],
    );

    await expect(
      service.hasAnyCheckpointForDate(
        moment('2024-05-03'),
        moment('2024-05-02'),
        {
          historicComputeEpoch: '11',
          expectedSourceRevision: '12',
        },
      ),
    ).resolves.toBe(false);
    expect(dataSource.query.mock.calls[0][1][3]).toBe(
      getHistoricDepartmentMaterializationVersion(true),
    );
  });

  it('fails closed instead of resuming after epoch or source invalidation', async () => {
    dataSource.query.mockResolvedValueOnce([
      {
        contextMatches: false,
        hasCheckpoint: true,
        snapshotCompleted: true,
      },
    ]);

    await expect(
      service.hasAnyCheckpointForDate(
        moment('2024-05-03'),
        moment('2024-05-02'),
        {
          historicComputeEpoch: '11',
          expectedSourceRevision: '12',
        },
      ),
    ).rejects.toThrow(
      'checkpoint worker context changed (epoch=11, sourceRevision=12)',
    );
  });

  it('never skips a department without an expected source revision', async () => {
    await expect(
      service.prepare(departement, {
        date: moment('2024-05-02'),
        previousDate: '2024-05-01',
        historicComputeEpoch: '11',
      }),
    ).resolves.toMatchObject({
      enabled: false,
      shouldCompute: true,
      reason: 'missing_source_revision',
    });
    expect(
      arreteRestrictionService.findByDepartementAndDate,
    ).not.toHaveBeenCalled();
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('never skips a department without a captured historic compute epoch', async () => {
    await expect(
      service.prepare(departement, {
        date: moment('2024-05-02'),
        previousDate: '2024-05-01',
        expectedSourceRevision: '12',
      }),
    ).resolves.toMatchObject({
      enabled: false,
      shouldCompute: true,
      reason: 'missing_compute_epoch',
    });
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('resumes an exact department only while its persisted output still matches', async () => {
    exactRows = [
      {
        computedFor: '2024-05-02',
        outputSignature,
        zoneCount: 1,
      },
    ];

    await expect(
      service.prepare(departement, {
        date: moment('2024-05-02'),
        previousDate: '2024-05-01',
        historicComputeEpoch: '11',
        expectedSourceRevision: '12',
      }),
    ).resolves.toMatchObject({
      enabled: true,
      shouldCompute: false,
      reason: 'resume',
    });
  });

  it('refuses an otherwise reusable checkpoint after the source revision moved', async () => {
    exactRows = [
      {
        computedFor: '2024-05-02',
        outputSignature,
        zoneCount: 1,
      },
    ];
    currentSourceRevision = '13';

    await expect(
      service.prepare(departement, {
        date: moment('2024-05-02'),
        previousDate: '2024-05-01',
        historicComputeEpoch: '11',
        expectedSourceRevision: '12',
      }),
    ).rejects.toThrow(
      'source revision changed while computing department 65 (12 -> 13)',
    );
  });

  it('reuses only the exact previous day and persists a checkpoint for the new day', async () => {
    previousRows = [
      {
        computedFor: '2024-05-01',
        outputSignature,
        zoneCount: '1',
      },
    ];

    await expect(
      service.prepare(departement, {
        date: moment('2024-05-02'),
        previousDate: '2024-05-01',
        historicComputeEpoch: '11',
        expectedSourceRevision: '12',
      }),
    ).resolves.toMatchObject({
      shouldCompute: false,
      reason: 'unchanged_from_previous_day',
    });
    const insertCall = dataSource.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO "historic_department_checkpoint"'),
    );
    expect(insertCall?.[1]).toEqual([
      '2024-05-02',
      65,
      '11',
      '12',
      expect.stringContaining('commune-links-materialized'),
      expect.stringMatching(/^[a-f0-9]{64}$/),
      outputSignature,
      1,
      '2024-05-01',
    ]);
  });

  it('recomputes on gaps, signature misses, or output mismatches', async () => {
    exactRows = [
      {
        computedFor: '2024-05-03',
        outputSignature: 'different-output',
        zoneCount: 1,
      },
    ];
    previousRows = [
      {
        computedFor: '2024-05-01',
        outputSignature,
        zoneCount: 1,
      },
    ];

    await expect(
      service.prepare(departement, {
        date: moment('2024-05-03'),
        previousDate: '2024-05-01',
        historicComputeEpoch: '11',
        expectedSourceRevision: '12',
      }),
    ).resolves.toMatchObject({
      shouldCompute: true,
      reason: 'recompute',
    });
    expect(
      dataSource.query.mock.calls.some(([sql]) =>
        sql.includes('FROM "historic_department_checkpoint"'),
      ),
    ).toBe(true);
  });

  it('certifies a computed department only after rechecking source and output', async () => {
    const plan = await service.prepare(departement, {
      date: moment('2024-05-02'),
      previousDate: '2024-05-01',
      historicComputeEpoch: '11',
      expectedSourceRevision: '12',
    });

    await service.complete(
      departement,
      {
        date: moment('2024-05-02'),
        previousDate: '2024-05-01',
        historicComputeEpoch: '11',
        expectedSourceRevision: '12',
      },
      plan,
    );

    expect(
      arreteRestrictionService.findByDepartementAndDate,
    ).toHaveBeenCalledTimes(2);
    expect(
      dataSource.query.mock.calls.some(([sql]) =>
        sql.includes('"zone_publication_source_state"'),
      ),
    ).toBe(true);
    expect(
      dataSource.query.mock.calls.some(([sql]) =>
        sql.includes('INSERT INTO "historic_department_checkpoint"'),
      ),
    ).toBe(true);
  });

  it('refuses to certify when inputs change during department computation', async () => {
    const plan = await service.prepare(departement, {
      date: moment('2024-05-02'),
      previousDate: '2024-05-01',
      historicComputeEpoch: '11',
      expectedSourceRevision: '12',
    });
    arreteRestrictionService.findByDepartementAndDate.mockResolvedValueOnce([
      { ...arretes[0], restrictions: [] },
    ]);

    await expect(
      service.complete(
        departement,
        {
          date: moment('2024-05-02'),
          previousDate: '2024-05-01',
          historicComputeEpoch: '11',
          expectedSourceRevision: '12',
        },
        plan,
      ),
    ).rejects.toThrow('source signature changed');
    expect(
      dataSource.query.mock.calls.some(([sql]) =>
        sql.includes('INSERT INTO "historic_department_checkpoint"'),
      ),
    ).toBe(false);
  });

  it('rejects a checkpoint after its historic invalidation epoch changes', async () => {
    exactRows = [
      {
        computedFor: '2024-05-02',
        outputSignature,
        zoneCount: 1,
      },
    ];
    currentHistoricComputeEpoch = '12';

    await expect(
      service.prepare(departement, {
        date: moment('2024-05-02'),
        previousDate: '2024-05-01',
        historicComputeEpoch: '11',
        expectedSourceRevision: '12',
      }),
    ).rejects.toThrow(
      'compute epoch changed while computing department 65 (11 -> 12)',
    );
  });

  it('resumes an interrupted day and then reuses it on D+1 with the same stable epoch', async () => {
    const checkpoints = new Map<string, CheckpointRowForTest>();
    const checkpointDataSource = {
      query: jest.fn(async (sql: string, parameters: unknown[] = []) => {
        if (sql.includes('FROM "historic_department_checkpoint"')) {
          const key = `${parameters[0]}|${parameters[1]}|${parameters[2]}`;
          const checkpoint = checkpoints.get(key);
          return checkpoint ? [checkpoint] : [];
        }
        if (sql.includes('FROM "zone_alerte_computed_historic" zone')) {
          return outputRows;
        }
        if (sql.includes('INSERT INTO "historic_department_checkpoint"')) {
          const key = `${parameters[1]}|${parameters[0]}|${parameters[2]}`;
          checkpoints.set(key, {
            computedFor: String(parameters[0]),
            outputSignature: String(parameters[6]),
            zoneCount: Number(parameters[7]),
          });
          return [{ computedFor: parameters[0] }];
        }
        if (sql.includes('FROM "config" config')) {
          return [{ historicComputeEpoch: '7', sourceRevision: '12' }];
        }
        return [];
      }),
    };
    const checkpointService = new HistoricDepartmentCheckpointService(
      checkpointDataSource as any,
      arreteRestrictionService as any,
    );
    const dOptions = {
      date: moment('2024-05-02'),
      previousDate: '2024-05-01',
      historicComputeEpoch: '7',
      expectedSourceRevision: '12',
    };

    const firstPlan = await checkpointService.prepare(departement, dOptions);
    expect(firstPlan.reason).toBe('recompute');
    await checkpointService.complete(departement, dOptions, firstPlan);

    // The process stops after D was checkpointed but before its global cursor
    // was advanced. A later execution must resume D without recomputing it.
    await expect(
      checkpointService.prepare(departement, dOptions),
    ).resolves.toMatchObject({ shouldCompute: false, reason: 'resume' });

    await expect(
      checkpointService.prepare(departement, {
        date: moment('2024-05-03'),
        previousDate: '2024-05-02',
        historicComputeEpoch: '7',
        expectedSourceRevision: '12',
      }),
    ).resolves.toMatchObject({
      shouldCompute: false,
      reason: 'unchanged_from_previous_day',
    });
    expect([...checkpoints.keys()].sort()).toEqual([
      '65|2024-05-02|7',
      '65|2024-05-03|7',
    ]);
  });
});

interface CheckpointRowForTest {
  computedFor: string;
  outputSignature: string;
  zoneCount: number;
}
