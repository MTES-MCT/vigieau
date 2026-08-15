import {
  normalizeSandreZoneGeometries,
  SANDRE_GEOMETRY_MAX_RELATIVE_AREA_DELTA,
} from './sandre-zone-geometry';
import * as geometryApprovals from './sandre-zone-geometry-approvals';

const feature = (codeSandre: string, geometry: any) =>
  ({ codeSandre, geometry }) as any;

describe('Sandre geometry normalization', () => {
  const validGeometry = {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ],
  };

  it('keeps a valid source geometry exactly unchanged', async () => {
    const executor = {
      query: jest.fn().mockResolvedValue([
        {
          ordinal: 1,
          code: 'VALID',
          geometry: { ...validGeometry },
          raw_valid: true,
          invalid_reason: 'Valid Geometry',
          raw_geometry_type: 'POLYGON',
          normalized_geometry_type: 'POLYGON',
          raw_parts: 1,
          normalized_parts: 1,
          raw_points: 4,
          normalized_points: 4,
          raw_area: '0.5',
          normalized_area: '0.5',
          relative_area_delta: '0',
          raw_geodesic_area: '5000000',
          normalized_geodesic_area: '5000000',
          absolute_geodesic_area_delta: '0',
          bbox_unchanged: true,
          normalized_valid: true,
        },
      ]),
    };

    const result = await normalizeSandreZoneGeometries(executor, [
      feature('VALID', validGeometry),
    ]);

    expect(result.features[0].geometry).toBe(validGeometry);
    expect(result.audits.get('VALID')).toEqual(
      expect.objectContaining({
        normalized: false,
        relativeAreaDelta: 0,
      }),
    );
    expect(result.audits.get('VALID')!.rawGeometryHash).toBe(
      result.audits.get('VALID')!.normalizedGeometryHash,
    );
    const sql = executor.query.mock.calls[0][0];
    expect(sql).toContain("'method=structure keepcollapsed=false'");
    expect(sql).toContain('ST_CollectionExtract');
    expect(sql).toContain('bbox_unchanged');
  });

  it('accepts only a bounded polygonal repair below the area threshold', async () => {
    const repairedGeometry = {
      type: 'MultiPolygon',
      coordinates: [validGeometry.coordinates],
    };
    const executor = {
      query: jest.fn().mockResolvedValue([
        {
          ordinal: 1,
          code: '3917',
          geometry: repairedGeometry,
          raw_valid: false,
          invalid_reason: 'Ring Self-intersection',
          raw_geometry_type: 'POLYGON',
          normalized_geometry_type: 'MULTIPOLYGON',
          raw_parts: 1,
          normalized_parts: 2,
          raw_points: 966,
          normalized_points: 967,
          raw_area: '10',
          normalized_area: '10.0000000001',
          relative_area_delta: '1e-11',
          raw_geodesic_area: '100000000',
          normalized_geodesic_area: '100000000.1',
          absolute_geodesic_area_delta: '0.1',
          bbox_unchanged: true,
          normalized_valid: true,
        },
      ]),
    };

    const result = await normalizeSandreZoneGeometries(executor, [
      feature('3917', validGeometry),
    ]);

    expect(result.features[0].geometry).toBe(repairedGeometry);
    expect(result.audits.get('3917')).toEqual(
      expect.objectContaining({
        normalized: true,
        relativeAreaDelta: 1e-11,
      }),
    );
  });

  it('accepts an over-threshold repair only with a source-scoped approval', async () => {
    const repairedGeometry = {
      type: 'MultiPolygon',
      coordinates: [validGeometry.coordinates],
    };
    const approval =
      geometryApprovals.SANDRE_GEOMETRY_NORMALIZATION_APPROVALS[0];
    const approvalSpy = jest
      .spyOn(geometryApprovals, 'findSandreGeometryNormalizationApproval')
      .mockReturnValue(approval);
    const executor = {
      query: jest.fn().mockResolvedValue([
        {
          ordinal: 1,
          code: 'APPROVED',
          geometry: repairedGeometry,
          raw_valid: false,
          invalid_reason: 'Self-intersection',
          raw_geometry_type: 'MULTIPOLYGON',
          normalized_geometry_type: 'MULTIPOLYGON',
          raw_parts: 2,
          normalized_parts: 3,
          raw_points: 10,
          normalized_points: 11,
          raw_area: '10',
          normalized_area: '10.00000002',
          relative_area_delta: '2e-9',
          raw_geodesic_area: '100000000',
          normalized_geodesic_area: '100000001',
          absolute_geodesic_area_delta: '1',
          bbox_unchanged: true,
          normalized_valid: true,
        },
      ]),
    };
    const context = {
      departmentCode: '11',
      snapshotHash: approval.snapshotHash,
      sourceUpdatedAt: approval.sourceUpdatedAt,
      featureCount: approval.featureCount,
    };

    const result = await normalizeSandreZoneGeometries(
      executor,
      [feature('APPROVED', validGeometry)],
      context,
    );

    expect(result.features[0].geometry).toBe(repairedGeometry);
    expect(result.audits.get('APPROVED')).toEqual(
      expect.objectContaining({
        relativeAreaDelta: 2e-9,
        absoluteGeodesicAreaDeltaSquareMeters: 1,
        normalizationApprovalId: approval.id,
      }),
    );
    expect(approvalSpy).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        codeSandre: 'APPROVED',
        relativeAreaDelta: 2e-9,
        absoluteGeodesicAreaDeltaSquareMeters: 1,
      }),
    );
    approvalSpy.mockRestore();
  });

  it.each([
    ['changed bbox', { bbox_unchanged: false, relative_area_delta: '0' }],
    [
      'area drift',
      {
        bbox_unchanged: true,
        relative_area_delta: String(
          SANDRE_GEOMETRY_MAX_RELATIVE_AREA_DELTA * 2,
        ),
      },
    ],
  ])('rejects an unsafe %s', async (_label, overrides) => {
    const executor = {
      query: jest.fn().mockResolvedValue([
        {
          ordinal: 1,
          code: 'BAD',
          geometry: validGeometry,
          raw_valid: false,
          invalid_reason: 'Self-intersection',
          raw_geometry_type: 'POLYGON',
          normalized_geometry_type: 'MULTIPOLYGON',
          raw_parts: 1,
          normalized_parts: 2,
          raw_points: 5,
          normalized_points: 6,
          raw_area: '1',
          normalized_area: '1',
          raw_geodesic_area: '10000000',
          normalized_geodesic_area: '10000000',
          absolute_geodesic_area_delta: '0',
          normalized_valid: true,
          ...overrides,
        },
      ]),
    };

    await expect(
      normalizeSandreZoneGeometries(executor, [feature('BAD', validGeometry)]),
    ).rejects.toThrow('Unsafe Sandre geometry normalization');
  });

  it('rejects duplicate canonical codes before building an audit map', async () => {
    const executor = { query: jest.fn() };

    await expect(
      normalizeSandreZoneGeometries(executor, [
        feature('DUPLICATE', validGeometry),
        feature('DUPLICATE', validGeometry),
      ]),
    ).rejects.toThrow('Duplicate Sandre code');
    expect(executor.query).not.toHaveBeenCalled();
  });
});
