import {
  auditSandreApprovedSyncGeometry,
  findSandreApprovedSyncSnapshot,
  SandreApprovedSyncMapping,
  SANDRE_APPROVED_SYNC_SNAPSHOTS,
} from './sandre-zone-sync-approvals';

function geometryRow(
  mapping: SandreApprovedSyncMapping,
  overrides: Record<string, unknown> = {},
) {
  const expected = mapping.expectedGeometry!;
  return {
    sourceGeometryHash: expected.sourceGeometryHash,
    targetGeometryHashes: expected.targetGeometryHashes,
    unionGeometryHash: expected.unionGeometryHash,
    sourceCoverage: String(expected.sourceCoverage),
    targetCoverage: String(expected.targetCoverage),
    iou: String(expected.iou),
    pairwiseOverlapRatio: '0',
    topologicallyEqual: false,
    sourceValid: true,
    targetsValid: true,
    sourceSrid: 4326,
    targetsSrid: 4326,
    sourceType: 'POLYGON',
    targetType: 'POLYGON',
    ...overrides,
  };
}

function targetFeatures(mapping: SandreApprovedSyncMapping) {
  return mapping.targetCodes.map(
    (codeSandre) =>
      ({ codeSandre, geometry: { type: 'Polygon', coordinates: [] } }) as any,
  );
}

describe('exact Sandre sync approvals', () => {
  it('pins the complete department 24 and 85 mapping cardinalities', () => {
    const department24 = SANDRE_APPROVED_SYNC_SNAPSHOTS.find(
      (approval) => approval.departmentCode === '24',
    )!;
    const department85 = SANDRE_APPROVED_SYNC_SNAPSHOTS.find(
      (approval) => approval.departmentCode === '85',
    )!;

    expect(department24.mappings).toHaveLength(54);
    expect(
      department24.mappings.flatMap((mapping) => mapping.targetCodes),
    ).toHaveLength(55);
    expect(
      department24.mappings.find((mapping) => mapping.sourceCode === '1028'),
    ).toEqual(
      expect.objectContaining({
        sourceZoneId: 12097,
        targetCodes: ['4116', '4117'],
        requireTopologicalEquality: false,
        maximumPairwiseOverlapRatio: 1e-10,
        expectedGeometry: expect.objectContaining({
          sourceGeometryHash: 'f70d2c378906e67650d40b6cd8e14690',
        }),
      }),
    );
    expect(
      department24.mappings
        .filter((mapping) => mapping.targetCodes.length === 1)
        .every(
          (mapping) =>
            !mapping.requireTopologicalEquality &&
            mapping.effectiveDate === null &&
            mapping.expectedGeometry !== null,
        ),
    ).toBe(true);
    expect(
      department24.mappings.find((mapping) => mapping.sourceCode === '1029'),
    ).toEqual(
      expect.objectContaining({
        sourceZoneId: 12098,
        targetCodes: ['4077'],
        requireTopologicalEquality: false,
        expectedGeometry: {
          sourceGeometryHash: 'c887321ceb9a1184d5b874a7ef42877a',
          targetGeometryHashes: ['165b5b8e4504775213a1805f930f6501'],
          unionGeometryHash: '22b44390a9b7d459b05acbd79bc4a1f8',
          sourceCoverage: 0.9999999932936506,
          targetCoverage: 0.9999999939499236,
          iou: 0.9999999872435719,
        },
      }),
    );
    expect(
      department24.mappings
        .filter((mapping) => mapping.expectedInvalidSourceReason)
        .map((mapping) => [
          mapping.sourceCode,
          mapping.expectedInvalidSourceReason,
        ]),
    ).toEqual([
      ['1054', 'Ring Self-intersection[0.48995063 45.302290107]'],
      ['1545', 'Ring Self-intersection[1.021924504 44.884407817]'],
      [
        '3935',
        'Too few points in geometry component[0.839975063 45.195338896]',
      ],
    ]);

    expect(department85.mappings).toEqual([
      expect.objectContaining({
        sourceCode: '355',
        sourceZoneId: 10582,
        targetCodes: ['3947', '3948'],
        maximumPairwiseOverlapRatio: 2e-9,
        expectedGeometry: expect.objectContaining({
          sourceGeometryHash: '71d342c49c82a7da369c288f6a3d672e',
        }),
      }),
    ]);
    expect(department85.mdmRecords.map((record) => record.codeSandre)).toEqual([
      '355',
      '3947',
      '3948',
    ]);
  });

  it('does not approve a snapshot with any source seal drift', () => {
    const department85 = SANDRE_APPROVED_SYNC_SNAPSHOTS.find(
      (approval) => approval.departmentCode === '85',
    )!;
    const emptySnapshot = {
      features: [],
      featureCount: department85.featureCount,
      sourceUpdatedAt: department85.sourceUpdatedAt,
      snapshotHash: `${department85.snapshotHash.slice(0, -1)}0`,
    };
    expect(findSandreApprovedSyncSnapshot('85', emptySnapshot)).toBeNull();
  });

  it('keeps every configured geometry threshold in the strict range', () => {
    for (const approval of SANDRE_APPROVED_SYNC_SNAPSHOTS) {
      for (const mapping of approval.mappings) {
        expect(Object.values(mapping.minimumGeometry)).toEqual(
          expect.arrayContaining([
            expect.any(Number),
            expect.any(Number),
            expect.any(Number),
          ]),
        );
        expect(
          Object.values(mapping.minimumGeometry).every(
            (threshold) => threshold >= 0.9999 && threshold <= 1,
          ),
        ).toBe(true);
        expect(Number.isFinite(mapping.maximumPairwiseOverlapRatio)).toBe(true);
        expect(mapping.maximumPairwiseOverlapRatio).toBeGreaterThanOrEqual(0);
        expect(mapping.maximumPairwiseOverlapRatio).toBeLessThanOrEqual(2e-9);
      }
    }
  });

  it('accepts only the exact sealed department 24 equivalent geometry', async () => {
    const department24 = SANDRE_APPROVED_SYNC_SNAPSHOTS.find(
      (approval) => approval.departmentCode === '24',
    )!;
    const mapping = department24.mappings.find(
      (item) => item.sourceCode === '1029',
    )!;
    const exactRow = geometryRow(mapping);
    const executor = { query: jest.fn().mockResolvedValue([exactRow]) };

    await expect(
      auditSandreApprovedSyncGeometry(
        executor,
        mapping,
        targetFeatures(mapping),
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        sourceCoverage: mapping.expectedGeometry!.sourceCoverage,
        topologicallyEqual: false,
      }),
    );

    for (const drift of [
      { sourceGeometryHash: '0'.repeat(32) },
      { targetGeometryHashes: ['0'.repeat(32)] },
      { unionGeometryHash: '0'.repeat(32) },
      {
        sourceCoverage: String(
          mapping.expectedGeometry!.sourceCoverage + 1e-12,
        ),
      },
      {
        targetCoverage: String(
          mapping.expectedGeometry!.targetCoverage + 1e-12,
        ),
      },
      { iou: String(mapping.expectedGeometry!.iou + 1e-12) },
      { pairwiseOverlapRatio: '1e-20' },
      { topologicallyEqual: true },
    ]) {
      executor.query.mockResolvedValueOnce([{ ...exactRow, ...drift }]);
      await expect(
        auditSandreApprovedSyncGeometry(
          executor,
          mapping,
          targetFeatures(mapping),
        ),
      ).rejects.toThrow('Approved Sandre geometry changed');
    }
  });

  it('accepts only the three exactly sealed invalid historical sources', async () => {
    const department24 = SANDRE_APPROVED_SYNC_SNAPSHOTS.find(
      (approval) => approval.departmentCode === '24',
    )!;
    const mapping = department24.mappings.find(
      (item) => item.sourceCode === '1054',
    )!;
    const exactInvalidRow = geometryRow(mapping, {
      sourceValid: false,
      sourceValidityReason: mapping.expectedInvalidSourceReason,
    });
    const executor = {
      query: jest.fn().mockResolvedValue([exactInvalidRow]),
    };

    await expect(
      auditSandreApprovedSyncGeometry(
        executor,
        mapping,
        targetFeatures(mapping),
      ),
    ).resolves.toEqual(expect.objectContaining({ sourceValid: false }));

    for (const drift of [
      { sourceValid: true, sourceValidityReason: 'Valid Geometry' },
      { sourceValidityReason: 'Ring Self-intersection[0 0]' },
    ]) {
      executor.query.mockResolvedValueOnce([{ ...exactInvalidRow, ...drift }]);
      await expect(
        auditSandreApprovedSyncGeometry(
          executor,
          mapping,
          targetFeatures(mapping),
        ),
      ).rejects.toThrow('Approved Sandre geometry changed');
    }

    const validMapping = department24.mappings.find(
      (item) => item.sourceCode === '1029',
    )!;
    executor.query.mockResolvedValueOnce([
      geometryRow(validMapping, {
        sourceValid: false,
        sourceValidityReason: 'Ring Self-intersection[0 0]',
      }),
    ]);
    await expect(
      auditSandreApprovedSyncGeometry(
        executor,
        validMapping,
        targetFeatures(validMapping),
      ),
    ).rejects.toThrow('Approved Sandre geometry changed');
  });

  it('accepts the bounded department 85 overlap without relaxing the default', async () => {
    const department85 = SANDRE_APPROVED_SYNC_SNAPSHOTS.find(
      (approval) => approval.departmentCode === '85',
    )!;
    const mapping = department85.mappings[0];
    const executor = {
      query: jest.fn().mockResolvedValue([
        geometryRow(mapping, {
          sourceCoverage: '0.9999888277283261',
          targetCoverage: '0.9999894382964751',
          iou: '0.999978266260787',
          pairwiseOverlapRatio: '1.791651046142331e-9',
        }),
      ]),
    };

    await expect(
      auditSandreApprovedSyncGeometry(
        executor,
        mapping,
        targetFeatures(mapping),
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        sourceGeometryHash: '71d342c49c82a7da369c288f6a3d672e',
        pairwiseOverlapRatio: 1.791651046142331e-9,
      }),
    );

    await expect(
      auditSandreApprovedSyncGeometry(
        executor,
        { ...mapping, maximumPairwiseOverlapRatio: undefined },
        targetFeatures(mapping),
      ),
    ).rejects.toThrow('Approved Sandre geometry changed');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 2.000000001e-9])(
    'rejects an invalid pairwise overlap ceiling %p before measuring geometry',
    async (maximumPairwiseOverlapRatio) => {
      const department85 = SANDRE_APPROVED_SYNC_SNAPSHOTS.find(
        (approval) => approval.departmentCode === '85',
      )!;
      const mapping = {
        ...department85.mappings[0],
        maximumPairwiseOverlapRatio,
      };
      const executor = { query: jest.fn() };

      await expect(
        auditSandreApprovedSyncGeometry(
          executor,
          mapping,
          targetFeatures(mapping),
        ),
      ).rejects.toThrow('Invalid approved Sandre pairwise overlap ratio');
      expect(executor.query).not.toHaveBeenCalled();
    },
  );

  it('rejects pairwise overlap evidence above the mapping ceiling', async () => {
    const department85 = SANDRE_APPROVED_SYNC_SNAPSHOTS.find(
      (approval) => approval.departmentCode === '85',
    )!;
    const mapping = department85.mappings[0];
    const executor = {
      query: jest.fn().mockResolvedValue([
        geometryRow(mapping, {
          pairwiseOverlapRatio: '2.000000001e-9',
        }),
      ]),
    };

    await expect(
      auditSandreApprovedSyncGeometry(
        executor,
        mapping,
        targetFeatures(mapping),
      ),
    ).rejects.toThrow('Approved Sandre geometry changed');
  });
});
