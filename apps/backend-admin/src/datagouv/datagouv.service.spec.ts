import * as fs from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import * as JSZip from 'jszip';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import moment = require('moment');
import { of, throwError } from 'rxjs';
import { DatagouvService } from './datagouv.service';

function dailyRestrictions(startDate: string, endDate: string) {
  const restrictions = [];
  for (
    let date = new Date(`${startDate}T00:00:00Z`);
    date <= new Date(`${endDate}T00:00:00Z`);
    date = new Date(date.getTime() + 86_400_000)
  ) {
    restrictions.push({
      date: date.toISOString().slice(0, 10),
      SOU: null,
      SUP: null,
      AEP: null,
    });
  }
  return restrictions;
}

interface ServiceHarness {
  service: DatagouvService;
  arreteRestrictionService: { findDatagouv: jest.Mock };
  departementService: { findAllLight: jest.Mock };
  statisticCommuneService: {
    getStatisticCommuneStream: jest.Mock;
    getStatisticCommuneStreamForYear: jest.Mock;
  };
  httpService: {
    get: jest.Mock;
    post: jest.Mock;
    put: jest.Mock;
  };
  s3Service: {
    uploadFile: jest.Mock;
    headFile: jest.Mock;
    getPublicFileUrl: jest.Mock;
  };
  dataSource: { createQueryRunner: jest.Mock };
  queryRunner: {
    connect: jest.Mock;
    startTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    query: jest.Mock;
    release: jest.Mock;
    isTransactionActive: boolean;
  };
  logger: {
    log: jest.Mock;
    warn: jest.Mock;
    error: jest.Mock;
  };
  publicationRegistry: {
    executeDailyRun: jest.Mock;
    resolveResourceId: jest.Mock;
    recordResourceSuccess: jest.Mock;
    recordResourceFailure: jest.Mock;
  };
}

function createHarness(
  path: string,
  overrides: Record<string, string | undefined> = {},
): ServiceHarness {
  const values = {
    PATH_TO_WRITE_FILE: path,
    API_DATAGOUV: 'https://www.data.gouv.fr/api/1/',
    API_DATAGOUV_DATASET: 'dataset-id',
    API_DATAGOUV_KEY: 'secret-api-key',
    API_DATAGOUV_HISTORIQUE_COMMUNES_RESOURCE_ID:
      '4322064e-cfb4-4c8a-8200-7620f491ccdb',
    API_DATAGOUV_GEOJSON_ARCHIVE_RESOURCE_ID: 'geojson-archive-resource',
    API_DATAGOUV_PMTILES_ARCHIVE_RESOURCE_ID: 'pmtiles-archive-resource',
    ...overrides,
  };
  const httpService = {
    get: jest.fn(),
    post: jest.fn().mockReturnValue(of({ data: {} })),
    put: jest.fn().mockReturnValue(of({ data: {} })),
  };
  const arreteRestrictionService = {
    findDatagouv: jest.fn().mockResolvedValue([]),
  };
  const statisticCommuneService = {
    getStatisticCommuneStream: jest.fn(),
    getStatisticCommuneStreamForYear: jest.fn(),
  };
  const departementService = {
    findAllLight: jest.fn().mockResolvedValue([]),
  };
  const queryRunner = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(async (sql: string) =>
      sql.includes('pg_advisory_unlock')
        ? [{ unlocked: true }]
        : [{ locked: true }],
    ),
    release: jest.fn().mockResolvedValue(undefined),
    isTransactionActive: true,
  };
  const dataSource = {
    createQueryRunner: jest.fn().mockReturnValue(queryRunner),
  };
  const publicationRegistry = {
    executeDailyRun: jest.fn(
      async (_key: string, _date: string, run: () => Promise<void>) => {
        await run();
        return 'succeeded';
      },
    ),
    resolveResourceId: jest.fn(
      async (_key: string, _provider: string, configuredResourceId?: string) =>
        configuredResourceId,
    ),
    recordResourceSuccess: jest.fn().mockResolvedValue(undefined),
    recordResourceFailure: jest.fn().mockResolvedValue(undefined),
  };
  const s3Service = {
    uploadFile: jest.fn().mockResolvedValue({
      Location: 'https://objects.example.test/archive.zip',
    }),
    headFile: jest.fn(),
    getPublicFileUrl: jest.fn(
      (fileName: string, prefix = '') =>
        `https://objects.example.test/${prefix}${fileName}`,
    ),
  };
  const service = new DatagouvService(
    httpService as any,
    arreteRestrictionService as any,
    {} as any,
    { get: jest.fn((key: string) => values[key]) } as any,
    {} as any,
    s3Service as any,
    departementService as any,
    statisticCommuneService as any,
    dataSource as any,
    publicationRegistry as any,
  );
  const logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  (service as any).logger = logger;
  return {
    service,
    arreteRestrictionService,
    departementService,
    statisticCommuneService,
    httpService,
    s3Service,
    dataSource,
    queryRunner,
    logger,
    publicationRegistry,
  };
}

describe('DatagouvService', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('aborts the run and terminates the clock when work ignores cancellation', async () => {
    jest.useFakeTimers();
    const harness = createHarness('/tmp', { DATAGOUV_RUN_TIMEOUT_MS: '10' });
    let finishOperation: () => void;
    let operationSignal: AbortSignal | undefined;
    const stalledOperation = new Promise<void>((resolve) => {
      finishOperation = resolve;
    });
    const exit = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);

    const result = (
      harness.service as unknown as {
        runWithDeadline(operation: () => Promise<void>): Promise<void>;
        deadlineContext: { getStore(): AbortSignal | undefined };
      }
    )
      .runWithDeadline(() => {
        operationSignal = (harness.service as any).deadlineContext.getStore();
        return stalledOperation;
      })
      .catch((error) => error);

    await jest.advanceTimersByTimeAsync(10);
    expect(operationSignal?.aborted).toBe(true);
    expect(exit).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(30_000);
    expect(exit).toHaveBeenCalledWith(1);

    finishOperation();
    await expect(result).resolves.toEqual(
      expect.objectContaining({ name: 'TimeoutError' }),
    );
  });

  it('runs map archives as independent durable sub-jobs', async () => {
    const harness = createHarness('/tmp', {
      DATAGOUV_MAP_ARCHIVES_ENABLED: 'true',
    });
    const verifyCurrent = jest.fn().mockResolvedValue(undefined);
    const publicationIdentity = {
      publicationId: 'publication-1',
      sourceRevision: '42',
      materializationVersion: 3,
      historicMapCursor: '2026-07-31',
      historicStatsCursor: '2026-07-31',
      historicMapGeneration: '12',
      historicStatsGeneration: '8',
    };
    const updateArretes = jest
      .spyOn(harness.service, 'updateArretes')
      .mockRejectedValue(new Error('arretes failed'));
    const updateHistoriqueArretes = jest
      .spyOn(harness.service, 'updateHistoriqueArretes')
      .mockResolvedValue();
    const updateArretesCadre = jest
      .spyOn(harness.service, 'updateArretesCadre')
      .mockResolvedValue();
    const updateRestrictions = jest
      .spyOn(harness.service, 'updateRestrictions')
      .mockResolvedValue();
    const updateCommunes = jest
      .spyOn(harness.service, 'updateCommunes')
      .mockResolvedValue();
    const updateHistoriqueCommunes = jest
      .spyOn(harness.service, 'updateHistoriqueCommunes')
      .mockResolvedValue();
    const updateDailyMapArchive = jest
      .spyOn(harness.service, 'updateDailyMapArchive')
      .mockImplementation(async (_scheduledFor, geojson) => {
        if (geojson) {
          throw new Error('geojson archive failed');
        }
      });

    await expect(
      harness.service.updateDatagouvData('2026-08-01', {
        ...publicationIdentity,
        verifyCurrent,
      }),
    ).rejects.toThrow('Échec de 2 publication(s) Datagouv');

    expect(updateArretes).toHaveBeenCalledTimes(1);
    expect(updateHistoriqueArretes).toHaveBeenCalledTimes(1);
    expect(updateArretesCadre).toHaveBeenCalledTimes(1);
    expect(updateRestrictions).toHaveBeenCalledTimes(1);
    expect(updateCommunes).toHaveBeenCalledTimes(1);
    expect(updateHistoriqueCommunes).toHaveBeenCalledTimes(1);
    expect(updateDailyMapArchive).toHaveBeenNthCalledWith(
      1,
      '2026-08-01',
      true,
    );
    expect(updateDailyMapArchive).toHaveBeenNthCalledWith(
      2,
      '2026-08-01',
      false,
    );
    expect(
      harness.publicationRegistry.executeDailyRun.mock.calls.map(
        ([key, scheduledFor]) => [key, scheduledFor],
      ),
    ).toEqual(
      expect.arrayContaining([
        ['datagouv:maps-geojson', '2026-08-01'],
        ['datagouv:maps-pmtiles', '2026-08-01'],
      ]),
    );
    const mapRunCalls =
      harness.publicationRegistry.executeDailyRun.mock.calls.filter(([key]) =>
        String(key).startsWith('datagouv:maps-'),
      );
    expect(mapRunCalls).toHaveLength(2);
    for (const call of mapRunCalls) {
      expect(call[4]).toEqual({ identity: publicationIdentity });
    }
    expect(verifyCurrent).toHaveBeenCalled();
    expect(harness.logger.error).toHaveBeenCalledTimes(2);
  });

  it('keeps a daily run pending when a resource retry is not due yet', async () => {
    const harness = createHarness('/tmp');
    harness.publicationRegistry.executeDailyRun.mockResolvedValue('not_due');
    const failures: Array<{ name: string; error: unknown }> = [];

    await (harness.service as any).runDataGouvUpdate(
      'communes-2026',
      'COMMUNES',
      '2026-08-01',
      jest.fn(),
      failures,
    );

    expect(failures).toHaveLength(1);
    expect((failures[0].error as Error).message).toContain(
      'non terminée (not_due)',
    );
  });

  it('pins a resource sub-job to one publication and revalidates around it', async () => {
    const harness = createHarness('/tmp');
    const verifyCurrent = jest.fn().mockResolvedValue(undefined);
    const update = jest.fn().mockResolvedValue(undefined);
    const failures: Array<{ name: string; error: unknown }> = [];

    await (harness.service as any).runDataGouvUpdate(
      'communes-2026',
      'COMMUNES',
      '2026-08-01',
      update,
      failures,
      {
        publicationId: 'publication-1',
        sourceRevision: '42',
        materializationVersion: 3,
        historicMapCursor: '2026-07-31',
        historicStatsCursor: '2026-07-31',
        historicMapGeneration: '12',
        historicStatsGeneration: '8',
        verifyCurrent,
      },
    );

    expect(failures).toEqual([]);
    expect(update).toHaveBeenCalledTimes(1);
    expect(verifyCurrent).toHaveBeenCalledTimes(2);
    expect(harness.publicationRegistry.executeDailyRun).toHaveBeenCalledWith(
      'datagouv:communes-2026',
      '2026-08-01',
      expect.any(Function),
      expect.any(Date),
      {
        identity: {
          publicationId: 'publication-1',
          sourceRevision: '42',
          materializationVersion: 3,
          historicMapCursor: '2026-07-31',
          historicStatsCursor: '2026-07-31',
          historicMapGeneration: '12',
          historicStatsGeneration: '8',
        },
      },
    );
  });

  it('resumes a mixed same-day publication with the explicit legacy identity', async () => {
    const harness = createHarness('/tmp');
    const existingIdentities = new Map<string, Record<string, unknown>>([
      [
        'datagouv:arretes',
        {
          publicationId: 'publication-versioned',
          sourceRevision: '42',
          materializationVersion: 3,
        },
      ],
      ['datagouv:historique-arretes', { publicationMode: 'legacy' }],
    ]);
    harness.publicationRegistry.executeDailyRun.mockImplementation(
      async (
        key: string,
        _date: string,
        run: () => Promise<void>,
        _now: Date,
        options?: { identity?: Record<string, unknown> },
      ) => {
        const existingIdentity = existingIdentities.get(key);
        const requestedIdentity = options?.identity;
        if (
          existingIdentity &&
          requestedIdentity &&
          Object.entries(requestedIdentity).every(
            ([name, value]) => existingIdentity[name] === value,
          )
        ) {
          return 'already_succeeded';
        }
        await run();
        existingIdentities.set(key, requestedIdentity || {});
        return 'succeeded';
      },
    );
    const updateArretes = jest
      .spyOn(harness.service, 'updateArretes')
      .mockResolvedValue();
    const updateHistoriqueArretes = jest
      .spyOn(harness.service, 'updateHistoriqueArretes')
      .mockResolvedValue();
    jest.spyOn(harness.service, 'updateArretesCadre').mockResolvedValue();
    jest.spyOn(harness.service, 'updateRestrictions').mockResolvedValue();
    jest.spyOn(harness.service, 'updateCommunes').mockResolvedValue();
    jest.spyOn(harness.service, 'updateHistoriqueCommunes').mockResolvedValue();

    await harness.service.updateDatagouvData('2026-08-01', {
      publicationMode: 'legacy',
    });

    expect(updateArretes).toHaveBeenCalledTimes(1);
    expect(updateHistoriqueArretes).not.toHaveBeenCalled();
    expect(harness.publicationRegistry.executeDailyRun).toHaveBeenCalledTimes(
      6,
    );
    for (const call of harness.publicationRegistry.executeDailyRun.mock.calls) {
      expect(call[4]).toEqual({
        identity: { publicationMode: 'legacy' },
      });
    }
  });

  it('publishes only the explicitly configured arrete archive years', async () => {
    const harness = createHarness('/tmp', {
      API_DATAGOUV_ARRETES_ARCHIVE_YEARS: '2013, 2012, 2013',
    });
    jest.spyOn(harness.service as any, 'writeCsv').mockResolvedValue(undefined);
    const upload = jest
      .spyOn(harness.service, 'uploadToDatagouv')
      .mockResolvedValue(undefined);

    await harness.service.updateHistoriqueArretes([]);

    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls.map(([resource]) => resource)).toEqual([
      'arretes_2012',
      'arretes_2013',
    ]);
    expect(
      upload.mock.calls.some(([resource]) => resource === 'arretes_2025'),
    ).toBe(false);
  });

  it('validates every configured arrete archive resource before writing files', async () => {
    const harness = createHarness('/tmp', {
      API_DATAGOUV_ARRETES_ARCHIVE_YEARS: '2012,2013',
    });
    harness.publicationRegistry.resolveResourceId.mockImplementation(
      async (key: string, _provider: string, configured?: string) =>
        key === 'arretes_2013' ? undefined : configured,
    );
    const writeCsv = jest.spyOn(harness.service as any, 'writeCsv');
    const upload = jest.spyOn(harness.service, 'uploadToDatagouv');

    await expect(harness.service.updateHistoriqueArretes([])).rejects.toThrow(
      "Ressources Datagouv manquantes pour les archives d'arrêtés: 2013",
    );

    expect(writeCsv).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(harness.departementService.findAllLight).not.toHaveBeenCalled();
  });

  it('builds a valid annual ZIP with the historical JSON schema', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vigieau-datagouv-'));
    temporaryDirectories.push(directory);
    const harness = createHarness(directory, {
      API_DATAGOUV_COMMUNES_2026_RESOURCE_ID: 'resource-2026',
    });
    harness.statisticCommuneService.getStatisticCommuneStreamForYear.mockResolvedValue(
      Readable.from([
        {
          commune_code: '01001',
          commune_nom: "L'Abergement-Clémenciat",
          sc_restrictions: [
            { date: '2026-07-31', SOU: null, SUP: 'alerte', AEP: null },
          ],
        },
        {
          commune_code: '01002',
          commune_nom: "L'Abergement-de-Varey",
          sc_restrictions: [],
        },
      ]),
    );
    const upload = jest
      .spyOn(harness.service, 'uploadToDatagouv')
      .mockResolvedValue();

    await harness.service.updateCommunes(2026);

    const archive = await JSZip.loadAsync(
      await readFile(join(directory, 'restrictions_communes_2026.zip')),
    );
    const json = await archive
      .file('restrictions_communes_2026.json')
      .async('string');
    expect(JSON.parse(json)).toEqual([
      {
        commune: { code: '01001', nom: "L'Abergement-Clémenciat" },
        restrictions: [
          { date: '2026-07-31', SOU: null, SUP: 'alerte', AEP: null },
        ],
      },
      {
        commune: { code: '01002', nom: "L'Abergement-de-Varey" },
        restrictions: [],
      },
    ]);
    expect(
      harness.statisticCommuneService.getStatisticCommuneStreamForYear,
    ).toHaveBeenCalledWith(2026);
    expect(upload).toHaveBeenCalledWith(
      'communes_2026',
      'restrictions_communes_2026.zip',
      'Communes en restrictions - 2026',
      false,
      { sourceDate: '2026-07-31' },
    );
  });

  it('does not upload an incomplete archive when the database stream fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vigieau-datagouv-'));
    temporaryDirectories.push(directory);
    const harness = createHarness(directory, {
      API_DATAGOUV_COMMUNES_2026_RESOURCE_ID: 'resource-2026',
    });
    harness.statisticCommuneService.getStatisticCommuneStreamForYear.mockResolvedValue(
      new Readable({
        objectMode: true,
        read() {
          this.destroy(new Error('database stream failed'));
        },
      }),
    );
    const previousArchivePath = join(
      directory,
      'restrictions_communes_2026.zip',
    );
    await writeFile(previousArchivePath, 'previous-complete-archive');
    const upload = jest.spyOn(harness.service, 'uploadToDatagouv');

    await expect(harness.service.updateCommunes(2026)).rejects.toThrow(
      'database stream failed',
    );
    expect(upload).not.toHaveBeenCalled();
    await expect(readFile(previousArchivePath, 'utf8')).resolves.toBe(
      'previous-complete-archive',
    );
    await expect(
      stat(join(directory, 'restrictions_communes_2026.zip.tmp')),
    ).rejects.toThrow();
  });

  it('does not publish annual communes when the latest source day is stale', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vigieau-datagouv-'));
    temporaryDirectories.push(directory);
    const harness = createHarness(directory, {
      API_DATAGOUV_COMMUNES_2026_RESOURCE_ID: 'resource-2026',
    });
    harness.statisticCommuneService.getStatisticCommuneStreamForYear.mockResolvedValue(
      Readable.from([
        {
          commune_code: '65440',
          commune_nom: 'Tarbes',
          sc_restrictions: [{ date: '2026-07-31', SUP: 'alerte' }],
        },
      ]),
    );
    const upload = jest
      .spyOn(harness.service, 'uploadToDatagouv')
      .mockResolvedValue();

    await expect(
      harness.service.updateCommunes(2026, '2026-08-01'),
    ).rejects.toThrow(
      'Historique incomplet pour la commune 65440: 1/213 jours',
    );
    expect(upload).not.toHaveBeenCalled();
  });

  it('publishes annual communes only with exact daily coverage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vigieau-datagouv-'));
    temporaryDirectories.push(directory);
    const harness = createHarness(directory, {
      API_DATAGOUV_COMMUNES_2026_RESOURCE_ID: 'resource-2026',
    });
    harness.statisticCommuneService.getStatisticCommuneStreamForYear.mockResolvedValue(
      Readable.from([
        {
          commune_code: '65440',
          commune_nom: 'Tarbes',
          sc_restrictions: dailyRestrictions('2026-01-01', '2026-07-31'),
        },
      ]),
    );
    const upload = jest
      .spyOn(harness.service, 'uploadToDatagouv')
      .mockResolvedValue();

    await harness.service.updateCommunes(2026, '2026-07-31');

    expect(upload).toHaveBeenCalledWith(
      'communes_2026',
      'restrictions_communes_2026.zip',
      'Communes en restrictions - 2026',
      false,
      { sourceDate: '2026-07-31' },
    );
  });

  it('rejects a source newer than the catch-up civil day', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vigieau-datagouv-'));
    temporaryDirectories.push(directory);
    const harness = createHarness(directory, {
      API_DATAGOUV_COMMUNES_2026_RESOURCE_ID: 'resource-2026',
    });
    harness.statisticCommuneService.getStatisticCommuneStreamForYear.mockResolvedValue(
      Readable.from([
        {
          commune_code: '65440',
          commune_nom: 'Tarbes',
          sc_restrictions: [{ date: '2026-08-01', SUP: 'alerte' }],
        },
      ]),
    );
    const upload = jest
      .spyOn(harness.service, 'uploadToDatagouv')
      .mockResolvedValue();

    await expect(
      harness.service.updateCommunes(2026, '2026-07-31'),
    ).rejects.toThrow(
      'Historique incomplet pour la commune 65440: 1/212 jours',
    );
    expect(upload).not.toHaveBeenCalled();
  });

  it('serializes concurrent read-modify-write operations for one map archive', async () => {
    const harness = createHarness('/tmp');
    const events: string[] = [];
    let finishFirst!: () => void;
    let retrySecond!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const firstRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) {
          events.push('lock:first');
          return [{ locked: true }];
        }
        events.push('unlock:first');
        return [{ unlocked: true }];
      }),
    };
    let secondLockAttempt = 0;
    const secondRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) {
          secondLockAttempt += 1;
          events.push(
            secondLockAttempt === 1 ? 'blocked:second' : 'lock:second',
          );
          return [{ locked: secondLockAttempt > 1 }];
        }
        events.push('unlock:second');
        return [{ unlocked: true }];
      }),
    };
    harness.dataSource.createQueryRunner
      .mockReset()
      .mockReturnValueOnce(firstRunner)
      .mockReturnValueOnce(secondRunner);
    jest
      .spyOn(harness.service as any, 'waitForMapArchiveLockRetry')
      .mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            retrySecond = resolve;
          }),
      );
    let generation = 0;
    const generateLocked = jest
      .spyOn(harness.service as any, 'generateMapsArchiveLocked')
      .mockImplementation(async () => {
        generation += 1;
        events.push(`generate:${generation}`);
        if (generation === 1) {
          await firstGate;
        }
      });

    const first = harness.service.generateMapsArchive(
      moment('2026-08-01'),
      2026,
      true,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const second = harness.service.generateMapsArchive(
      moment('2026-08-01'),
      2026,
      true,
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(generateLocked).toHaveBeenCalledTimes(1);
    finishFirst();
    await first;
    retrySecond();
    await second;

    expect(generateLocked).toHaveBeenCalledTimes(2);
    expect(events.indexOf('unlock:first')).toBeLessThan(
      events.indexOf('lock:second'),
    );
    expect(firstRunner.release).toHaveBeenCalledTimes(1);
    expect(secondRunner.release).toHaveBeenCalledTimes(1);
    expect(firstRunner.query).toHaveBeenCalledWith(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      ['vigieau:datagouv-map-archive:geojson:2026'],
    );
  });

  it('preserves a write failure while attempting unlock and releasing the connection', async () => {
    const harness = createHarness('/tmp');
    harness.queryRunner.query.mockImplementation(async (sql: string) =>
      sql.includes('pg_try_advisory_lock')
        ? [{ locked: true }]
        : [{ unlocked: false }],
    );
    jest
      .spyOn(harness.service as any, 'generateMapsArchiveLocked')
      .mockRejectedValue(new Error('archive write failed'));

    await expect(
      harness.service.generateMapsArchive(moment('2026-08-01'), 2026, false),
    ).rejects.toThrow('archive write failed');

    expect(harness.queryRunner.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked',
      ['vigieau:datagouv-map-archive:pmtiles:2026'],
    );
    expect(harness.queryRunner.release).toHaveBeenCalledTimes(1);
    expect(harness.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('LIBERATION DU VERROU'),
      expect.any(Error),
    );
  });

  it('releases the connection and reports a map archive unlock failure', async () => {
    const harness = createHarness('/tmp');
    harness.queryRunner.query.mockImplementation(async (sql: string) =>
      sql.includes('pg_try_advisory_lock')
        ? [{ locked: true }]
        : [{ unlocked: false }],
    );
    jest
      .spyOn(harness.service as any, 'generateMapsArchiveLocked')
      .mockResolvedValue(undefined);

    await expect(
      harness.service.generateMapsArchive(moment('2026-08-01'), 2026, true),
    ).rejects.toThrow("Impossible de libérer le verrou de l'archive geojson");

    expect(harness.queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('abandons a map archive lock wait when the publication deadline expires', async () => {
    jest.useFakeTimers();
    const harness = createHarness('/tmp', { DATAGOUV_RUN_TIMEOUT_MS: '10' });
    harness.queryRunner.query.mockResolvedValue([{ locked: false }]);
    const exit = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);

    const publication = (harness.service as any)
      .runWithDeadline(() =>
        harness.service.generateMapsArchive(moment('2026-08-01'), 2026, true),
      )
      .catch((error) => error);
    await jest.advanceTimersByTimeAsync(10);

    await expect(publication).resolves.toEqual(
      expect.objectContaining({ name: 'TimeoutError' }),
    );
    expect(harness.queryRunner.release).toHaveBeenCalledTimes(1);
    expect(
      harness.queryRunner.query.mock.calls.some(([sql]) =>
        sql.includes('pg_advisory_unlock'),
      ),
    ).toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });

  it('uses the stable local artifact for any time on the current day', async () => {
    jest
      .useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
      .setSystemTime(new Date('2026-08-01T12:00:00Z'));
    const directory = await mkdtemp(join(tmpdir(), 'vigieau-datagouv-'));
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, 'zones_arretes_en_vigueur.geojson'),
      '{"type":"FeatureCollection","features":[]}',
    );
    const harness = createHarness(directory);
    const notFound = Object.assign(new Error('not found'), {
      response: { status: 404 },
    });
    harness.httpService.get.mockReturnValue(throwError(() => notFound));
    harness.s3Service.headFile.mockImplementation(async () => ({
      ContentLength:
        harness.s3Service.uploadFile.mock.calls.at(-1)?.[0]?.buffer.length,
    }));
    const upload = jest
      .spyOn(harness.service, 'uploadToDatagouv')
      .mockResolvedValue();

    await harness.service.generateMapsArchive(
      moment('2026-08-01T00:00:00Z'),
      2026,
      true,
      moment('2026-08-01T23:59:59Z'),
    );

    const zip = await JSZip.loadAsync(
      harness.s3Service.uploadFile.mock.calls[0][0].buffer,
    );
    expect(
      zip.file('zones_arretes_en_vigueur_2026-08-01.geojson'),
    ).not.toBeNull();
    expect(upload).toHaveBeenCalledWith(
      'geojson_archive',
      'https://objects.example.test/archive.zip',
      'Cartes des zones et arrêtés en vigueur - GEOJSON - Année en cours',
      true,
      { sourceDate: '2026-08-01' },
    );
  });

  it('downloads the daily artifact from S3 when the clock has no local map', async () => {
    jest
      .useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
      .setSystemTime(new Date('2026-08-01T12:00:00Z'));
    const directory = await mkdtemp(join(tmpdir(), 'vigieau-datagouv-'));
    temporaryDirectories.push(directory);
    const harness = createHarness(directory);
    const notFound = Object.assign(new Error('not found'), {
      response: { status: 404 },
    });
    harness.httpService.get.mockImplementation((url: string) =>
      url.endsWith('.zip')
        ? throwError(() => notFound)
        : of({ data: Buffer.from('remote-pmtiles') }),
    );
    harness.s3Service.headFile.mockImplementation(async () => ({
      ContentLength:
        harness.s3Service.uploadFile.mock.calls.at(-1)?.[0]?.buffer.length,
    }));
    jest.spyOn(harness.service, 'uploadToDatagouv').mockResolvedValue();

    await harness.service.updateDailyMapArchive('2026-08-01', false);

    expect(harness.httpService.get).toHaveBeenCalledWith(
      'https://objects.example.test/pmtiles/zones_arretes_en_vigueur_2026-08-01.pmtiles',
      expect.objectContaining({
        responseType: 'arraybuffer',
        timeout: 60_000,
      }),
    );
    const zip = await JSZip.loadAsync(
      harness.s3Service.uploadFile.mock.calls[0][0].buffer,
    );
    await expect(
      zip
        .file('zones_arretes_en_vigueur_2026-08-01.pmtiles')
        ?.async('nodebuffer'),
    ).resolves.toEqual(Buffer.from('remote-pmtiles'));
  });

  it('never uploads a cartographic ZIP when no daily artifact was added', async () => {
    const harness = createHarness('/tmp', {
      API_DATAGOUV_GEOJSON_ARCHIVE_RESOURCE_ID: 'geojson-archive-resource',
    });
    const notFound = Object.assign(new Error('not found'), {
      response: { status: 404 },
    });
    harness.httpService.get.mockReturnValue(throwError(() => notFound));
    const upload = jest
      .spyOn(harness.service, 'uploadToDatagouv')
      .mockResolvedValue();

    await expect(
      harness.service.generateMapsArchive(
        moment().startOf('day'),
        moment().year(),
        true,
      ),
    ).rejects.toThrow('Aucun fichier geojson valide');
    expect(upload).not.toHaveBeenCalled();
  });

  it('does not replace an existing archive after a transient download error', async () => {
    const harness = createHarness('/tmp');
    harness.httpService.get.mockReturnValue(
      throwError(() => new Error('S3 temporarily unavailable')),
    );
    const upload = jest.spyOn(harness.service, 'uploadToDatagouv');

    await expect(
      harness.service.updateDailyMapArchive('2026-08-01', true),
    ).rejects.toThrow('S3 temporarily unavailable');

    expect(harness.s3Service.uploadFile).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it('streams the complete commune history directly into the historical ZIP', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vigieau-datagouv-'));
    temporaryDirectories.push(directory);
    const harness = createHarness(directory);
    harness.statisticCommuneService.getStatisticCommuneStream.mockResolvedValue(
      Readable.from([
        {
          commune_code: '01001',
          commune_nom: "L'Abergement-Clémenciat",
          sc_restrictions: [
            { date: '2013-01-01', SOU: null, SUP: null, AEP: null },
            { date: '2026-07-31', SOU: null, SUP: 'alerte', AEP: null },
          ],
        },
        {
          commune_code: '01002',
          commune_nom: "L'Abergement-de-Varey",
          sc_restrictions: null,
        },
      ]),
    );
    const upload = jest
      .spyOn(harness.service, 'uploadToDatagouv')
      .mockResolvedValue();

    await harness.service.updateHistoriqueCommunes();

    const archive = await JSZip.loadAsync(
      await readFile(join(directory, 'historique_communes.zip')),
    );
    const files = Object.keys(archive.files);
    expect(files).toEqual(['historique_communes.json']);
    const json = await archive.file('historique_communes.json').async('string');
    expect(JSON.parse(json)).toEqual([
      {
        commune: { code: '01001', nom: "L'Abergement-Clémenciat" },
        restrictions: [
          { date: '2013-01-01', SOU: null, SUP: null, AEP: null },
          { date: '2026-07-31', SOU: null, SUP: 'alerte', AEP: null },
        ],
      },
      {
        commune: { code: '01002', nom: "L'Abergement-de-Varey" },
        restrictions: null,
      },
    ]);
    expect(
      harness.statisticCommuneService.getStatisticCommuneStream,
    ).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith(
      'historique_communes',
      'historique_communes.zip',
      'Historique Communes',
      false,
      { sourceDate: '2026-07-31' },
    );
    expect(harness.queryRunner.query).toHaveBeenCalledTimes(2);
    expect(harness.queryRunner.startTransaction).not.toHaveBeenCalled();
    expect(harness.queryRunner.rollbackTransaction).not.toHaveBeenCalled();
    expect(harness.queryRunner.release).toHaveBeenCalledTimes(1);
    await expect(
      stat(join(directory, 'historique_communes.json')),
    ).rejects.toThrow();
  });

  it('keeps the previous historical ZIP and releases the lock after a partial stream failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vigieau-datagouv-'));
    temporaryDirectories.push(directory);
    const harness = createHarness(directory);
    let readCount = 0;
    harness.statisticCommuneService.getStatisticCommuneStream.mockResolvedValue(
      new Readable({
        objectMode: true,
        read() {
          if (readCount++ === 0) {
            this.push({
              commune_code: '01001',
              commune_nom: "L'Abergement-Clémenciat",
              sc_restrictions: [],
            });
          } else {
            this.destroy(new Error('database stream failed after one row'));
          }
        },
      }),
    );
    const archivePath = join(directory, 'historique_communes.zip');
    await writeFile(archivePath, 'previous-complete-archive');
    const upload = jest.spyOn(harness.service, 'uploadToDatagouv');

    await expect(harness.service.updateHistoriqueCommunes()).rejects.toThrow(
      'database stream failed after one row',
    );

    expect(upload).not.toHaveBeenCalled();
    await expect(readFile(archivePath, 'utf8')).resolves.toBe(
      'previous-complete-archive',
    );
    await expect(
      stat(join(directory, 'historique_communes.zip.tmp')),
    ).rejects.toThrow();
    expect(harness.queryRunner.query).toHaveBeenCalledTimes(2);
    expect(harness.queryRunner.startTransaction).not.toHaveBeenCalled();
    expect(harness.queryRunner.rollbackTransaction).not.toHaveBeenCalled();
    expect(harness.queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty historical archive instead of publishing it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vigieau-datagouv-'));
    temporaryDirectories.push(directory);
    const harness = createHarness(directory);
    harness.statisticCommuneService.getStatisticCommuneStream.mockResolvedValue(
      Readable.from([]),
    );
    jest.spyOn(harness.service, 'uploadToDatagouv').mockResolvedValue();

    await expect(harness.service.updateHistoriqueCommunes()).rejects.toThrow(
      'ne contient aucune commune',
    );
    await expect(
      stat(join(directory, 'historique_communes.zip')),
    ).rejects.toThrow();
  });

  it('rejects a concurrent historical publication before opening the data stream', async () => {
    const harness = createHarness('/tmp');
    harness.queryRunner.query
      .mockReset()
      .mockResolvedValue([{ locked: false }]);

    await expect(harness.service.updateHistoriqueCommunes()).rejects.toThrow(
      "Une publication de l'historique des communes est déjà en cours",
    );

    expect(
      harness.statisticCommuneService.getStatisticCommuneStream,
    ).not.toHaveBeenCalled();
    expect(harness.queryRunner.startTransaction).not.toHaveBeenCalled();
    expect(harness.queryRunner.rollbackTransaction).not.toHaveBeenCalled();
    expect(harness.queryRunner.release).toHaveBeenCalledTimes(1);
    expect(harness.httpService.post).not.toHaveBeenCalled();
  });

  it('rejects a missing historical resource before taking the export lock', async () => {
    const harness = createHarness('/tmp', {
      API_DATAGOUV_HISTORIQUE_COMMUNES_RESOURCE_ID: undefined,
    });

    await expect(harness.service.updateHistoriqueCommunes()).rejects.toThrow(
      'Ressource non configurée : historique_communes',
    );

    expect(harness.dataSource.createQueryRunner).not.toHaveBeenCalled();
    expect(
      harness.statisticCommuneService.getStatisticCommuneStream,
    ).not.toHaveBeenCalled();
  });

  it('uploads the historical archive to the existing resource UUID', async () => {
    const harness = createHarness('/tmp');
    jest.spyOn(fs, 'openAsBlob').mockResolvedValue(new Blob(['zip-content']));
    jest
      .spyOn(harness.service as any, 'inspectLocalArtifact')
      .mockResolvedValue({
        byteSize: 11,
        checksum: 'a'.repeat(64),
      });
    harness.httpService.get.mockReturnValue(
      of({
        data: {
          resources: [
            {
              id: '4322064e-cfb4-4c8a-8200-7620f491ccdb',
              title: 'Historique Communes',
              url: 'https://static.example.test/historique.zip',
              filesize: 11,
            },
          ],
        },
      }),
    );

    await harness.service.uploadToDatagouv(
      'historique_communes',
      'historique_communes.zip',
      'Historique Communes',
    );

    expect(harness.httpService.post).toHaveBeenCalledWith(
      'https://www.data.gouv.fr/api/1/datasets/dataset-id/resources/4322064e-cfb4-4c8a-8200-7620f491ccdb/upload/',
      expect.any(FormData),
      expect.any(Object),
    );
    expect(harness.httpService.put).toHaveBeenCalledWith(
      'https://www.data.gouv.fr/api/1/datasets/dataset-id/resources/4322064e-cfb4-4c8a-8200-7620f491ccdb/',
      { title: 'Historique Communes' },
      expect.any(Object),
    );
  });

  it('rejects a file upload when Datagouv omits the remote filesize', async () => {
    const harness = createHarness('/tmp');
    jest.spyOn(fs, 'openAsBlob').mockResolvedValue(new Blob(['zip-content']));
    jest
      .spyOn(harness.service as any, 'inspectLocalArtifact')
      .mockResolvedValue({
        byteSize: 11,
        checksum: 'a'.repeat(64),
      });
    harness.httpService.get.mockReturnValue(
      of({
        data: {
          resources: [
            {
              id: '4322064e-cfb4-4c8a-8200-7620f491ccdb',
              title: 'Historique Communes',
              url: 'https://static.example.test/historique.zip',
            },
          ],
        },
      }),
    );

    await expect(
      harness.service.uploadToDatagouv(
        'historique_communes',
        'historique_communes.zip',
        'Historique Communes',
      ),
    ).rejects.toThrow("n'expose aucune taille de fichier");

    expect(
      harness.publicationRegistry.recordResourceFailure,
    ).toHaveBeenCalled();
    expect(
      harness.publicationRegistry.recordResourceSuccess,
    ).not.toHaveBeenCalled();
  });

  it('applies an explicit timeout to URL resource updates', async () => {
    const harness = createHarness('/tmp');
    harness.httpService.get.mockReturnValue(
      of({
        data: {
          resources: [
            {
              id: 'a101ef59-0999-4b9a-a682-6f9b79d53c7e',
              title: 'PMTiles',
              url: 'https://objects.example.test/zones.pmtiles',
            },
          ],
        },
      }),
    );

    await harness.service.uploadToDatagouv(
      'pmtiles',
      'https://objects.example.test/zones.pmtiles',
      'PMTiles',
      true,
      { timeoutMs: 12_500 },
    );

    expect(harness.httpService.put).toHaveBeenCalledWith(
      'https://www.data.gouv.fr/api/1/datasets/dataset-id/resources/a101ef59-0999-4b9a-a682-6f9b79d53c7e/',
      {
        title: 'PMTiles',
        url: 'https://objects.example.test/zones.pmtiles',
      },
      expect.objectContaining({ timeout: 12_500 }),
    );
    expect(harness.httpService.post).not.toHaveBeenCalled();
  });

  it('creates the annual resource automatically when it is not configured', async () => {
    const harness = createHarness('/tmp');
    const createResource = jest
      .spyOn(harness.service, 'createOrUpdateCommunesResource')
      .mockResolvedValue('new-resource-id');

    await expect(harness.service.updateCommunes(2026)).resolves.toBeUndefined();

    expect(createResource).toHaveBeenCalledWith(2026, undefined);
    expect(
      harness.statisticCommuneService.getStatisticCommuneStreamForYear,
    ).not.toHaveBeenCalled();
    expect(harness.httpService.post).not.toHaveBeenCalled();
    expect(harness.publicationRegistry.resolveResourceId).toHaveBeenCalledWith(
      'communes_2026',
      'data.gouv.fr',
      undefined,
    );
  });

  it('never includes request headers in Datagouv error logs', async () => {
    const harness = createHarness('/tmp');
    const error = Object.assign(new Error('Unauthorized'), {
      code: 'ERR_BAD_REQUEST',
      response: { status: 401, statusText: 'Unauthorized' },
      config: { headers: { 'X-Api-Key': 'secret-api-key' } },
    });
    harness.httpService.put.mockReturnValue(throwError(() => error));

    await expect(
      harness.service.uploadToDatagouv(
        'pmtiles',
        'https://example.test/map.pmtiles',
        'PMTiles',
        true,
      ),
    ).rejects.toThrow('Unauthorized');

    const logged = JSON.stringify(harness.logger.error.mock.calls);
    expect(logged).toContain('401');
    expect(logged).not.toContain('secret-api-key');
    expect(logged).not.toContain('X-Api-Key');
  });

  it('streams file uploads from disk instead of loading them into memory', async () => {
    const harness = createHarness('/tmp', {
      API_DATAGOUV_COMMUNES_2026_RESOURCE_ID: 'resource-2026',
    });
    const openAsBlob = jest
      .spyOn(fs, 'openAsBlob')
      .mockResolvedValue(new Blob(['zip-content']));
    jest
      .spyOn(harness.service as any, 'inspectLocalArtifact')
      .mockResolvedValue({
        byteSize: 11,
        checksum: 'a'.repeat(64),
      });
    harness.httpService.get.mockReturnValue(
      of({
        data: {
          resources: [
            {
              id: 'resource-2026',
              title: 'Communes en restrictions - 2026',
              url: 'https://static.example.test/communes.zip',
              filesize: 11,
            },
          ],
        },
      }),
    );

    await harness.service.uploadToDatagouv(
      'communes_2026',
      'restrictions_communes_2026.zip',
      'Communes en restrictions - 2026',
    );

    expect(openAsBlob).toHaveBeenCalledWith(
      '/tmp/restrictions_communes_2026.zip',
    );
    expect(harness.httpService.post).toHaveBeenCalledWith(
      'https://www.data.gouv.fr/api/1/datasets/dataset-id/resources/resource-2026/upload/',
      expect.any(FormData),
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: 'application/json' }),
      }),
    );
  });

  it('creates the annual resource once and returns its identifier', async () => {
    const harness = createHarness('/tmp');
    jest
      .spyOn(harness.service as any, 'generateCommunesArchive')
      .mockResolvedValue({
        byteSize: 100,
        checksum: 'a'.repeat(64),
        sourceDate: '2026-08-01',
      });
    jest
      .spyOn(harness.service as any, 'findDataGouvCommuneResources')
      .mockResolvedValue([]);
    const upload = jest
      .spyOn(harness.service as any, 'uploadDataGouvFile')
      .mockResolvedValue({ id: 'new-resource-id' });
    const updateMetadata = jest
      .spyOn(harness.service as any, 'updateDataGouvResource')
      .mockResolvedValue(undefined);
    jest
      .spyOn(harness.service as any, 'verifyDataGouvResource')
      .mockResolvedValue({
        id: 'new-resource-id',
        title: 'Communes en restrictions - 2026',
        url: 'https://static.example.test/communes.zip',
      });

    await expect(
      harness.service.createOrUpdateCommunesResource(2026),
    ).resolves.toBe('new-resource-id');

    expect(upload).toHaveBeenCalledWith(
      'https://www.data.gouv.fr/api/1/datasets/dataset-id/upload/',
      'restrictions_communes_2026.zip',
    );
    expect(updateMetadata).toHaveBeenCalledWith(
      'new-resource-id',
      expect.objectContaining({
        title: 'Communes en restrictions - 2026',
        type: 'update',
      }),
    );
  });

  it('reuses an annual resource left by an interrupted first publication', async () => {
    const harness = createHarness('/tmp');
    jest
      .spyOn(harness.service as any, 'generateCommunesArchive')
      .mockResolvedValue({
        byteSize: 100,
        checksum: 'a'.repeat(64),
        sourceDate: '2026-08-01',
      });
    harness.httpService.get.mockReturnValue(
      of({
        data: {
          resources: [
            {
              id: 'existing-resource-id',
              title: 'restrictions_communes_2026.zip',
              url: 'https://static.data.gouv.fr/resources/dataset/20260731/restrictions-communes-2026.zip',
            },
          ],
        },
      }),
    );
    const upload = jest
      .spyOn(harness.service as any, 'uploadDataGouvFile')
      .mockResolvedValue({});
    jest
      .spyOn(harness.service as any, 'updateDataGouvResource')
      .mockResolvedValue(undefined);
    jest
      .spyOn(harness.service as any, 'verifyDataGouvResource')
      .mockResolvedValue({
        id: 'existing-resource-id',
        title: 'Communes en restrictions - 2026',
        url: 'https://static.example.test/communes.zip',
      });

    await expect(
      harness.service.createOrUpdateCommunesResource(2026),
    ).resolves.toBe('existing-resource-id');

    expect(harness.httpService.get).toHaveBeenCalledWith(
      'https://www.data.gouv.fr/api/1/datasets/dataset-id/',
      {
        headers: { Accept: 'application/json' },
        timeout: 60_000,
        signal: undefined,
      },
    );
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith(
      'https://www.data.gouv.fr/api/1/datasets/dataset-id/resources/existing-resource-id/upload/',
      'restrictions_communes_2026.zip',
    );
  });
});
