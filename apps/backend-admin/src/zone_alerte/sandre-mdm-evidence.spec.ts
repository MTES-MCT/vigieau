import { fingerprint } from './sandre-zone-reconciliation';
import {
  fetchSandreMdmNomenclatureEvidence,
  fetchSandreMdmZoneRecordEvidence,
  loadSandreMdmProofWithRetry,
  projectSandreMdmNomenclatureNode,
  projectSandreMdmZoneRecord,
  SANDRE_MDM_MAX_ZONE_RECORD_BYTES,
  SANDRE_MDM_ZONE_RECORD_BASE_URL,
  SandreMdmProofDeadlineExceededError,
  SandreMdmTransientError,
  SandreMdmTransportResponse,
} from './sandre-mdm-evidence';

describe('Sandre MDM split evidence', () => {
  const cases = [
    {
      codeSandre: '355',
      projectionSha256:
        'b7b16963402b459df4f882bc18962a284167d725fd05e718ca1ac68666b97504',
      requiredEvolution: null,
      projection: {
        alternate: [{ value: '52_85_000014' }],
        changed: '1786623536',
        code: [{ value: '355' }],
        dateCreated: [date('2024-02-08T00:00:00')],
        dateUpdated: [date('2024-02-08T00:00:00')],
        evolutionComments: [
          { value: null },
          { value: 'Importation depuis un fichier shp.' },
        ],
        evolutionDates: [datetime(null), datetime('2026-08-13 14:18:56')],
        evolutionTypes: [{ nid: null }, { nid: '282834' }],
        nid: '854735',
        status: [{ nid: '6513' }],
        title: '[355] Marais Sèvre Niortaise',
        undergoes: [{ nid: null }],
      },
    },
    {
      codeSandre: '3947',
      projectionSha256:
        '098dd3dc60cfdda243c57446c3ae65239236f7fc7e4b6bc3bc783e262497d2fa',
      requiredEvolution: {
        typeNid: '282836',
        date: '2026-06-30 00:00:00',
        comment: 'Division de la ZAS 355',
      },
      projection: targetProjection({
        code: '3947',
        alternate: '52_85_000016',
        changed: '1786623535',
        nid: '1008327',
        title: '[3947] Marais Autizes',
        importedAt: '2026-08-13 14:18:55',
      }),
    },
    {
      codeSandre: '3948',
      projectionSha256:
        '7ae78c09c40975d09e3ce51bc8b7db433fd0651b178d501e38a0e112f8f59b06',
      requiredEvolution: {
        typeNid: '282836',
        date: '2026-06-30 00:00:00',
        comment: 'Division de la ZAS 355',
      },
      projection: targetProjection({
        code: '3948',
        alternate: '52_85_000017',
        changed: '1786623533',
        nid: '1008328',
        title: '[3948] Marais Niortaise',
        importedAt: '2026-08-13 14:18:52',
      }),
    },
  ] as const;

  it.each(cases)(
    'accepts exact official projection $codeSandre',
    async (item) => {
      expect(fingerprint(item.projection)).toBe(item.projectionSha256);
      const raw = JSON.stringify(rawRecord(item.projection));
      await expect(
        fetchSandreMdmZoneRecordEvidence(item, async (url) =>
          response(url, raw),
        ),
      ).resolves.toEqual(
        expect.objectContaining({
          codeSandre: item.codeSandre,
          projectionSha256: item.projectionSha256,
          byteLength: Buffer.byteLength(raw),
        }),
      );
    },
  );

  it.each([
    ['HTTP status', { status: 500 }],
    ['media type', { contentType: 'text/html' }],
    ['redirect', { finalUrl: 'https://example.test/redirected' }],
  ])('rejects %s drift', async (_label, override) => {
    const item = cases[1];
    const url = `${SANDRE_MDM_ZONE_RECORD_BASE_URL}/${item.codeSandre}/json`;
    await expect(
      fetchSandreMdmZoneRecordEvidence(item, async () => ({
        ...response(url, JSON.stringify(rawRecord(item.projection))),
        ...override,
      })),
    ).rejects.toThrow('Invalid Sandre MDM response');
  });

  it('rejects size, projection and evolution drift', async () => {
    const item = cases[1];
    const url = `${SANDRE_MDM_ZONE_RECORD_BASE_URL}/${item.codeSandre}/json`;
    await expect(
      fetchSandreMdmZoneRecordEvidence(item, async () =>
        response(url, 'x'.repeat(SANDRE_MDM_MAX_ZONE_RECORD_BYTES + 1)),
      ),
    ).rejects.toThrow('source size');

    const projectionDrift = {
      ...item.projection,
      title: `${item.projection.title} drift`,
    };
    await expect(
      fetchSandreMdmZoneRecordEvidence(item, async () =>
        response(url, JSON.stringify(rawRecord(projectionDrift))),
      ),
    ).rejects.toThrow('projection changed');

    const evolutionDrift = {
      ...item.projection,
      evolutionComments: [{ value: 'Division de la ZAS 356' }],
    };
    const driftExpectation = {
      ...item,
      projectionSha256: fingerprint(evolutionDrift),
    };
    await expect(
      fetchSandreMdmZoneRecordEvidence(driftExpectation, async () =>
        response(url, JSON.stringify(rawRecord(evolutionDrift))),
      ),
    ).rejects.toThrow('arrays are misaligned');
  });

  it('fails closed on incomplete records', () => {
    expect(() => projectSandreMdmZoneRecord({ nid: '1' })).toThrow(
      'Incomplete Sandre MDM zone record',
    );
  });

  it('seals the official creation nomenclature linked by nid', async () => {
    const expectation = {
      nid: '282836',
      nomenclatureCode: '590',
      title: 'Création',
      code: '7',
      mnemonic: 'Création',
      projectionSha256:
        'a14aea447a72ba382e3645c02b89dda903c38f2b147cab46b605ff455387020d',
    };
    const html = nomenclatureHtml();
    expect(
      fingerprint(projectSandreMdmNomenclatureNode(html, '282836', '590')),
    ).toBe(expectation.projectionSha256);
    await expect(
      fetchSandreMdmNomenclatureEvidence(expectation, async (url) => ({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        finalUrl: url,
        body: html,
      })),
    ).resolves.toEqual(
      expect.objectContaining({
        projectionSha256: expectation.projectionSha256,
        projection: expect.objectContaining({ code: '7', title: 'Création' }),
      }),
    );
  });

  it('rejects nomenclature nid, label, media and redirect drift', async () => {
    const expectation = {
      nid: '282836',
      nomenclatureCode: '590',
      title: 'Création',
      code: '7',
      mnemonic: 'Création',
      projectionSha256:
        'a14aea447a72ba382e3645c02b89dda903c38f2b147cab46b605ff455387020d',
    };
    const fetch = (body: string, override = {}) =>
      fetchSandreMdmNomenclatureEvidence(expectation, async (url) => ({
        status: 200,
        contentType: 'text/html',
        finalUrl: url,
        body,
        ...override,
      }));
    await expect(fetch(nomenclatureHtml('8'))).rejects.toThrow(
      'projection changed',
    );
    await expect(
      fetch(nomenclatureHtml(), { contentType: 'application/json' }),
    ).rejects.toThrow('response');
    await expect(
      fetch(nomenclatureHtml(), { finalUrl: 'https://example.test/node' }),
    ).rejects.toThrow('response');
    expect(() =>
      projectSandreMdmNomenclatureNode(
        nomenclatureHtml().replace('node-282836', 'node-1'),
        '282836',
        '590',
      ),
    ).toThrow('root');
  });

  it('restarts the complete proof after a transient failure and recovers', async () => {
    const completedReads: string[] = [];
    let attempt = 0;
    const loadProof = jest.fn(async () => {
      attempt++;
      completedReads.push(`${attempt}:355`, `${attempt}:3947`);
      if (attempt === 1) {
        throw new SandreMdmTransientError('HTTP 500 for 3947');
      }
      completedReads.push(`${attempt}:3948`, `${attempt}:282836`);
      return 'complete-proof';
    });
    const waitForRetry = jest.fn().mockResolvedValue(undefined);

    await expect(
      loadSandreMdmProofWithRetry(loadProof, waitForRetry, {
        attempts: 3,
      }),
    ).resolves.toBe('complete-proof');
    expect(loadProof).toHaveBeenCalledTimes(2);
    expect(waitForRetry).toHaveBeenCalledTimes(1);
    expect(waitForRetry).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ expiresAt: expect.any(Number) }),
    );
    expect(completedReads).toEqual([
      '1:355',
      '1:3947',
      '2:355',
      '2:3947',
      '2:3948',
      '2:282836',
    ]);
  });

  it('fails closed after exhausting the transient proof retry budget', async () => {
    const transient = new SandreMdmTransientError('HTTP 500');
    const loadProof = jest.fn().mockRejectedValue(transient);
    const waitForRetry = jest.fn().mockResolvedValue(undefined);

    await expect(
      loadSandreMdmProofWithRetry(loadProof, waitForRetry, {
        attempts: 3,
      }),
    ).rejects.toMatchObject({
      message: 'Sandre MDM proof retry budget exhausted after 3 attempts',
      cause: transient,
    });
    expect(loadProof).toHaveBeenCalledTimes(3);
    expect(waitForRetry.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2]);
  });

  it('does not retry validation drift', async () => {
    const validationError = new Error(
      'Sandre MDM projection changed for zone 3947',
    );
    const loadProof = jest.fn().mockRejectedValue(validationError);
    const waitForRetry = jest.fn().mockResolvedValue(undefined);

    await expect(
      loadSandreMdmProofWithRetry(loadProof, waitForRetry, {
        attempts: 5,
      }),
    ).rejects.toBe(validationError);
    expect(loadProof).toHaveBeenCalledTimes(1);
    expect(waitForRetry).not.toHaveBeenCalled();
  });

  it('enforces one monotonic deadline across proof attempts and backoffs', async () => {
    let now = 1_000;
    const transient = new SandreMdmTransientError('HTTP 500');
    const loadProof = jest.fn(async () => {
      now += 40;
      throw transient;
    });
    const waitForRetry = jest.fn(async () => {
      now += 20;
    });

    await expect(
      loadSandreMdmProofWithRetry(loadProof, waitForRetry, {
        attempts: 5,
        timeoutMs: 100,
        now: () => now,
      }),
    ).rejects.toMatchObject({
      name: 'SandreMdmProofDeadlineExceededError',
      cause: transient,
    });
    expect(loadProof).toHaveBeenCalledTimes(2);
    expect(waitForRetry).toHaveBeenCalledTimes(1);
    expect(now).toBe(1_100);
  });

  it('actively cancels a retried proof at one wall-clock deadline', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-16T12:00:00.000Z'));
    try {
      let attempt = 0;
      const observedSignals: AbortSignal[] = [];
      const cancellation = jest.fn();
      const transient = new SandreMdmTransientError('HTTP 500');
      const loadProof = jest.fn(
        (budget: { signal: AbortSignal }): Promise<string> => {
          attempt++;
          observedSignals.push(budget.signal);
          if (attempt === 1) {
            return Promise.reject(transient);
          }
          return new Promise((_resolve, reject) => {
            budget.signal.addEventListener(
              'abort',
              () => {
                cancellation();
                reject(budget.signal.reason);
              },
              { once: true },
            );
          });
        },
      );
      const waitForRetry = jest.fn().mockResolvedValue(undefined);
      const proof = loadSandreMdmProofWithRetry(loadProof, waitForRetry, {
        attempts: 3,
        timeoutMs: 100,
        now: () => Date.now(),
      });
      const rejection = expect(proof).rejects.toBeInstanceOf(
        SandreMdmProofDeadlineExceededError,
      );

      await jest.advanceTimersByTimeAsync(0);
      expect(loadProof).toHaveBeenCalledTimes(2);
      expect(waitForRetry).toHaveBeenCalledTimes(1);
      expect(observedSignals[0]).toBe(observedSignals[1]);
      expect(jest.getTimerCount()).toBe(1);

      await jest.advanceTimersByTimeAsync(99);
      expect(cancellation).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      await rejection;

      expect(cancellation).toHaveBeenCalledTimes(1);
      expect(observedSignals[0].aborted).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears the wall-clock deadline timer after an early proof success', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-16T12:00:00.000Z'));
    try {
      let signal: AbortSignal | undefined;

      await expect(
        loadSandreMdmProofWithRetry(
          async (budget) => {
            signal = budget.signal;
            return 'complete-proof';
          },
          jest.fn(),
          { timeoutMs: 100, now: () => Date.now() },
        ),
      ).resolves.toBe('complete-proof');

      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(100);
      expect(signal?.aborted).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails before starting work when the monotonic proof deadline is spent', async () => {
    const clockReadings = [5_000, 5_010];
    const loadProof = jest.fn(async () => 'unreachable');
    const waitForRetry = jest.fn().mockResolvedValue(undefined);
    const proof = loadSandreMdmProofWithRetry(loadProof, waitForRetry, {
      timeoutMs: 10,
      now: () => clockReadings.shift() ?? 5_010,
    });

    await expect(proof).rejects.toBeInstanceOf(
      SandreMdmProofDeadlineExceededError,
    );
    expect(loadProof).not.toHaveBeenCalled();
    expect(waitForRetry).not.toHaveBeenCalled();
  });
});

function nomenclatureHtml(code = '7'): string {
  return `<!doctype html><html><body>
    <article id="node-282836" class="node node-nsa_590">
      <h2>Création</h2>
      <div class="field"><div class="field-label">CdElement:</div><div class="field-item">${code}</div></div>
      <div class="field"><div class="field-label">MnElement:</div><div class="field-item">Création</div></div>
    </article>
  </body></html>`;
}

function rawRecord(projection: Record<string, any>): Record<string, unknown> {
  return {
    nid: projection.nid,
    title: projection.title,
    changed: projection.changed,
    field_zas_cdzas: projection.code,
    field_zas_statutzas: projection.status,
    field_zas_typeevolution: projection.evolutionTypes,
    field_zas_dateevolution: projection.evolutionDates,
    field_zas_comevolution: projection.evolutionComments,
    field_zas_subitevolution: projection.undergoes,
    field_zas_codealternatif: projection.alternate,
    field_zas_datecreazas: projection.dateCreated,
    field_zas_datemajzas: projection.dateUpdated,
  };
}

function targetProjection(input: {
  code: string;
  alternate: string;
  changed: string;
  nid: string;
  title: string;
  importedAt: string;
}): Record<string, unknown> {
  return {
    alternate: [{ value: input.alternate }],
    changed: input.changed,
    code: [{ value: input.code }],
    dateCreated: [date('2026-06-30T00:00:00')],
    dateUpdated: [date('2026-06-30T00:00:00')],
    evolutionComments: [
      { value: 'Division de la ZAS 355' },
      { value: 'Importation depuis un fichier shp.' },
    ],
    evolutionDates: [
      datetime('2026-06-30 00:00:00'),
      datetime(input.importedAt),
    ],
    evolutionTypes: [{ nid: '282836' }, { nid: '282834' }],
    nid: input.nid,
    status: [{ nid: '6514' }],
    title: input.title,
    undergoes: [{ nid: null }],
  };
}

function date(value: string): Record<string, unknown> {
  return {
    date_type: 'date',
    timezone: 'Europe/Paris',
    timezone_db: 'Europe/Paris',
    value,
  };
}

function datetime(value: string | null): Record<string, unknown> {
  return {
    date_type: 'datetime',
    timezone: 'Europe/Paris',
    timezone_db: 'Europe/Paris',
    value,
  };
}

function response(url: string, body: string): SandreMdmTransportResponse {
  return {
    status: 200,
    contentType: 'application/json',
    finalUrl: url,
    body,
  };
}
