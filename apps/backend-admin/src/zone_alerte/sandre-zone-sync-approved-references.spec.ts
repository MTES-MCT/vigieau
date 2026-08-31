import { fingerprint } from './sandre-zone-reconciliation';
import {
  fingerprintSandreApprovedPostApplyLineage,
  SANDRE_APPROVED_LINEAGE_VERSION,
  SandreApprovedReferenceEvidence,
  SandreApprovedTargetOperationalState,
} from './sandre-zone-sync-approved-references';

function postApplyEvidence(): SandreApprovedReferenceEvidence {
  const migratedRestriction = {
    restrictionId: 900,
    arreteRestrictionId: 800,
    parentStatus: 'publie',
    parentDateDebut: '2026-08-22',
    payloadFingerprint: '1'.repeat(64),
    computedIds: [1000],
    historicIds: [2000],
  };
  const targetState: SandreApprovedTargetOperationalState[] = [
    {
      targetIndex: 0,
      arreteCadreIds: [700],
      restrictions: [migratedRestriction],
      customizationCount: 0,
      aliasCount: 0,
    },
  ];
  const unsigned = {
    sourceZoneId: 600,
    lifecycle: 'post_apply' as const,
    sourceOperationalEmpty: true,
    arreteCadreLinks: [{ arreteCadreId: 700, parentStatus: 'publie' }],
    restrictions: [migratedRestriction],
    customizationCount: 0,
    aliasCount: 0,
    targetCollisionFingerprint: fingerprint([]),
    targetStateFingerprint: fingerprint(targetState),
    targetState,
  };
  return { ...unsigned, fingerprint: fingerprint(unsigned) };
}

describe('approved Sandre immutable post-apply lineage', () => {
  it('versions the derived lineage without requiring persisted evidence migration', () => {
    expect(SANDRE_APPROVED_LINEAGE_VERSION).toBe(1);
    expect(
      fingerprintSandreApprovedPostApplyLineage(postApplyEvidence()),
    ).toMatch(/^[a-f0-9]{64}$/);
  });

  it('accepts department 85 derived cache disappearance and rematerialization', () => {
    const audited = postApplyEvidence();
    const evolved = {
      ...audited,
      restrictions: audited.restrictions.map((restriction) => ({
        ...restriction,
        parentStatus: 'abroge',
        payloadFingerprint: '2'.repeat(64),
        computedIds: [],
        historicIds: [],
      })),
      targetState: audited.targetState.map((target) => ({
        ...target,
        restrictions: target.restrictions.map((restriction) => ({
          ...restriction,
          parentStatus: 'abroge',
          payloadFingerprint: '3'.repeat(64),
          computedIds: [3000, 3001],
          historicIds: [],
        })),
      })),
    };

    expect(fingerprintSandreApprovedPostApplyLineage(evolved)).toBe(
      fingerprintSandreApprovedPostApplyLineage(audited),
    );
  });

  it('accepts department 24 revocation and a later order on only one target', () => {
    const audited = postApplyEvidence();
    const evolvedTargetState: SandreApprovedTargetOperationalState[] = [
      {
        targetIndex: 0,
        arreteCadreIds: [701],
        restrictions: [
          {
            restrictionId: 901,
            arreteRestrictionId: 801,
            parentStatus: 'publie',
            parentDateDebut: '2026-08-29',
            payloadFingerprint: '2'.repeat(64),
            computedIds: [3000],
            historicIds: [],
          },
        ],
        customizationCount: 1,
        aliasCount: 1,
      },
    ];
    const evolved = {
      ...audited,
      arreteCadreLinks: audited.arreteCadreLinks.map((link) => ({
        ...link,
        parentStatus: 'abroge',
      })),
      restrictions: audited.restrictions.map((restriction) => ({
        ...restriction,
        parentStatus: 'abroge',
        parentDateDebut: '2026-08-29',
        payloadFingerprint: '3'.repeat(64),
        computedIds: [],
        historicIds: [],
      })),
      targetStateFingerprint: fingerprint(evolvedTargetState),
      targetState: evolvedTargetState,
    };

    expect(fingerprintSandreApprovedPostApplyLineage(evolved)).toBe(
      fingerprintSandreApprovedPostApplyLineage(audited),
    );
  });

  it.each<
    [
      string,
      (
        evidence: SandreApprovedReferenceEvidence,
      ) => SandreApprovedReferenceEvidence,
    ]
  >([
    [
      'migrated restriction identity',
      (evidence) => ({
        ...evidence,
        restrictions: evidence.restrictions.map((restriction) => ({
          ...restriction,
          restrictionId: restriction.restrictionId + 1,
        })),
      }),
    ],
    [
      'migrated framework lineage',
      (evidence) => ({
        ...evidence,
        arreteCadreLinks: [{ arreteCadreId: 701, parentStatus: 'publie' }],
      }),
    ],
    [
      'source identity',
      (evidence) => ({
        ...evidence,
        sourceZoneId: evidence.sourceZoneId + 1,
      }),
    ],
    [
      'source reference state',
      (evidence) => ({ ...evidence, sourceOperationalEmpty: false }),
    ],
  ])('keeps %s sealed', (_label, evolve) => {
    const audited = postApplyEvidence();
    expect(fingerprintSandreApprovedPostApplyLineage(evolve(audited))).not.toBe(
      fingerprintSandreApprovedPostApplyLineage(audited),
    );
  });
});
