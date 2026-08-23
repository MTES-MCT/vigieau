import * as reconciliation from './sandre-zone-reconciliation';
import { SandreZoneFeature, SandreZoneSnapshot } from './sandre-zone-sync';
import {
  assertSandreLkgObservation,
  findSandreApprovedLkgRetentionForObservation,
  findSandreApprovedLkgRetentionForSnapshot,
  findSandreLkgApproval,
  parseSandreLkgApproval,
  sandreLkgFeatureEvidence,
  SandreLkgObservation,
  SANDRE_LKG_APPROVALS,
} from './sandre-zone-lkg-approvals';

describe('bounded Sandre LKG approvals', () => {
  const approval = SANDRE_LKG_APPROVALS[0];

  const exactFeature = (): SandreZoneFeature =>
    ({
      ...approval.feature,
      alternateCodes: [],
      preferredAlternateCode: null,
      version: null,
      basinCode: 6,
      influencedResource: true,
      geometry: { type: 'MultiPolygon', coordinates: [] },
    }) as SandreZoneFeature;

  const exactSnapshot = (): SandreZoneSnapshot => ({
    snapshotHash: approval.snapshotHash,
    sourceUpdatedAt: approval.sourceUpdatedAt,
    featureCount: approval.featureCount,
    features: [
      exactFeature(),
      ...(Array.from({ length: approval.featureCount - 1 }, (_, index) => ({
        codeSandre: `other-${index}`,
      })) as SandreZoneFeature[]),
    ],
  });

  const exactObservation = (): SandreLkgObservation => ({
    departmentCode: approval.departmentCode,
    snapshot: {
      snapshotHash: approval.snapshotHash,
      sourceUpdatedAt: approval.sourceUpdatedAt,
      featureCount: approval.featureCount,
    },
    feature: { ...approval.feature },
    localZone: { ...approval.localZone },
    mdmRecords: approval.mdmRecords.map((record) => ({ ...record })),
    mdmNomenclature: null,
    genealogyLatestDate: approval.genealogyLatestDate,
    genealogySourceRelationCount: approval.genealogySourceRelationCount,
    genealogyEvidenceFingerprint: approval.genealogyEvidenceFingerprint,
    operationalReferenceEvidenceFingerprint:
      approval.operationalReferenceEvidenceFingerprint,
    reconciliationStateFingerprint: approval.reconciliationStateFingerprint,
  });

  function withFeatureGeometryHash<T>(hash: string, callback: () => T): T {
    const spy = jest.spyOn(reconciliation, 'fingerprint').mockReturnValue(hash);
    try {
      return callback();
    } finally {
      spy.mockRestore();
    }
  }

  it('pins the exact department 06 official and local evidence', () => {
    expect(SANDRE_LKG_APPROVALS).toEqual([
      {
        approvalId: 'dep06-zone-3862-lkg-bdf7e4da',
        departmentCode: '06',
        snapshotHash:
          'bdf7e4daed8cbfbaee78693ffcc2d72c34f269792b0367078d85b687f6701007',
        sourceUpdatedAt: '2026-08-17',
        featureCount: 55,
        feature: {
          codeSandre: '3862',
          gid: 3862,
          departmentCode: '06',
          sourceUpdatedAt: '2026-08-17',
          name: 'Saint Cassien',
          type: 'SUP',
          status: 'Gelé',
          payloadHash:
            '93fe07f4dc784a847dc34a2d865870e61ae1b7eecb67eea79bb68fbbaf66621d',
          geometryEvidenceSha256:
            '70c171dd3575846521cb46cb3e10a1844ae60969a70893be93102b039be0a1f3',
        },
        localZone: {
          zoneAlerteId: 16629,
          bassinVersantId: 7,
          bassinVersantCode: 6,
          idSandre: 3862,
          codeSandre: '3862',
          code: '3862',
          nom: 'Saint Cassien',
          type: 'SUP',
          ressourceInfluencee: true,
          disabled: false,
          sandreProvenance: 'official',
          statutSandre: 'Validé',
          dateMajSandre: '2026-07-08',
          numeroVersionSandre: null,
          numeroVersion: null,
          sandrePayloadHash:
            '1617bc1563650121931b8b0d11d64102f0658dba574a81d669fc70d899048543',
          ewkbMd5: '2ef01c7adc7b6d6a2edc2f629c67e6dd',
        },
        mdmRecords: [
          {
            codeSandre: '3862',
            projectionSha256:
              'd7215cbfa4afd3adc1beb70e3f807510ba63c8f78f857f502a6b246587ef48dc',
            requiredEvolution: null,
          },
        ],
        mdmNomenclature: null,
        genealogyLatestDate: '2024-10-01',
        genealogySourceRelationCount: 0,
        genealogyEvidenceFingerprint:
          '9be65b636c9b650351c8c49521dab48a84df4d91401fe06e5b15a58fc3b56394',
        operationalReferenceEvidenceFingerprint:
          '92eb63115b974328dd83c031bd6f747d66dcb491e8689e3774057ca86c94e7c3',
        reconciliationStateFingerprint:
          '52319a44546bfec9b2061cbef418156eeed3e0e10039a8fcf8e4ffa8bc6a18e2',
      },
    ]);
    expect(Object.isFrozen(SANDRE_LKG_APPROVALS)).toBe(true);
    expect(Object.isFrozen(approval)).toBe(true);
    expect(Object.isFrozen(approval.feature)).toBe(true);
    expect(Object.isFrozen(approval.localZone)).toBe(true);
    expect(Object.isFrozen(approval.mdmRecords)).toBe(true);
    expect(Object.isFrozen(approval.mdmRecords[0])).toBe(true);
  });

  it('matches the exact official snapshot before loading local evidence', () => {
    withFeatureGeometryHash(approval.feature.geometryEvidenceSha256, () => {
      expect(findSandreLkgApproval('06', exactSnapshot())).toBe(approval);
      expect(
        findSandreApprovedLkgRetentionForSnapshot('06', exactSnapshot()),
      ).toBe(approval);
    });
  });

  it.each([
    [
      'snapshot hash',
      (snapshot: SandreZoneSnapshot) =>
        (snapshot.snapshotHash = '0'.repeat(64)),
    ],
    [
      'snapshot date',
      (snapshot: SandreZoneSnapshot) =>
        (snapshot.sourceUpdatedAt = '2026-08-18'),
    ],
    [
      'declared feature count',
      (snapshot: SandreZoneSnapshot) => (snapshot.featureCount = 54),
    ],
    [
      'actual feature count',
      (snapshot: SandreZoneSnapshot) => snapshot.features.pop(),
    ],
    [
      'feature code',
      (snapshot: SandreZoneSnapshot) =>
        (snapshot.features[0].codeSandre = '3860'),
    ],
    [
      'feature gid',
      (snapshot: SandreZoneSnapshot) => (snapshot.features[0].gid = 3860),
    ],
    [
      'feature status',
      (snapshot: SandreZoneSnapshot) =>
        (snapshot.features[0].status = 'Validé'),
    ],
    [
      'feature payload',
      (snapshot: SandreZoneSnapshot) =>
        (snapshot.features[0].payloadHash = '0'.repeat(64)),
    ],
  ] as const)('rejects %s drift in the official snapshot', (_label, mutate) => {
    const snapshot = exactSnapshot();
    mutate(snapshot);

    withFeatureGeometryHash(approval.feature.geometryEvidenceSha256, () => {
      expect(findSandreLkgApproval('06', snapshot)).toBeNull();
    });
  });

  it('rejects official geometry evidence drift', () => {
    withFeatureGeometryHash('0'.repeat(64), () => {
      expect(findSandreLkgApproval('06', exactSnapshot())).toBeNull();
    });
  });

  it('accepts the complete local, MDM, genealogy and reference observation', () => {
    const observation = exactObservation();

    expect(() =>
      assertSandreLkgObservation(approval, observation),
    ).not.toThrow();
    expect(findSandreApprovedLkgRetentionForObservation(observation)).toBe(
      approval,
    );
  });

  it.each([
    [
      'department',
      (value: SandreLkgObservation) => (value.departmentCode = '07'),
    ],
    [
      'feature geometry',
      (value: SandreLkgObservation) =>
        (value.feature.geometryEvidenceSha256 = '0'.repeat(64)),
    ],
    [
      'local zone identity',
      (value: SandreLkgObservation) => (value.localZone.idSandre = 3860),
    ],
    [
      'local Sandre payload',
      (value: SandreLkgObservation) =>
        (value.localZone.sandrePayloadHash = '0'.repeat(64)),
    ],
    [
      'local geometry',
      (value: SandreLkgObservation) =>
        (value.localZone.ewkbMd5 = '0'.repeat(32)),
    ],
    [
      'local name',
      (value: SandreLkgObservation) =>
        (value.localZone.nom = 'Saint-Cassien changed'),
    ],
    [
      'local influenced resource flag',
      (value: SandreLkgObservation) =>
        (value.localZone.ressourceInfluencee = false),
    ],
    [
      'local basin identity',
      (value: SandreLkgObservation) => (value.localZone.bassinVersantId = 8),
    ],
    [
      'local basin code',
      (value: SandreLkgObservation) => (value.localZone.bassinVersantCode = 7),
    ],
    [
      'MDM projection',
      (value: SandreLkgObservation) =>
        (value.mdmRecords[0].projectionSha256 = '0'.repeat(64)),
    ],
    [
      'genealogy date',
      (value: SandreLkgObservation) =>
        (value.genealogyLatestDate = '2024-10-02'),
    ],
    [
      'genealogy relation count',
      (value: SandreLkgObservation) => (value.genealogySourceRelationCount = 1),
    ],
    [
      'genealogy projection',
      (value: SandreLkgObservation) =>
        (value.genealogyEvidenceFingerprint = '0'.repeat(64)),
    ],
    [
      'operational references',
      (value: SandreLkgObservation) =>
        (value.operationalReferenceEvidenceFingerprint = '0'.repeat(64)),
    ],
    [
      'complete reconciliation state',
      (value: SandreLkgObservation) =>
        (value.reconciliationStateFingerprint = '0'.repeat(64)),
    ],
  ] as const)('fails closed on %s observation drift', (_label, mutate) => {
    const observation = exactObservation();
    mutate(observation);

    expect(() => assertSandreLkgObservation(approval, observation)).toThrow(
      'Sandre LKG observation changed',
    );
    expect(
      findSandreApprovedLkgRetentionForObservation(observation),
    ).toBeNull();
  });

  it.each([
    ['an extra field', { unexpected: true }],
    ['an invalid snapshot hash', { snapshotHash: 'not-a-hash' }],
    ['an invalid feature count', { featureCount: 0 }],
    [
      'a validated source',
      { feature: { ...approval.feature, status: 'Validé' } },
    ],
    [
      'a local type mismatch',
      { localZone: { ...approval.localZone, type: 'SOU' } },
    ],
    [
      'an invalid MDM projection',
      {
        mdmRecords: [
          { ...approval.mdmRecords[0], projectionSha256: 'not-a-hash' },
        ],
      },
    ],
    ['a non-null MDM nomenclature', { mdmNomenclature: {} }],
    ['a genealogy relation', { genealogySourceRelationCount: 1 }],
    [
      'an invalid operational reference fingerprint',
      { operationalReferenceEvidenceFingerprint: 'not-a-hash' },
    ],
    [
      'an invalid reconciliation state fingerprint',
      { reconciliationStateFingerprint: 'not-a-hash' },
    ],
  ])('rejects approval configuration with %s', (_label, override) => {
    const candidate = {
      ...approval,
      ...override,
      feature:
        'feature' in override ? override.feature : { ...approval.feature },
      localZone:
        'localZone' in override
          ? override.localZone
          : { ...approval.localZone },
      mdmRecords:
        'mdmRecords' in override
          ? override.mdmRecords
          : approval.mdmRecords.map((record) => ({ ...record })),
    };

    expect(() => parseSandreLkgApproval(candidate)).toThrow(
      'Invalid Sandre LKG approval',
    );
  });

  it('builds official feature geometry evidence deterministically', () => {
    const feature = exactFeature();
    const expectedGeometryHash = reconciliation.fingerprint({
      type: feature.geometry.type,
      coordinates: feature.geometry.coordinates,
    });

    expect(sandreLkgFeatureEvidence(feature)).toEqual({
      ...approval.feature,
      geometryEvidenceSha256: expectedGeometryHash,
    });
  });
});
