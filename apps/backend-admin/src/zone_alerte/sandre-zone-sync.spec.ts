import {
  buildSandreFeatureCountUrl,
  buildSandreZonesUrl,
  createSandreZoneSnapshot,
  extractSandreAlternateCodes,
  fetchSandreZoneSnapshot,
  parseSandreFeatureCount,
  parseSandreZoneFeature,
} from './sandre-zone-sync';

describe('Sandre zone synchronization helpers', () => {
  const feature = (overrides: Record<string, any> = {}) => ({
    type: 'Feature',
    properties: {
      gid: '3183',
      CdZAS: '3183',
      CdDepartement: '65',
      CodesAlternatifs:
        '{"{\\"code\\":\\"73_65_10\\"}","{\\"code\\":\\"4\\"}"}',
      LbZAS: 'Zone test',
      TypeZAS: 'SUP',
      StZAS: 'Validé',
      DateMajZAS: '2024-04-26',
      NumeroVersionZAS: '2',
      NumCircAdminBassin: '05',
      RessInfluenceeZAS: 1,
      ...overrides,
    },
    geometry: {
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [0, 43],
            [1, 43],
            [0.5, 44],
            [0, 43],
          ],
        ],
      ],
    },
  });

  it('builds a paginated and XML-escaped WFS URL', () => {
    const url = new URL(
      buildSandreZonesUrl('https://services.sandre.test/', `65<&"'`, 1000, 250),
    );

    expect(url.pathname).toBe('/geo/zas');
    expect(Object.fromEntries(url.searchParams.entries())).toEqual(
      expect.objectContaining({
        SERVICE: 'WFS',
        VERSION: '2.0.0',
        REQUEST: 'GetFeature',
        typename: 'ZAS',
        SRSNAME: 'EPSG:4326',
        OUTPUTFORMAT: 'GeoJSON',
        COUNT: '250',
        STARTINDEX: '1000',
        SORTBY: 'CdZAS',
      }),
    );
    expect(url.searchParams.get('Filter')).toContain(
      '<Literal>65&lt;&amp;&quot;&apos;</Literal>',
    );
    expect(url.searchParams.get('Filter')).not.toContain('<And>');
  });

  it('uses a strict Sandre source-date filter for change probes', () => {
    const url = new URL(
      buildSandreFeatureCountUrl(
        'https://services.sandre.test',
        '65',
        '2026-07-31',
      ),
    );
    const filter = url.searchParams.get('Filter');

    expect(filter).toContain('<And>');
    expect(filter).toContain('PropertyIsGreaterThan');
    expect(filter).toContain('<PropertyName>DateMajZAS</PropertyName>');
    expect(filter).toContain('<Literal>2026-07-31</Literal>');
    expect(filter).not.toContain('PropertyIsGreaterThanOrEqualTo');
    expect(url.searchParams.get('RESULTTYPE')).toBe('hits');
  });

  it('can include the latest source date to detect same-day changes', () => {
    const url = new URL(
      buildSandreFeatureCountUrl(
        'https://services.sandre.test',
        '65',
        '2026-07-31',
        true,
      ),
    );
    const filter = url.searchParams.get('Filter');

    expect(filter).toContain('PropertyIsGreaterThanOrEqualTo');
    expect(filter).not.toContain(
      '<PropertyIsGreaterThan><PropertyName>DateMajZAS',
    );
  });

  it('parses the WFS hits count and rejects exception responses', () => {
    expect(
      parseSandreFeatureCount(`
        <wfs:FeatureCollection
          xmlns:wfs="http://www.opengis.net/wfs/2.0"
          numberMatched="52"
          numberReturned="0">
        </wfs:FeatureCollection>
      `),
    ).toBe(52);
    expect(() =>
      parseSandreFeatureCount(
        '<ows:ExceptionReport>invalid</ows:ExceptionReport>',
      ),
    ).toThrow('Invalid Sandre count response');
  });

  it('parses canonical identity separately from alternate display codes', () => {
    const geometry = feature().geometry;
    const parsed = parseSandreZoneFeature(feature(), '65');

    expect(parsed).toEqual(
      expect.objectContaining({
        gid: 3183,
        codeSandre: '3183',
        alternateCodes: ['4', '73_65_10'],
        preferredAlternateCode: '73_65_10',
        departmentCode: '65',
        name: 'Zone test',
        type: 'SUP',
        status: 'Validé',
        sourceUpdatedAt: '2024-04-26',
        version: 2,
        basinCode: 5,
        influencedResource: true,
        geometry,
      }),
    );
    expect(parsed.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('normalizes nested and serialized alternate codes', () => {
    expect(
      extractSandreAlternateCodes([
        '{"{\\"code\\":\\"73_65_10\\"}"}',
        { nested: { code: ' 4 ' } },
        { code: '73_65_10' },
        null,
      ]),
    ).toEqual(['4', '73_65_10']);
  });

  it('keeps the historical CdAltZAS display-code priority', () => {
    expect(
      parseSandreZoneFeature(
        feature({
          CdAltZAS: 'preferred-code',
        }),
        '65',
      ),
    ).toEqual(
      expect.objectContaining({
        alternateCodes: ['4', '73_65_10', 'preferred-code'],
        preferredAlternateCode: 'preferred-code',
      }),
    );
  });

  it('accepts an inactive feature without geometry and normalizes an optional version', () => {
    const rawFeature = feature({
      StZAS: 'Gelé',
      NumeroVersionZAS: '',
    });
    rawFeature.geometry = null;

    expect(parseSandreZoneFeature(rawFeature, '65')).toEqual(
      expect.objectContaining({
        status: 'Gelé',
        sourceUpdatedAt: '2024-04-26',
        version: null,
        geometry: null,
      }),
    );
  });

  it.each([
    {
      name: 'unknown status',
      overrides: { StZAS: 'Projet' },
      geometry: undefined,
    },
    {
      name: 'missing gid',
      overrides: { gid: '' },
      geometry: undefined,
    },
    {
      name: 'missing basin',
      overrides: { NumCircAdminBassin: null },
      geometry: undefined,
    },
    {
      name: 'invalid resource flag',
      overrides: { RessInfluenceeZAS: 2 },
      geometry: undefined,
    },
    {
      name: 'invalid update date',
      overrides: { DateMajZAS: '26/04/2024' },
      geometry: undefined,
    },
    {
      name: 'empty geometry',
      overrides: {},
      geometry: { type: 'MultiPolygon', coordinates: [] },
    },
    {
      name: 'non-polygon geometry',
      overrides: {},
      geometry: { type: 'Point', coordinates: [0, 43] },
    },
  ])('rejects a feature with $name', ({ overrides, geometry }) => {
    const rawFeature = feature(overrides);
    if (geometry) {
      rawFeature.geometry = geometry;
    }

    expect(() => parseSandreZoneFeature(rawFeature, '65')).toThrow(
      /Invalid Sandre/,
    );
  });

  it('rejects a validated feature without geometry', () => {
    const rawFeature = feature();
    rawFeature.geometry = null;

    expect(() => parseSandreZoneFeature(rawFeature, '65')).toThrow(
      'Invalid Sandre geometry for zone 3183',
    );
  });

  it.each([
    {
      name: 'an unclosed ring',
      coordinates: [
        [
          [
            [0, 43],
            [1, 43],
            [0.5, 44],
            [0.2, 43],
          ],
        ],
      ],
    },
    {
      name: 'an out-of-range position',
      coordinates: [
        [
          [
            [0, 43],
            [181, 43],
            [0.5, 44],
            [0, 43],
          ],
        ],
      ],
    },
  ])('rejects $name', ({ coordinates }) => {
    const raw = feature();
    raw.geometry = { type: 'MultiPolygon', coordinates };
    expect(() => parseSandreZoneFeature(raw, '65')).toThrow(
      'Invalid Sandre geometry',
    );
  });

  it('rejects a feature from another department', () => {
    expect(() => parseSandreZoneFeature(feature(), '64')).toThrow(
      'Invalid Sandre department: expected 64, received 65',
    );
  });

  it.each([
    [[feature()], 2, 'Incomplete Sandre snapshot'],
    [[feature()], 'unknown', 'Invalid Sandre feature count'],
  ])(
    'rejects an incomplete or uncounted snapshot',
    (features, numberMatched, message) => {
      expect(() =>
        createSandreZoneSnapshot(features, numberMatched, '65'),
      ).toThrow(message);
    },
  );

  it('accepts a stable empty department snapshot', () => {
    expect(createSandreZoneSnapshot([], 0, '75')).toEqual(
      expect.objectContaining({
        features: [],
        featureCount: 0,
        sourceUpdatedAt: null,
      }),
    );
  });

  it('rejects duplicate canonical codes', () => {
    expect(() =>
      createSandreZoneSnapshot(
        [feature({ gid: 1 }), feature({ gid: 2 })],
        2,
        '65',
      ),
    ).toThrow('Duplicate Sandre code 3183');
  });

  it('rejects duplicate technical gids', () => {
    expect(() =>
      createSandreZoneSnapshot(
        [feature({ gid: 1, CdZAS: 'A' }), feature({ gid: 1, CdZAS: 'B' })],
        2,
        '65',
      ),
    ).toThrow('Duplicate Sandre gid 1');
  });

  it('accepts a reused alternate code when canonical identities differ', () => {
    const oldFeature = feature({
      gid: 1451,
      CdZAS: '1381',
      CodesAlternatifs: '{"{\\"code\\":\\"73_65_08\\"}"}',
      StZAS: 'Gelé',
    });
    const currentFeature = feature({
      gid: 3181,
      CdZAS: '3181',
      CodesAlternatifs: '{"{\\"code\\":\\"73_65_08\\"}"}',
    });

    const snapshot = createSandreZoneSnapshot(
      [oldFeature, currentFeature],
      2,
      '65',
    );

    expect(snapshot.features).toHaveLength(2);
    expect(snapshot.features.map((item) => item.codeSandre)).toEqual([
      '1381',
      '3181',
    ]);
    expect(snapshot.features[0].alternateCodes).toEqual(['73_65_08']);
    expect(snapshot.features[1].alternateCodes).toEqual(['73_65_08']);
  });

  it('produces a stable snapshot hash regardless of feature order', () => {
    const first = feature({
      gid: 1,
      CdZAS: 'A',
      DateMajZAS: '2025-01-01',
    });
    const second = feature({
      gid: 2,
      CdZAS: 'B',
      DateMajZAS: '2026-01-01',
    });

    const forward = createSandreZoneSnapshot([first, second], 2, '65');
    const reverse = createSandreZoneSnapshot([second, first], 2, '65');

    expect(forward.snapshotHash).toBe(reverse.snapshotHash);
    expect(forward.featureCount).toBe(2);
    expect(forward.sourceUpdatedAt).toBe('2026-01-01');
  });

  it('rejects a changing multi-page snapshot at constant cardinality', async () => {
    const features = Array.from({ length: 1001 }, (_, index) =>
      feature({
        gid: index + 1,
        CdZAS: String(index + 1),
      }),
    );
    const changedFeatures = [...features];
    changedFeatures[0] = feature({
      gid: 1,
      CdZAS: '1',
      LbZAS: 'Changed during pagination',
    });
    const pages = [
      { features: features.slice(0, 1000) },
      { features: features.slice(1000) },
      { features: changedFeatures.slice(0, 1000) },
      { features: changedFeatures.slice(1000) },
    ];
    const transport = {
      getText: jest.fn().mockResolvedValue(`
        <wfs:FeatureCollection
          xmlns:wfs="http://www.opengis.net/wfs/2.0"
          numberMatched="1001"
          numberReturned="0">
        </wfs:FeatureCollection>
      `),
      getJson: jest.fn(async () => pages.shift()),
    };

    await expect(
      fetchSandreZoneSnapshot('https://services.sandre.test', '65', transport),
    ).rejects.toThrow('Sandre snapshot changed while reading department 65');
    expect(transport.getJson).toHaveBeenCalledTimes(4);
  });
});
