import * as fs from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import * as JSZip from 'jszip';
import { of, throwError } from 'rxjs';
import { DatagouvService } from './datagouv.service';

interface ServiceHarness {
  service: DatagouvService;
  arreteRestrictionService: { findDatagouv: jest.Mock };
  statisticCommuneService: {
    getStatisticCommuneStream: jest.Mock;
    getStatisticCommuneStreamForYear: jest.Mock;
  };
  httpService: {
    get: jest.Mock;
    post: jest.Mock;
    put: jest.Mock;
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
  const queryRunner = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([{ locked: true }]),
    release: jest.fn().mockResolvedValue(undefined),
    isTransactionActive: true,
  };
  const dataSource = {
    createQueryRunner: jest.fn().mockReturnValue(queryRunner),
  };
  const service = new DatagouvService(
    httpService as any,
    arreteRestrictionService as any,
    {} as any,
    { get: jest.fn((key: string) => values[key]) } as any,
    {} as any,
    {} as any,
    {} as any,
    statisticCommuneService as any,
    dataSource as any,
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
    statisticCommuneService,
    httpService,
    dataSource,
    queryRunner,
    logger,
  };
}

describe('DatagouvService', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('continues all exports without delaying the existing maps publication', async () => {
    const harness = createHarness('/tmp');
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
    const updateMaps = jest
      .spyOn(harness.service, 'updateMaps')
      .mockRejectedValue(new Error('resource not found'));

    await harness.service.updateDatagouvData();

    expect(updateArretes).toHaveBeenCalledTimes(1);
    expect(updateHistoriqueArretes).toHaveBeenCalledTimes(1);
    expect(updateArretesCadre).toHaveBeenCalledTimes(1);
    expect(updateRestrictions).toHaveBeenCalledTimes(1);
    expect(updateCommunes).toHaveBeenCalledTimes(1);
    expect(updateHistoriqueCommunes).toHaveBeenCalledTimes(1);
    expect(updateMaps).toHaveBeenCalledTimes(1);
    expect(updateCommunes.mock.invocationCallOrder[0]).toBeLessThan(
      updateMaps.mock.invocationCallOrder[0],
    );
    expect(updateMaps.mock.invocationCallOrder[0]).toBeLessThan(
      updateHistoriqueCommunes.mock.invocationCallOrder[0],
    );
    expect(harness.logger.error).toHaveBeenCalledTimes(2);
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
    );
    expect(harness.queryRunner.query).toHaveBeenCalledTimes(1);
    expect(harness.queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
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
    expect(harness.queryRunner.query).toHaveBeenCalledTimes(1);
    expect(harness.queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(harness.queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('writes a valid empty historical JSON array', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vigieau-datagouv-'));
    temporaryDirectories.push(directory);
    const harness = createHarness(directory);
    harness.statisticCommuneService.getStatisticCommuneStream.mockResolvedValue(
      Readable.from([]),
    );
    jest.spyOn(harness.service, 'uploadToDatagouv').mockResolvedValue();

    await harness.service.updateHistoriqueCommunes();

    const archive = await JSZip.loadAsync(
      await readFile(join(directory, 'historique_communes.zip')),
    );
    await expect(
      archive.file('historique_communes.json').async('string'),
    ).resolves.toBe('[]');
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
    expect(harness.queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
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

  it('applies an explicit timeout to URL resource updates', async () => {
    const harness = createHarness('/tmp');

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

  it('skips the annual query when its resource is not configured', async () => {
    const harness = createHarness('/tmp');

    await harness.service.updateCommunes(2026);

    expect(
      harness.statisticCommuneService.getStatisticCommuneStreamForYear,
    ).not.toHaveBeenCalled();
    expect(harness.httpService.post).not.toHaveBeenCalled();
    expect(harness.logger.warn).toHaveBeenCalledWith(
      'Ressource non configurée : communes_2026',
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
      .mockResolvedValue(undefined);
    jest
      .spyOn(harness.service as any, 'findDataGouvCommuneResources')
      .mockResolvedValue([]);
    const upload = jest
      .spyOn(harness.service as any, 'uploadDataGouvFile')
      .mockResolvedValue({ id: 'new-resource-id' });
    const updateMetadata = jest
      .spyOn(harness.service as any, 'updateDataGouvResource')
      .mockResolvedValue(undefined);

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
      .mockResolvedValue(undefined);
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

    await expect(
      harness.service.createOrUpdateCommunesResource(2026),
    ).resolves.toBe('existing-resource-id');

    expect(harness.httpService.get).toHaveBeenCalledWith(
      'https://www.data.gouv.fr/api/1/datasets/dataset-id/',
      { headers: { Accept: 'application/json' } },
    );
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith(
      'https://www.data.gouv.fr/api/1/datasets/dataset-id/resources/existing-resource-id/upload/',
      'restrictions_communes_2026.zip',
    );
  });
});
