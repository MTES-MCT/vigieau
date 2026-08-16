import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  assertCanonicalDuplicateRestrictionConflicts,
  auditSandreSyncExpectations,
  CanonicalDuplicateRestrictionConflict,
  CanonicalizeDuplicateAction,
  parseSandreReconciliationPlan,
  reconciliationPlanFingerprint,
  SandreReconciliationPlan,
} from './sandre-zone-reconciliation-actions';
import { fingerprint } from './sandre-zone-reconciliation';

describe('audited Sandre reconciliation plans', () => {
  const planPath = resolve(
    __dirname,
    '../scripts/sandre-reconciliation-plans/2026-08-15-prod-sandre-unblock.json',
  );
  const auditBlockersPlanPath = resolve(
    __dirname,
    '../scripts/sandre-reconciliation-plans/2026-08-15-prod-sandre-audit-blockers.json',
  );

  it('signs every operational action and generic sync expectation', () => {
    const serializedPlan = readFileSync(planPath, 'utf8');
    const plan = parseSandreReconciliationPlan(JSON.parse(serializedPlan));

    expect(plan.actions).toHaveLength(6);
    expect(plan.actions.map((action) => action.strategy)).toEqual([
      'preserve_local',
      'replace_1to1',
      'replace_1to1',
      'replace_partition_1ton',
      'replace_partition_1ton',
      'canonicalize_duplicate',
    ]);
    expect(
      new Set([
        ...plan.actions.map((action) => action.departmentCode),
        ...(plan.syncExpectations ?? []).map(
          (expectation) => expectation.departmentCode,
        ),
      ]),
    ).toEqual(new Set(['2A', '2B', '19', '49', '69', '72', '81', '87']));
    expect(plan.syncExpectations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          departmentCode: '2A',
          officialCodes: ['3996'],
          resolution: 'basin_mapping',
          officialBasinCode: 12,
          localBasinCode: 6,
          mappingSource: 'audited_official_to_local',
        }),
        expect.objectContaining({
          departmentCode: '87',
          officialCodes: ['1424'],
          resolution: 'geometry_normalization',
        }),
      ]),
    );
    expect(reconciliationPlanFingerprint(plan)).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.actions[5]).toEqual(
      expect.objectContaining({
        restrictionConflictPolicy: {
          mode: 'prefer_source',
          expectedCount: 23,
          expectedFingerprint:
            'c1e3bad0f1b327b861ec60c7153703680b0541fe0d268dd4596aba55b5f3ea56',
          allowedDifferingFields: ['niveauGravite'],
          requiredParentStatus: 'abroge',
          requireSourceSeverityStrictlyHigher: true,
        },
      }),
    );
    expect(serializedPlan).not.toMatch(
      /DATABASE_|API_SANDRE|PASSWORD|SECRET|postgres(?:ql)?:\/\//i,
    );
  });

  it('keeps the follow-up audit blockers in a separate exact operation', () => {
    const serializedPlan = readFileSync(auditBlockersPlanPath, 'utf8');
    const plan = parseSandreReconciliationPlan(JSON.parse(serializedPlan));

    expect(plan.operationId).toBe('2026-08-15-prod-sandre-audit-blockers');
    expect(plan.syncExpectations).toEqual([
      {
        departmentCode: '11',
        officialCodes: [
          '3575',
          '3579',
          '3586',
          '3592',
          '3951',
          '3956',
          '3958',
          '3961',
        ],
        resolution: 'geometry_normalization',
      },
    ]);
    expect(plan.actions).toEqual([
      expect.objectContaining({
        strategy: 'canonicalize_duplicate',
        departmentCode: '49',
        zoneType: 'SOU',
        sourceZoneId: 16677,
        targetZoneId: 9708,
        expectedSourceCode: '52_49_15',
        expectedSandreGid: 409,
        officialCode: '301',
        requiredSourceBusinessReferenceCount: 0,
        restrictionConflictPolicy: expect.objectContaining({
          expectedCount: 0,
          expectedFingerprint:
            '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
        }),
      }),
    ]);
    expect(reconciliationPlanFingerprint(plan)).toMatch(/^[a-f0-9]{64}$/);
    expect(serializedPlan).not.toMatch(
      /DATABASE_|API_SANDRE|PASSWORD|SECRET|postgres(?:ql)?:\/\//i,
    );
  });

  it('requires an exact restriction conflict policy for canonical duplicates', () => {
    const conflict = canonicalConflict();
    const action = canonicalAction([conflict]);

    expect(
      assertCanonicalDuplicateRestrictionConflicts(action, [conflict]),
    ).toEqual({
      policy: 'prefer_source',
      count: 1,
      fingerprint: fingerprint([conflict]),
    });

    expect(() =>
      parseSandreReconciliationPlan({
        schemaVersion: 1,
        operationId: 'missing-conflict-policy',
        description: 'test',
        actions: [
          {
            strategy: 'canonicalize_duplicate',
            departmentCode: '49',
            zoneType: 'SOU',
            sourceZoneId: 9707,
            targetZoneId: 9704,
            expectedSandreGid: 408,
            officialCode: '300',
          },
        ],
      }),
    ).toThrow('Invalid canonical Sandre duplicate action');
  });

  it('rejects the retired plan-level partition replication path', () => {
    const policy = {
      mode: 'replicate_exact_to_all_targets',
      requiredParentStatuses: ['a_venir', 'publie'],
      expectedSourceCount: 2,
      expectedSourceFingerprint: 'a'.repeat(64),
      expectedTargetCollisionCount: 0,
      expectedTargetCollisionFingerprint: fingerprint([]),
    };
    expect(() =>
      parseSandreReconciliationPlan({
        schemaVersion: 1,
        operationId: 'partition-restriction-policy',
        description: 'test',
        actions: [
          {
            strategy: 'replace_partition_1ton',
            departmentCode: '85',
            zoneType: 'SUP',
            sourceZoneId: 10582,
            targetZoneIds: [20001, 20002],
            restrictionReplicationPolicy: policy,
          },
        ],
      }),
    ).toThrow('Legacy partition evidence is not supported');
  });

  it('fails closed when canonical restriction conflicts drift', () => {
    const conflict = canonicalConflict();
    const action = canonicalAction([conflict]);

    expect(() =>
      assertCanonicalDuplicateRestrictionConflicts(action, [
        { ...conflict, targetRestrictionId: 999 },
      ]),
    ).toThrow('restriction conflicts changed');
    expect(() =>
      assertCanonicalDuplicateRestrictionConflicts(action, [
        {
          ...conflict,
          sourceNiveauGravite: 'vigilance',
          targetNiveauGravite: 'alerte',
        },
      ]),
    ).toThrow('source severity is not stronger');
  });

  it('rejects duplicate sources and unknown metadata instead of silently dropping it', () => {
    expect(() =>
      parseSandreReconciliationPlan({
        schemaVersion: 1,
        operationId: 'duplicate-source',
        description: 'test',
        actions: [
          {
            strategy: 'preserve_local',
            departmentCode: '2B',
            zoneType: 'SOU',
            sourceZoneId: 4605,
          },
          {
            strategy: 'replace_1to1',
            departmentCode: '2B',
            zoneType: 'SOU',
            sourceZoneId: 4605,
            targetZoneId: 1,
          },
        ],
      }),
    ).toThrow('Duplicate source zone');
    expect(() =>
      parseSandreReconciliationPlan({
        schemaVersion: 1,
        operationId: 'bad-expectation',
        description: 'test',
        syncExpectations: [
          {
            departmentCode: '19',
            officialCodes: ['3917'],
            resolution: 'guess',
          },
        ],
        actions: [
          {
            strategy: 'preserve_local',
            departmentCode: '2B',
            zoneType: 'SOU',
            sourceZoneId: 4605,
          },
        ],
      }),
    ).toThrow('Invalid Sandre sync expectation');
  });

  it('audits an invalid official geometry with signed source evidence', async () => {
    const plan = expectationPlan({
      departmentCode: '19',
      officialCodes: ['3917'],
      resolution: 'geometry_normalization',
    });
    const executor = {
      query: jest
        .fn()
        .mockResolvedValue([
          geometryAuditRow({ code: '3917', raw_valid: false }),
        ]),
    };

    const evidence = await auditSandreSyncExpectations(executor, plan, [
      officialSnapshot('19', [officialFeature('19', '3917')]),
    ]);

    expect(evidence).toEqual([
      expect.objectContaining({
        snapshotHash:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        sourceUpdatedAt: '2026-08-15',
        featureCount: 1,
        features: [
          expect.objectContaining({
            codeSandre: '3917',
            geometry: expect.objectContaining({
              normalized: true,
              invalidReason: 'Self-intersection',
              relativeAreaDelta: 0,
            }),
          }),
        ],
      }),
    ]);
  });

  it('fails closed when an expected snapshot or official code is absent', async () => {
    const plan = expectationPlan({
      departmentCode: '19',
      officialCodes: ['3917'],
      resolution: 'geometry_normalization',
    });
    const executor = { query: jest.fn() };

    await expect(
      auditSandreSyncExpectations(executor, plan, []),
    ).rejects.toThrow('Expected one Sandre snapshot');
    await expect(
      auditSandreSyncExpectations(executor, plan, [
        officialSnapshot('19', [officialFeature('19', 'OTHER')]),
      ]),
    ).rejects.toThrow('Expected one active Sandre feature 3917');
    expect(executor.query).not.toHaveBeenCalled();
  });

  it('rejects a geometry expectation that has become valid', async () => {
    const plan = expectationPlan({
      departmentCode: '87',
      officialCodes: ['1424'],
      resolution: 'geometry_normalization',
    });
    const executor = {
      query: jest
        .fn()
        .mockResolvedValue([
          geometryAuditRow({ code: '1424', raw_valid: true }),
        ]),
    };

    await expect(
      auditSandreSyncExpectations(executor, plan, [
        officialSnapshot('87', [officialFeature('87', '1424')]),
      ]),
    ).rejects.toThrow('is no longer an invalid geometry fixture');
  });

  it('requires the exact audited basin mapping and one local basin', async () => {
    const plan = expectationPlan({
      departmentCode: '2A',
      officialCodes: ['3996'],
      resolution: 'basin_mapping',
      officialBasinCode: 12,
      localBasinCode: 6,
      mappingSource: 'audited_official_to_local',
    });
    const snapshot = officialSnapshot('2A', [
      officialFeature('2A', '3996', 12),
    ]);
    const executor = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM sandre_basin_mapping')) {
          return [
            {
              officialBasinCode: 12,
              localBasinCode: 7,
              source: 'audited_official_to_local',
            },
          ];
        }
        return [{ id: 6 }];
      }),
    };

    await expect(
      auditSandreSyncExpectations(executor, plan, [snapshot]),
    ).rejects.toThrow('Audited basin mapping mismatch');

    executor.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM sandre_basin_mapping')) {
        return [
          {
            officialBasinCode: 12,
            localBasinCode: 6,
            source: 'audited_official_to_local',
          },
        ];
      }
      return [{ id: 60 }, { id: 61 }];
    });
    await expect(
      auditSandreSyncExpectations(executor, plan, [snapshot]),
    ).rejects.toThrow('Expected one local basin 6, found 2');
  });
});

function expectationPlan(
  expectation: NonNullable<
    SandreReconciliationPlan['syncExpectations']
  >[number],
): SandreReconciliationPlan {
  return parseSandreReconciliationPlan({
    schemaVersion: 1,
    operationId: 'sync-expectation-test',
    description: 'test',
    syncExpectations: [expectation],
    actions: [
      {
        strategy: 'preserve_local',
        departmentCode: '2B',
        zoneType: 'SOU',
        sourceZoneId: 4605,
      },
    ],
  });
}

function canonicalAction(
  conflicts: CanonicalDuplicateRestrictionConflict[],
): CanonicalizeDuplicateAction {
  const plan = parseSandreReconciliationPlan({
    schemaVersion: 1,
    operationId: 'canonical-conflict-test',
    description: 'test',
    actions: [
      {
        strategy: 'canonicalize_duplicate',
        departmentCode: '49',
        zoneType: 'SOU',
        sourceZoneId: 9707,
        targetZoneId: 9704,
        expectedSandreGid: 408,
        officialCode: '300',
        restrictionConflictPolicy: {
          mode: 'prefer_source',
          expectedCount: conflicts.length,
          expectedFingerprint: fingerprint(conflicts),
          allowedDifferingFields: ['niveauGravite'],
          requiredParentStatus: 'abroge',
          requireSourceSeverityStrictlyHigher: true,
        },
      },
    ],
  });
  return plan.actions[0] as CanonicalizeDuplicateAction;
}

function canonicalConflict(): CanonicalDuplicateRestrictionConflict {
  return {
    arreteRestrictionId: 10,
    parentStatus: 'abroge',
    sourceRestrictionId: 101,
    targetRestrictionId: 100,
    sourceArreteCadreId: 3,
    targetArreteCadreId: 3,
    sourceNomGroupementAep: null,
    targetNomGroupementAep: null,
    sourceNiveauGravite: 'crise',
    targetNiveauGravite: 'alerte',
  };
}

function officialSnapshot(departmentCode: string, features: any[]): any {
  return {
    departmentCode,
    snapshotHash:
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sourceUpdatedAt: '2026-08-15',
    featureCount: features.length,
    features,
  };
}

function officialFeature(
  departmentCode: string,
  codeSandre: string,
  basinCode = 1,
): any {
  return {
    codeSandre,
    gid: 1,
    departmentCode,
    type: 'SOU',
    status: 'Validé',
    payloadHash:
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    basinCode,
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
  };
}

function geometryAuditRow(overrides: Record<string, unknown>): any {
  return {
    ordinal: 1,
    code: '3917',
    geometry: officialFeature('19', '3917').geometry,
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
    relative_area_delta: '0',
    raw_geodesic_area: '10000000',
    normalized_geodesic_area: '10000000',
    absolute_geodesic_area_delta: '0',
    bbox_unchanged: true,
    normalized_valid: true,
    ...overrides,
  };
}
