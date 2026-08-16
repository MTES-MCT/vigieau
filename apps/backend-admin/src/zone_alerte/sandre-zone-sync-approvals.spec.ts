import {
  findSandreApprovedSyncSnapshot,
  SANDRE_APPROVED_SYNC_SNAPSHOTS,
} from './sandre-zone-sync-approvals';

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
      }),
    );
    expect(
      department24.mappings
        .filter((mapping) => mapping.targetCodes.length === 1)
        .every((mapping) => mapping.requireTopologicalEquality),
    ).toBe(true);

    expect(department85.mappings).toEqual([
      expect.objectContaining({
        sourceCode: '355',
        sourceZoneId: 10582,
        targetCodes: ['3947', '3948'],
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
      }
    }
  });
});
