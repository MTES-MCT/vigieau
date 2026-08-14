import { parseDepartementGeometryFeed } from './departement-geometry';

const feature = (code: string) => ({
  type: 'Feature',
  properties: { code },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ],
  },
});

describe('parseDepartementGeometryFeed', () => {
  const completeFeed = () => ({
    type: 'FeatureCollection',
    features: Array.from({ length: 90 }, (_, index) =>
      feature(String(index + 1).padStart(index > 98 ? 3 : 2, '0')),
    ),
  });

  it('accepts a complete and valid GeoJSON feed', () => {
    const parsed = parseDepartementGeometryFeed(completeFeed());

    expect(parsed).toHaveLength(90);
    expect(parsed[0]).toMatchObject({ code: '01' });
  });

  it('rejects a truncated feed before any database update', () => {
    expect(() =>
      parseDepartementGeometryFeed({
        type: 'FeatureCollection',
        features: [feature('65')],
      }),
    ).toThrow('incomplet');
  });

  it('rejects duplicates and malformed geometries', () => {
    const duplicate = completeFeed();
    duplicate.features[1] = feature('01');
    expect(() => parseDepartementGeometryFeed(duplicate)).toThrow('duplique');

    const malformed = completeFeed();
    malformed.features[0] = {
      ...feature('01'),
      geometry: { type: 'Point', coordinates: [0, 0] },
    } as any;
    expect(() => parseDepartementGeometryFeed(malformed)).toThrow(
      'Geometrie invalide',
    );
  });
});
