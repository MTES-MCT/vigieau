import {
  buildZonePublicationAggregate,
  computeZonePublicationFingerprint,
} from '@shared/zone_publication_materialization';

describe('zone publication materialization', () => {
  it('builds department aggregates from the exact public zone payloads', () => {
    expect(
      buildZonePublicationAggregate(
        [
          {
            id: 1,
            departement: '65',
            type: 'SUP',
            niveauGravite: 'alerte',
          },
          {
            id: 2,
            departement: '65',
            type: 'SOU',
            niveauGravite: 'crise',
          },
          {
            id: 3,
            departement: '31',
            type: 'AEP',
            niveauGravite: 'vigilance',
          },
        ],
        7,
      ),
    ).toEqual({
      schemaVersion: 1,
      counts: {
        zones: 3,
        communeLinks: 7,
        restrictedZones: 3,
        byType: { SUP: 1, SOU: 1, AEP: 1 },
      },
      departments: {
        '31': {
          max: 'vigilance',
          sup: null,
          sou: null,
          aep: 'vigilance',
        },
        '65': { max: 'crise', sup: 'alerte', sou: 'crise', aep: null },
      },
    });
  });

  it('produces the same fingerprint regardless of database row order', () => {
    const aggregate = buildZonePublicationAggregate(
      [
        { departement: '65', type: 'SUP', niveauGravite: 'alerte' },
        { departement: '31', type: 'AEP', niveauGravite: 'crise' },
      ],
      3,
    );
    const zones = [
      {
        sourceZoneId: 10,
        departmentCode: '65',
        type: 'SUP',
        geometry: '{"type":"Polygon","coordinates":[]}',
        publicPayload: { type: 'SUP', id: 10, departement: '65' },
        communeCodes: ['65002', '65001'],
      },
      {
        sourceZoneId: 2,
        departmentCode: '31',
        type: 'AEP',
        geometry: '{"type":"Polygon","coordinates":[]}',
        publicPayload: { departement: '31', id: 2, type: 'AEP' },
        communeCodes: ['31001'],
      },
    ];

    const first = computeZonePublicationFingerprint({ zones, aggregate });
    const second = computeZonePublicationFingerprint({
      zones: [...zones].reverse().map((zone) => ({
        ...zone,
        communeCodes: [...zone.communeCodes].reverse(),
      })),
      aggregate: {
        ...aggregate,
        counts: { ...aggregate.counts },
      },
    });

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });

  it('changes the fingerprint when an aggregate changes', () => {
    const aggregate = buildZonePublicationAggregate(
      [{ departement: '65', type: 'SUP', niveauGravite: 'alerte' }],
      1,
    );
    const zones = [
      {
        sourceZoneId: 1,
        departmentCode: '65',
        type: 'SUP',
        geometry: '{"type":"Polygon","coordinates":[]}',
        publicPayload: {
          id: 1,
          departement: '65',
          type: 'SUP',
          niveauGravite: 'alerte',
        },
        communeCodes: ['65001'],
      },
    ];

    const expected = computeZonePublicationFingerprint({ zones, aggregate });
    const changed = computeZonePublicationFingerprint({
      zones,
      aggregate: {
        ...aggregate,
        counts: { ...aggregate.counts, communeLinks: 2 },
      },
    });

    expect(changed).not.toBe(expected);
  });
});
