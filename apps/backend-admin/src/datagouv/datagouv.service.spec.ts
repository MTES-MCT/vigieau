import * as fs from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
    getStatisticCommuneStreamForYear: jest.Mock;
  };
  httpService: {
    get: jest.Mock;
    post: jest.Mock;
    put: jest.Mock;
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
    getStatisticCommuneStreamForYear: jest.fn(),
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

  it('continues all independent exports and runs communes before maps', async () => {
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
    const updateMaps = jest
      .spyOn(harness.service, 'updateMaps')
      .mockRejectedValue(new Error('resource not found'));

    await harness.service.updateDatagouvData();

    expect(updateArretes).toHaveBeenCalledTimes(1);
    expect(updateHistoriqueArretes).toHaveBeenCalledTimes(1);
    expect(updateArretesCadre).toHaveBeenCalledTimes(1);
    expect(updateRestrictions).toHaveBeenCalledTimes(1);
    expect(updateCommunes).toHaveBeenCalledTimes(1);
    expect(updateMaps).toHaveBeenCalledTimes(1);
    expect(updateCommunes.mock.invocationCallOrder[0]).toBeLessThan(
      updateMaps.mock.invocationCallOrder[0],
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
    const upload = jest.spyOn(harness.service, 'uploadToDatagouv');

    await expect(harness.service.updateCommunes(2026)).rejects.toThrow(
      'database stream failed',
    );
    expect(upload).not.toHaveBeenCalled();
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
