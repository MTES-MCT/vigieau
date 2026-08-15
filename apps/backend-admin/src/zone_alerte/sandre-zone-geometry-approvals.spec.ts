import {
  findSandreGeometryNormalizationApproval,
  SANDRE_GEOMETRY_NORMALIZATION_APPROVALS,
  SandreGeometryNormalizationCandidate,
  SandreGeometryNormalizationContext,
} from './sandre-zone-geometry-approvals';

describe('audited Sandre geometry normalization approvals', () => {
  const approval = SANDRE_GEOMETRY_NORMALIZATION_APPROVALS[0];
  const feature = approval.features.find((item) => item.codeSandre === '3958')!;
  const context: SandreGeometryNormalizationContext = {
    departmentCode: approval.departmentCode,
    snapshotHash: approval.snapshotHash,
    sourceUpdatedAt: approval.sourceUpdatedAt,
    featureCount: approval.featureCount,
  };
  const candidate: SandreGeometryNormalizationCandidate = {
    ...feature,
    relativeAreaDelta: 4.327937393518178e-8,
    absoluteGeodesicAreaDeltaSquareMeters: 20.807422280311584,
  };

  it('approves every exact department 11 source fixture within both bounds', () => {
    expect(approval.features.map((item) => item.codeSandre)).toEqual([
      '3575',
      '3579',
      '3586',
      '3592',
      '3951',
      '3956',
      '3958',
      '3961',
    ]);
    for (const approvedFeature of approval.features) {
      expect(
        findSandreGeometryNormalizationApproval(context, {
          ...approvedFeature,
          relativeAreaDelta: approvedFeature.maxRelativeAreaDelta,
          absoluteGeodesicAreaDeltaSquareMeters:
            approvedFeature.maxAbsoluteGeodesicAreaDeltaSquareMeters,
        }),
      ).toBe(approval);
    }
  });

  it.each<
    [
      string,
      {
        context?: SandreGeometryNormalizationContext;
        candidate?: SandreGeometryNormalizationCandidate;
      },
    ]
  >([
    ['department', { context: { ...context, departmentCode: '12' } }],
    ['snapshot', { context: { ...context, snapshotHash: '0'.repeat(64) } }],
    ['source date', { context: { ...context, sourceUpdatedAt: '2026-08-14' } }],
    ['feature count', { context: { ...context, featureCount: 55 } }],
    ['gid', { candidate: { ...candidate, gid: 9999 } }],
    ['payload', { candidate: { ...candidate, payloadHash: '0'.repeat(64) } }],
    [
      'raw geometry',
      { candidate: { ...candidate, rawGeometryHash: '0'.repeat(64) } },
    ],
    [
      'normalized geometry',
      { candidate: { ...candidate, normalizedGeometryHash: '0'.repeat(64) } },
    ],
    [
      'normalized geometry type',
      { candidate: { ...candidate, normalizedGeometryType: 'POLYGON' } },
    ],
    ['raw parts', { candidate: { ...candidate, rawParts: 281 } }],
    ['normalized parts', { candidate: { ...candidate, normalizedParts: 336 } }],
    ['raw points', { candidate: { ...candidate, rawPoints: 9113 } }],
    [
      'normalized points',
      { candidate: { ...candidate, normalizedPoints: 8840 } },
    ],
    [
      'relative bound',
      {
        candidate: {
          ...candidate,
          relativeAreaDelta: feature.maxRelativeAreaDelta + 1e-12,
        },
      },
    ],
    [
      'absolute bound',
      {
        candidate: {
          ...candidate,
          absoluteGeodesicAreaDeltaSquareMeters:
            feature.maxAbsoluteGeodesicAreaDeltaSquareMeters + 0.001,
        },
      },
    ],
  ])('rejects %s drift', (_label, overrides) => {
    expect(
      findSandreGeometryNormalizationApproval(
        overrides.context ?? context,
        overrides.candidate ?? candidate,
      ),
    ).toBeNull();
  });
});
