import {
  buildReconciliationResults,
  DatabaseAliasState,
  discoverGenealogyCsvUrl,
  earliestMappedRestrictionDate,
  findBlockingCollisions,
  LocalZoneRecord,
  mappingsFromResults,
  OfficialZoneRecord,
  parseGenealogyCsv,
  ReconciliationDatabaseState,
  ReconciliationMapping,
  ReconciliationResult,
  SandreGenealogyRelation,
  transformDatabaseState,
  ZoneReferenceCounts,
} from './sandre-zone-reconciliation';

const metadataResource = (
  url: string,
  name = "Télécharger la généalogie des zones d'alerte sécheresse",
) => `
  <gmd:CI_OnlineResource>
    <gmd:linkage><gmd:URL>${url}</gmd:URL></gmd:linkage>
    <gmd:name><gco:CharacterString>${name}</gco:CharacterString></gmd:name>
  </gmd:CI_OnlineResource>
`;

const genealogyRelation = (
  parentCode: string,
  childCode: string,
  modificationType = '2',
): SandreGenealogyRelation => ({
  id: `${parentCode}-${childCode}`,
  parentCode,
  childCode,
  modificationDate: '2024-10-01',
  modificationType,
  reason: null,
});

const officialZone = (
  code: string,
  gid: number,
  status: string,
  departmentCode = '31',
): OfficialZoneRecord => ({
  code,
  gid,
  status,
  departmentCode,
  type: 'SUP',
  payloadHash: `hash-${code}`,
});

const localZone = (
  id: number,
  codeSandre: string,
  disabled: boolean,
  departmentCode = '31',
): LocalZoneRecord => ({
  id,
  idSandre: id,
  codeSandre,
  disabled,
  departmentId: Number(departmentCode),
  departmentCode,
  type: 'SUP',
  sandrePayloadHash: `hash-${codeSandre}`,
});

const references = (nonAbrogeArreteCadre = 1): ZoneReferenceCounts => ({
  arreteCadre: 1,
  nonAbrogeArreteCadre,
  restrictions: 1,
  customizations: 1,
});

const mapping: ReconciliationMapping = {
  departmentId: 31,
  departmentCode: '31',
  zoneType: 'SUP',
  oldZoneId: 1,
  oldCodeSandre: 'OLD',
  newZoneId: 2,
  newCodeSandre: 'NEW',
};

describe('Sandre zone reconciliation', () => {
  describe('official genealogy source', () => {
    it('selects the uniquely named download resource from the metadata XML', () => {
      const xml = `
        <root xmlns:gmd="gmd" xmlns:gco="gco">
          ${metadataResource(
            'https://example.test/unrelated.csv',
            'Une autre ressource',
          )}
          ${metadataResource(
            'https://services.sandre.eaufrance.fr/telechargement/geo/ZAS/GenealogieZAS_millésime2024.csv',
          )}
        </root>
      `;

      expect(decodeURIComponent(discoverGenealogyCsvUrl(xml))).toBe(
        'https://services.sandre.eaufrance.fr/telechargement/geo/ZAS/GenealogieZAS_millésime2024.csv',
      );
    });

    it('rejects duplicate named resources and non-Sandre download URLs', () => {
      const duplicateXml = `<root>${metadataResource(
        'https://services.sandre.eaufrance.fr/one.csv',
      )}${metadataResource(
        'https://services.sandre.eaufrance.fr/two.csv',
      )}</root>`;
      expect(() => discoverGenealogyCsvUrl(duplicateXml)).toThrow(
        'Expected exactly one',
      );

      const foreignXml = `<root>${metadataResource(
        'https://example.test/genealogy.csv',
      )}</root>`;
      expect(() => discoverGenealogyCsvUrl(foreignXml)).toThrow(
        'official HTTPS origin',
      );
    });

    it('keeps Sandre modification types as strings', () => {
      const csv = [
        'id,CdZASParent,CdZASEnfant,DtGenZAS,TypGenZAS,RaisGenZAS',
        '1,0001,0002,2024-10-01,2,Remplacement',
        '2,0003,0004,2024-10-01,4.1,Modification',
      ].join('\n');

      expect(parseGenealogyCsv(csv)).toEqual([
        expect.objectContaining({
          parentCode: '0001',
          childCode: '0002',
          modificationType: '2',
        }),
        expect.objectContaining({
          parentCode: '0003',
          childCode: '0004',
          modificationType: '4.1',
        }),
      ]);
    });
  });

  describe('candidate selection', () => {
    it('accepts a unique linear type-2 path to a local active zone', () => {
      const zones = [localZone(1, 'OLD', true), localZone(2, 'NEW', false)];
      const results = buildReconciliationResults(
        [genealogyRelation('OLD', 'MID'), genealogyRelation('MID', 'NEW')],
        [
          officialZone('OLD', 1, 'Gelé'),
          officialZone('MID', 3, 'Gelé'),
          officialZone('NEW', 2, 'Validé'),
        ],
        zones,
        new Map([[1, references()]]),
      );

      expect(results).toEqual([
        expect.objectContaining({
          status: 'APPLICABLE',
          reason: 'OFFICIAL_LINEAR_SUCCESSOR',
          oldZoneId: 1,
          newZoneId: 2,
          genealogyPath: ['OLD', 'MID', 'NEW'],
        }),
      ]);
      expect(mappingsFromResults(results, zones)).toEqual([mapping]);
    });

    it('refuses automatic split and merge mappings even when each row looks applicable', () => {
      const zones = [
        localZone(1, 'OLD-A', true),
        localZone(2, 'NEW', false),
        localZone(3, 'OLD-B', true),
      ];
      const results: ReconciliationResult[] = [
        {
          status: 'APPLICABLE',
          reason: 'OFFICIAL_LINEAR_SUCCESSOR',
          departmentCode: '31',
          oldZoneId: 1,
          oldCodeSandre: 'OLD-A',
          newZoneId: 2,
          newCodeSandre: 'NEW',
          genealogyPath: ['OLD-A', 'NEW'],
          references: references(),
        },
        {
          status: 'APPLICABLE',
          reason: 'OFFICIAL_LINEAR_SUCCESSOR',
          departmentCode: '31',
          oldZoneId: 3,
          oldCodeSandre: 'OLD-B',
          newZoneId: 2,
          newCodeSandre: 'NEW',
          genealogyPath: ['OLD-B', 'NEW'],
          references: references(),
        },
      ];

      expect(() => mappingsFromResults(results, zones)).toThrow(
        'split or merge',
      );
    });

    it.each([
      {
        name: 'missing',
        intermediateZones: [],
        reason: 'INTERMEDIATE_NOT_IN_SNAPSHOT',
        status: 'NO_OFFICIAL_SUCCESSOR',
      },
      {
        name: 'still active',
        intermediateZones: [officialZone('MID', 3, 'Validé')],
        reason: 'INTERMEDIATE_NOT_FROZEN',
        status: 'AMBIGUOUS',
      },
      {
        name: 'outside the source scope',
        intermediateZones: [officialZone('MID', 3, 'Gelé', '66')],
        reason: 'INTERMEDIATE_SCOPE_MISMATCH',
        status: 'AMBIGUOUS',
      },
    ])(
      'rejects a $name intermediate zone',
      ({ intermediateZones, reason, status }) => {
        const zones = [localZone(1, 'OLD', true), localZone(2, 'NEW', false)];
        const results = buildReconciliationResults(
          [genealogyRelation('OLD', 'MID'), genealogyRelation('MID', 'NEW')],
          [
            officialZone('OLD', 1, 'Gelé'),
            ...intermediateZones,
            officialZone('NEW', 2, 'Validé'),
          ],
          zones,
          new Map([[1, references()]]),
        );

        expect(results[0]).toEqual(expect.objectContaining({ status, reason }));
        expect(mappingsFromResults(results, zones)).toEqual([]);
      },
    );

    it('reports but excludes zones referenced only by abrogated ACs', () => {
      const zones = [localZone(1, 'OLD', true), localZone(2, 'NEW', false)];
      const results = buildReconciliationResults(
        [genealogyRelation('OLD', 'NEW')],
        [officialZone('OLD', 1, 'Gelé'), officialZone('NEW', 2, 'Validé')],
        zones,
        new Map([[1, references(0)]]),
      );

      expect(results[0]).toEqual(
        expect.objectContaining({
          status: 'NO_OFFICIAL_SUCCESSOR',
          reason: 'NO_NON_ABROGATED_AC_REFERENCE',
          newZoneId: 2,
        }),
      );
      expect(mappingsFromResults(results, zones)).toEqual([]);
    });

    it.each([
      {
        name: 'branch',
        relations: [
          genealogyRelation('OLD', 'NEW'),
          genealogyRelation('OLD', 'OTHER'),
        ],
        reason: 'BRANCHED_GENEALOGY',
      },
      {
        name: 'cycle',
        relations: [
          genealogyRelation('OLD', 'NEW'),
          genealogyRelation('NEW', 'OLD'),
        ],
        reason: 'CYCLIC_GENEALOGY',
      },
    ])('classifies a $name as ambiguous', ({ relations, reason }) => {
      const results = buildReconciliationResults(
        relations,
        [officialZone('OLD', 1, 'Gelé'), officialZone('NEW', 2, 'Validé')],
        [localZone(1, 'OLD', true), localZone(2, 'NEW', false)],
        new Map([[1, references()]]),
      );

      expect(results[0]).toEqual(
        expect.objectContaining({ status: 'AMBIGUOUS', reason }),
      );
    });

    it('does not interpret another modification type as a successor', () => {
      const results = buildReconciliationResults(
        [genealogyRelation('OLD', 'NEW', '4.1')],
        [officialZone('OLD', 1, 'Gelé'), officialZone('NEW', 2, 'Validé')],
        [localZone(1, 'OLD', true), localZone(2, 'NEW', false)],
        new Map([[1, references()]]),
      );

      expect(results[0]).toEqual(
        expect.objectContaining({
          status: 'NO_OFFICIAL_SUCCESSOR',
          reason: 'NO_TYPE_2_SUCCESSOR',
        }),
      );
    });

    it('produces no automatic mapping for an ambiguous department 65 graph', () => {
      const zones = [
        localZone(6501, 'OLD-65', true, '65'),
        localZone(6502, 'NEW-65-A', false, '65'),
        localZone(6503, 'NEW-65-B', false, '65'),
      ];
      const results = buildReconciliationResults(
        [
          genealogyRelation('OLD-65', 'NEW-65-A'),
          genealogyRelation('OLD-65', 'NEW-65-B'),
        ],
        [
          officialZone('OLD-65', 6501, 'Gelé', '65'),
          officialZone('NEW-65-A', 6502, 'Validé', '65'),
          officialZone('NEW-65-B', 6503, 'Validé', '65'),
        ],
        zones,
        new Map([[6501, references()]]),
      );

      expect(results[0].reason).toBe('BRANCHED_GENEALOGY');
      expect(mappingsFromResults(results, zones)).toEqual([]);
    });
  });

  describe('relation preservation', () => {
    it('blocks restriction, customization and alias identity collisions', () => {
      const state = databaseState({
        restrictions: [restriction(10, 50, 1), restriction(11, 50, 2)],
        customizations: [
          customization(20, 60, 1, [100]),
          customization(21, 60, 2, [101]),
        ],
        aliases: [alias(99, 'OLD')],
      });

      expect(findBlockingCollisions(state, [mapping])).toEqual([
        expect.objectContaining({ type: 'ALIAS' }),
        expect.objectContaining({ type: 'CUSTOMIZATION' }),
        expect.objectContaining({ type: 'RESTRICTION' }),
      ]);
    });

    it('moves links without changing restriction or customization identities', () => {
      const state = databaseState({
        arreteCadreLinks: [
          {
            arreteCadreId: 60,
            arreteCadreStatut: 'publie',
            zoneAlerteId: 1,
          },
          {
            arreteCadreId: 60,
            arreteCadreStatut: 'publie',
            zoneAlerteId: 2,
          },
          {
            arreteCadreId: 61,
            arreteCadreStatut: 'a_venir',
            zoneAlerteId: 1,
          },
        ],
        restrictions: [restriction(10, 50, 1)],
        customizations: [customization(20, 60, 1, [100, 101])],
        aliases: [alias(1, 'LEGACY')],
      });

      const transformed = transformDatabaseState(state, [mapping]);

      expect(transformed.arreteCadreLinks).toEqual([
        {
          arreteCadreId: 60,
          arreteCadreStatut: 'publie',
          zoneAlerteId: 2,
        },
        {
          arreteCadreId: 61,
          arreteCadreStatut: 'a_venir',
          zoneAlerteId: 2,
        },
      ]);
      expect(transformed.restrictions).toEqual([
        expect.objectContaining({ id: 10, zoneAlerteId: 2 }),
      ]);
      expect(transformed.customizations).toEqual([
        expect.objectContaining({
          id: 20,
          zoneAlerteId: 2,
          communeIds: [100, 101],
        }),
      ]);
      expect(transformed.aliases).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            zoneAlerteId: 2,
            aliasValue: 'LEGACY',
          }),
          expect.objectContaining({
            zoneAlerteId: 2,
            aliasValue: 'OLD',
            source: 'manual_reconciliation',
          }),
        ]),
      );
      expect(earliestMappedRestrictionDate(state, [mapping])).toBe(
        '2025-01-01',
      );
    });

    it('deduplicates an existing canonical alias and preserves its source', () => {
      const state = databaseState({
        aliases: [alias(1, 'OLD')],
      });

      const transformed = transformDatabaseState(state, [mapping]);

      expect(transformed.aliases).toEqual([
        expect.objectContaining({
          zoneAlerteId: 2,
          aliasValue: 'OLD',
          source: 'official_sync',
        }),
      ]);
    });
  });
});

function databaseState(
  overrides: Partial<ReconciliationDatabaseState>,
): ReconciliationDatabaseState {
  return {
    zones: [
      {
        id: 1,
        idSandre: 1,
        codeSandre: 'OLD',
        disabled: true,
        departmentId: 31,
        type: 'SUP',
        sandrePayloadHash: 'old-hash',
      },
      {
        id: 2,
        idSandre: 2,
        codeSandre: 'NEW',
        disabled: false,
        departmentId: 31,
        type: 'SUP',
        sandrePayloadHash: 'new-hash',
      },
    ],
    arreteCadreLinks: [],
    restrictions: [],
    customizations: [],
    aliases: [],
    ...overrides,
  };
}

function restriction(
  id: number,
  arreteRestrictionId: number,
  zoneAlerteId: number,
) {
  return {
    id,
    arreteRestrictionId,
    arreteRestrictionDateDebut: '2025-01-01',
    zoneAlerteId,
    arreteCadreId: null,
    nomGroupementAep: null,
    niveauGravite: null,
  };
}

function customization(
  id: number,
  arreteCadreId: number,
  zoneAlerteId: number,
  communeIds: number[],
) {
  return { id, arreteCadreId, zoneAlerteId, communeIds };
}

function alias(zoneAlerteId: number, aliasValue: string): DatabaseAliasState {
  return {
    departmentId: 31,
    zoneAlerteId,
    zoneType: 'SUP',
    aliasType: 'cd_zas',
    aliasValue,
    source: 'official_sync',
  };
}
