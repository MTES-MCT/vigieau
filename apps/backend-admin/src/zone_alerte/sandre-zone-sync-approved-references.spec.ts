import { fingerprint } from './sandre-zone-reconciliation';
import {
  fingerprintSandreApprovedPostApplyEvidence,
  SandreApprovedReferenceEvidence,
  SandreApprovedTargetOperationalState,
} from './sandre-zone-sync-approved-references';

function postApplyEvidence(
  updateTarget?: (
    target: SandreApprovedTargetOperationalState,
  ) => SandreApprovedTargetOperationalState,
): SandreApprovedReferenceEvidence {
  const targetState = [
    {
      targetIndex: 0,
      arreteCadreIds: [700],
      restrictions: [
        {
          restrictionId: 900,
          arreteRestrictionId: 800,
          parentStatus: 'publie',
          parentDateDebut: '2026-08-22',
          payloadFingerprint: '1'.repeat(64),
          computedIds: [1000],
          historicIds: [2000],
        },
      ],
      customizationCount: 0,
      aliasCount: 0,
    },
  ].map((target) => (updateTarget ? updateTarget(target) : target));
  const unsigned = {
    sourceZoneId: 600,
    lifecycle: 'post_apply' as const,
    sourceOperationalEmpty: true,
    arreteCadreLinks: [{ arreteCadreId: 700, parentStatus: 'publie' }],
    restrictions: [],
    customizationCount: 0,
    aliasCount: 0,
    targetCollisionFingerprint: fingerprint([]),
    targetStateFingerprint: fingerprint(targetState),
    targetState,
  };
  return { ...unsigned, fingerprint: fingerprint(unsigned) };
}

describe('approved Sandre post-apply evidence fingerprint', () => {
  it('ignores only rematerialized computed and historic identifiers', () => {
    const audited = postApplyEvidence();
    const rematerialized = postApplyEvidence((target) => ({
      ...target,
      restrictions: target.restrictions.map((restriction) => ({
        ...restriction,
        computedIds: [1001],
        historicIds: [2001],
      })),
    }));

    expect(rematerialized.fingerprint).not.toBe(audited.fingerprint);
    expect(fingerprintSandreApprovedPostApplyEvidence(rematerialized)).toBe(
      fingerprintSandreApprovedPostApplyEvidence(audited),
    );
  });

  it.each<
    [
      string,
      (
        target: SandreApprovedTargetOperationalState,
      ) => SandreApprovedTargetOperationalState,
    ]
  >([
    [
      'payload',
      (target: SandreApprovedTargetOperationalState) => ({
        ...target,
        restrictions: target.restrictions.map((restriction) => ({
          ...restriction,
          payloadFingerprint: '2'.repeat(64),
        })),
      }),
    ],
    [
      'restriction identity',
      (target: SandreApprovedTargetOperationalState) => ({
        ...target,
        restrictions: target.restrictions.map((restriction) => ({
          ...restriction,
          restrictionId: restriction.restrictionId + 1,
        })),
      }),
    ],
    [
      'framework link',
      (target: SandreApprovedTargetOperationalState) => ({
        ...target,
        arreteCadreIds: [701],
      }),
    ],
    [
      'computed cardinality',
      (target: SandreApprovedTargetOperationalState) => ({
        ...target,
        restrictions: target.restrictions.map((restriction) => ({
          ...restriction,
          computedIds: [...restriction.computedIds, 1002],
        })),
      }),
    ],
    [
      'historic cardinality',
      (target: SandreApprovedTargetOperationalState) => ({
        ...target,
        restrictions: target.restrictions.map((restriction) => ({
          ...restriction,
          historicIds: [],
        })),
      }),
    ],
  ])('keeps %s drift sealed', (_label, updateTarget) => {
    const audited = postApplyEvidence();
    const drifted = postApplyEvidence(updateTarget);

    expect(fingerprintSandreApprovedPostApplyEvidence(drifted)).not.toBe(
      fingerprintSandreApprovedPostApplyEvidence(audited),
    );
  });
});
