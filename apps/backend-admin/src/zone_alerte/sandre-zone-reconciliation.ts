import { createHash } from 'crypto';
import { XMLParser } from 'fast-xml-parser';
import { csv2json } from 'json-2-csv';

export const SANDRE_GENEALOGY_METADATA_URL =
  'https://www.sandre.eaufrance.fr/atlas/srv/api/records/0391a8b8-c850-45c7-a372-1f95bd204159/formatters/xml';

export const SANDRE_GENEALOGY_REQUEST_HEADERS = {
  accept: 'application/xml,text/xml,text/csv,text/html;q=0.9',
  'accept-language': 'fr',
} as const;

const SANDRE_GENEALOGY_RESOURCE_NAME =
  "Télécharger la généalogie des zones d'alerte sécheresse";

export type ReconciliationStatus =
  | 'APPLICABLE'
  | 'AMBIGUOUS'
  | 'NO_OFFICIAL_SUCCESSOR';

export interface SandreGenealogyRelation {
  id: string;
  parentCode: string | null;
  childCode: string | null;
  modificationDate: string | null;
  modificationType: string;
  reason: string | null;
}

export interface OfficialZoneRecord {
  code: string;
  gid: number;
  status: string;
  departmentCode: string;
  type: 'SOU' | 'SUP';
  payloadHash: string;
}

export interface LocalZoneRecord {
  id: number;
  idSandre: number | null;
  codeSandre: string | null;
  disabled: boolean;
  departmentId: number;
  departmentCode: string;
  type: 'SOU' | 'SUP';
  sandrePayloadHash: string | null;
}

export interface ZoneReferenceCounts {
  arreteCadre: number;
  nonAbrogeArreteCadre: number;
  restrictions: number;
  customizations: number;
}

export interface ReconciliationOptions {
  requireNonAbrogeArreteCadreReference?: boolean;
}

export interface ReconciliationResult {
  status: ReconciliationStatus;
  reason:
    | 'OFFICIAL_LINEAR_SUCCESSOR'
    | 'SOURCE_NOT_IN_SNAPSHOT'
    | 'SOURCE_NOT_FROZEN'
    | 'NO_TYPE_2_SUCCESSOR'
    | 'BRANCHED_GENEALOGY'
    | 'CYCLIC_GENEALOGY'
    | 'INTERMEDIATE_NOT_IN_SNAPSHOT'
    | 'INTERMEDIATE_NOT_FROZEN'
    | 'INTERMEDIATE_SCOPE_MISMATCH'
    | 'TERMINAL_NOT_IN_SNAPSHOT'
    | 'TERMINAL_NOT_VALIDATED'
    | 'SUCCESSOR_SCOPE_MISMATCH'
    | 'SUCCESSOR_NOT_LOCAL'
    | 'SUCCESSOR_NOT_ACTIVE'
    | 'MULTIPLE_LOCAL_SUCCESSORS'
    | 'SELF_MAPPING'
    | 'NO_NON_ABROGATED_AC_REFERENCE';
  departmentCode: string;
  oldZoneId: number;
  oldCodeSandre: string | null;
  newZoneId: number | null;
  newCodeSandre: string | null;
  genealogyPath: string[];
  references: ZoneReferenceCounts;
}

export interface ReconciliationMapping {
  departmentId: number;
  departmentCode: string;
  zoneType: 'SOU' | 'SUP';
  oldZoneId: number;
  oldCodeSandre: string;
  newZoneId: number;
  newCodeSandre: string;
}

export interface DatabaseZoneState {
  id: number;
  idSandre: number | null;
  codeSandre: string | null;
  disabled: boolean;
  departmentId: number;
  type: 'SOU' | 'SUP';
  sandrePayloadHash: string | null;
}

export interface DatabaseArreteCadreLink {
  arreteCadreId: number;
  arreteCadreStatut: string;
  zoneAlerteId: number;
}

export interface DatabaseRestrictionState {
  id: number;
  arreteRestrictionId: number;
  arreteRestrictionDateDebut: string | null;
  zoneAlerteId: number;
  arreteCadreId: number | null;
  nomGroupementAep: string | null;
  niveauGravite: string | null;
}

export interface DatabaseCustomizationState {
  id: number;
  arreteCadreId: number;
  zoneAlerteId: number;
  communeIds: number[];
}

export interface DatabaseAliasState {
  departmentId: number;
  zoneAlerteId: number;
  zoneType: 'SOU' | 'SUP';
  aliasType: string;
  aliasValue: string;
  source: string;
}

export interface ReconciliationDatabaseState {
  zones: DatabaseZoneState[];
  arreteCadreLinks: DatabaseArreteCadreLink[];
  restrictions: DatabaseRestrictionState[];
  customizations: DatabaseCustomizationState[];
  aliases: DatabaseAliasState[];
}

export interface BlockingCollision {
  type: 'RESTRICTION' | 'CUSTOMIZATION' | 'ALIAS';
  oldZoneId: number;
  newZoneId: number;
  conflictingId: number | string;
}

export function discoverGenealogyCsvUrl(
  metadataXml: string,
  metadataUrl: string = SANDRE_GENEALOGY_METADATA_URL,
): string {
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    textNodeName: '#text',
  }).parse(metadataXml);
  const resources: Record<string, unknown>[] = [];
  collectOnlineResources(parsed, resources);
  const candidates = resources.filter(
    (resource) =>
      xmlText(nestedValue(resource, ['gmd:name', 'gco:CharacterString'])) ===
      SANDRE_GENEALOGY_RESOURCE_NAME,
  );
  if (candidates.length !== 1) {
    throw new Error(
      `Expected exactly one official Sandre genealogy resource, found ${candidates.length}`,
    );
  }

  const href = xmlText(nestedValue(candidates[0], ['gmd:linkage', 'gmd:URL']));
  if (!href) {
    throw new Error('The official Sandre genealogy resource has no URL');
  }

  const csvUrl = new URL(href, metadataUrl);
  if (
    csvUrl.protocol !== 'https:' ||
    csvUrl.hostname !== 'services.sandre.eaufrance.fr' ||
    csvUrl.port ||
    csvUrl.username ||
    csvUrl.password ||
    !decodeURIComponent(csvUrl.pathname).toLowerCase().endsWith('.csv')
  ) {
    throw new Error('Sandre genealogy CSV must use the official HTTPS origin');
  }

  return csvUrl.toString();
}

export function parseGenealogyCsv(csv: string): SandreGenealogyRelation[] {
  const normalizedCsv = csv.replace(/^\uFEFF/, '');
  const rows = csv2json(normalizedCsv, {
    trimHeaderFields: true,
    trimFieldValues: true,
    parseValue: (value) => value,
  }) as Record<string, string>[];
  if (rows.length === 0) {
    throw new Error('Empty Sandre genealogy CSV');
  }

  const headers = Object.keys(rows[0]);
  const requiredHeaders = [
    'id',
    'CdZASParent',
    'CdZASEnfant',
    'DtGenZAS',
    'TypGenZAS',
    'RaisGenZAS',
  ];
  const missingHeaders = requiredHeaders.filter(
    (requiredHeader) => !headers.includes(requiredHeader),
  );
  if (missingHeaders.length > 0) {
    throw new Error(
      `Invalid Sandre genealogy CSV headers: ${missingHeaders.join(', ')}`,
    );
  }

  return rows.map((row, index) => {
    const modificationType = nonEmptyString(row.TypGenZAS);
    if (!modificationType) {
      throw new Error(
        `Invalid Sandre genealogy modification type at row ${index + 2}`,
      );
    }
    const relation: SandreGenealogyRelation = {
      id: nonEmptyString(row.id) ?? String(index + 1),
      parentCode: sandreCode(row.CdZASParent),
      childCode: sandreCode(row.CdZASEnfant),
      modificationDate: nonEmptyString(row.DtGenZAS),
      modificationType,
      reason: nonEmptyString(row.RaisGenZAS),
    };
    if (
      relation.modificationType === '2' &&
      (!relation.parentCode || !relation.childCode)
    ) {
      throw new Error(
        `Invalid Sandre type 2 genealogy relation at row ${index + 2}`,
      );
    }
    return relation;
  });
}

export function buildReconciliationResults(
  relations: SandreGenealogyRelation[],
  officialZones: OfficialZoneRecord[],
  localZones: LocalZoneRecord[],
  referenceCounts: Map<number, ZoneReferenceCounts> = new Map(),
  options: ReconciliationOptions = {},
): ReconciliationResult[] {
  const officialByCode = groupBy(officialZones, (zone) => zone.code);
  const officialByGid = groupBy(officialZones, (zone) => String(zone.gid));
  const localByCode = groupBy(
    localZones.filter((zone) => Boolean(zone.codeSandre)),
    (zone) => zone.codeSandre,
  );
  const localByLegacyGid = groupBy(
    localZones.filter((zone) => !zone.codeSandre && zone.idSandre !== null),
    (zone) => String(zone.idSandre),
  );
  const graph = createType2Graph(relations);

  return localZones
    .filter((zone) => zone.disabled)
    .sort(compareLocalZones)
    .map((oldZone) => {
      const references = referenceCounts.get(oldZone.id) ?? {
        arreteCadre: 0,
        nonAbrogeArreteCadre: 0,
        restrictions: 0,
        customizations: 0,
      };
      const sourceMatches = oldZone.codeSandre
        ? (officialByCode.get(oldZone.codeSandre) ?? [])
        : (officialByGid.get(String(oldZone.idSandre)) ?? []);
      if (sourceMatches.length !== 1) {
        return result(
          oldZone,
          references,
          sourceMatches.length > 1 ? 'AMBIGUOUS' : 'NO_OFFICIAL_SUCCESSOR',
          'SOURCE_NOT_IN_SNAPSHOT',
        );
      }

      const source = sourceMatches[0];
      if (!isSandreStatus(source.status, 'Gelé')) {
        return result(
          oldZone,
          references,
          'AMBIGUOUS',
          'SOURCE_NOT_FROZEN',
          source.code,
        );
      }

      const successor = findTerminalSuccessor(source.code, graph);
      if (successor.status !== 'SUCCESS') {
        return result(
          oldZone,
          references,
          successor.status === 'NONE' ? 'NO_OFFICIAL_SUCCESSOR' : 'AMBIGUOUS',
          successor.reason,
          source.code,
          null,
          successor.path,
        );
      }

      for (const intermediateCode of successor.path.slice(1, -1)) {
        const intermediateMatches = officialByCode.get(intermediateCode) ?? [];
        if (intermediateMatches.length !== 1) {
          return result(
            oldZone,
            references,
            intermediateMatches.length > 1
              ? 'AMBIGUOUS'
              : 'NO_OFFICIAL_SUCCESSOR',
            'INTERMEDIATE_NOT_IN_SNAPSHOT',
            source.code,
            successor.code,
            successor.path,
          );
        }
        const intermediate = intermediateMatches[0];
        if (!isSandreStatus(intermediate.status, 'Gelé')) {
          return result(
            oldZone,
            references,
            'AMBIGUOUS',
            'INTERMEDIATE_NOT_FROZEN',
            source.code,
            successor.code,
            successor.path,
          );
        }
        if (
          intermediate.departmentCode !== source.departmentCode ||
          intermediate.type !== source.type ||
          intermediate.departmentCode !== oldZone.departmentCode ||
          intermediate.type !== oldZone.type
        ) {
          return result(
            oldZone,
            references,
            'AMBIGUOUS',
            'INTERMEDIATE_SCOPE_MISMATCH',
            source.code,
            successor.code,
            successor.path,
          );
        }
      }

      const terminalMatches = officialByCode.get(successor.code) ?? [];
      if (terminalMatches.length !== 1) {
        return result(
          oldZone,
          references,
          terminalMatches.length > 1 ? 'AMBIGUOUS' : 'NO_OFFICIAL_SUCCESSOR',
          'TERMINAL_NOT_IN_SNAPSHOT',
          source.code,
          successor.code,
          successor.path,
        );
      }
      const terminal = terminalMatches[0];
      if (!isSandreStatus(terminal.status, 'Validé')) {
        return result(
          oldZone,
          references,
          'NO_OFFICIAL_SUCCESSOR',
          'TERMINAL_NOT_VALIDATED',
          source.code,
          terminal.code,
          successor.path,
        );
      }
      if (
        terminal.departmentCode !== source.departmentCode ||
        terminal.type !== source.type ||
        terminal.departmentCode !== oldZone.departmentCode ||
        terminal.type !== oldZone.type
      ) {
        return result(
          oldZone,
          references,
          'AMBIGUOUS',
          'SUCCESSOR_SCOPE_MISMATCH',
          source.code,
          terminal.code,
          successor.path,
        );
      }

      const targetMatches =
        localByCode.get(terminal.code) ??
        localByLegacyGid.get(String(terminal.gid)) ??
        [];
      if (targetMatches.length === 0) {
        return result(
          oldZone,
          references,
          'NO_OFFICIAL_SUCCESSOR',
          'SUCCESSOR_NOT_LOCAL',
          source.code,
          terminal.code,
          successor.path,
        );
      }
      if (targetMatches.length !== 1) {
        return result(
          oldZone,
          references,
          'AMBIGUOUS',
          'MULTIPLE_LOCAL_SUCCESSORS',
          source.code,
          terminal.code,
          successor.path,
        );
      }

      const target = targetMatches[0];
      if (
        target.departmentId !== oldZone.departmentId ||
        target.type !== oldZone.type
      ) {
        return result(
          oldZone,
          references,
          'AMBIGUOUS',
          'SUCCESSOR_SCOPE_MISMATCH',
          source.code,
          terminal.code,
          successor.path,
          target.id,
        );
      }
      if (target.id === oldZone.id) {
        return result(
          oldZone,
          references,
          'AMBIGUOUS',
          'SELF_MAPPING',
          source.code,
          terminal.code,
          successor.path,
          target.id,
        );
      }
      if (target.disabled) {
        return result(
          oldZone,
          references,
          'NO_OFFICIAL_SUCCESSOR',
          'SUCCESSOR_NOT_ACTIVE',
          source.code,
          terminal.code,
          successor.path,
          target.id,
        );
      }
      if (
        options.requireNonAbrogeArreteCadreReference !== false &&
        references.nonAbrogeArreteCadre === 0
      ) {
        return result(
          oldZone,
          references,
          'NO_OFFICIAL_SUCCESSOR',
          'NO_NON_ABROGATED_AC_REFERENCE',
          source.code,
          terminal.code,
          successor.path,
          target.id,
        );
      }

      return result(
        oldZone,
        references,
        'APPLICABLE',
        'OFFICIAL_LINEAR_SUCCESSOR',
        source.code,
        terminal.code,
        successor.path,
        target.id,
      );
    });
}

export function mappingsFromResults(
  results: ReconciliationResult[],
  localZones: LocalZoneRecord[],
): ReconciliationMapping[] {
  const zonesById = new Map(localZones.map((zone) => [zone.id, zone]));
  const mappings = results
    .filter(
      (
        item,
      ): item is ReconciliationResult & {
        newZoneId: number;
        oldCodeSandre: string;
        newCodeSandre: string;
      } =>
        item.status === 'APPLICABLE' &&
        item.newZoneId !== null &&
        item.oldCodeSandre !== null &&
        item.newCodeSandre !== null,
    )
    .map((item) => {
      const oldZone = zonesById.get(item.oldZoneId);
      if (!oldZone) {
        throw new Error(`Unknown local source zone ${item.oldZoneId}`);
      }
      return {
        departmentId: oldZone.departmentId,
        departmentCode: item.departmentCode,
        zoneType: oldZone.type,
        oldZoneId: item.oldZoneId,
        oldCodeSandre: item.oldCodeSandre,
        newZoneId: item.newZoneId,
        newCodeSandre: item.newCodeSandre,
      };
    })
    .sort(compareMappings);
  assertStrictOfficialOneToOneMappings(results, mappings);
  return mappings;
}

export function assertStrictOfficialOneToOneMappings(
  results: ReconciliationResult[],
  mappings: ReconciliationMapping[],
): void {
  const resultsByOldZoneId = new Map(
    results.map((item) => [item.oldZoneId, item]),
  );
  const oldZoneIds = new Set<number>();
  const newZoneIds = new Set<number>();

  for (const mapping of mappings) {
    const item = resultsByOldZoneId.get(mapping.oldZoneId);
    if (
      !item ||
      item.status !== 'APPLICABLE' ||
      item.reason !== 'OFFICIAL_LINEAR_SUCCESSOR' ||
      item.newZoneId !== mapping.newZoneId ||
      item.oldCodeSandre !== mapping.oldCodeSandre ||
      item.newCodeSandre !== mapping.newCodeSandre ||
      item.departmentCode !== mapping.departmentCode ||
      item.genealogyPath.length < 2
    ) {
      throw new Error(
        `Reconciliation mapping ${mapping.oldZoneId}:${mapping.newZoneId} is not a strict official 1:1 successor`,
      );
    }
    if (
      oldZoneIds.has(mapping.oldZoneId) ||
      newZoneIds.has(mapping.newZoneId)
    ) {
      throw new Error('Reconciliation mappings contain a split or merge');
    }
    oldZoneIds.add(mapping.oldZoneId);
    newZoneIds.add(mapping.newZoneId);
  }
}

export function findBlockingCollisions(
  state: ReconciliationDatabaseState,
  mappings: ReconciliationMapping[],
): BlockingCollision[] {
  const collisions: BlockingCollision[] = [];
  const mappingByOld = new Map(
    mappings.map((mapping) => [mapping.oldZoneId, mapping]),
  );

  for (const mapping of mappings) {
    const oldRestrictions = state.restrictions.filter(
      (restriction) => restriction.zoneAlerteId === mapping.oldZoneId,
    );
    const targetRestrictions = state.restrictions.filter(
      (restriction) => restriction.zoneAlerteId === mapping.newZoneId,
    );
    for (const oldRestriction of oldRestrictions) {
      const target = targetRestrictions.find(
        (restriction) =>
          restriction.arreteRestrictionId ===
          oldRestriction.arreteRestrictionId,
      );
      if (target) {
        collisions.push({
          type: 'RESTRICTION',
          oldZoneId: mapping.oldZoneId,
          newZoneId: mapping.newZoneId,
          conflictingId: target.id,
        });
      }
    }

    const oldCustomizations = state.customizations.filter(
      (customization) => customization.zoneAlerteId === mapping.oldZoneId,
    );
    const targetCustomizations = state.customizations.filter(
      (customization) => customization.zoneAlerteId === mapping.newZoneId,
    );
    for (const oldCustomization of oldCustomizations) {
      const target = targetCustomizations.find(
        (customization) =>
          customization.arreteCadreId === oldCustomization.arreteCadreId,
      );
      if (target) {
        collisions.push({
          type: 'CUSTOMIZATION',
          oldZoneId: mapping.oldZoneId,
          newZoneId: mapping.newZoneId,
          conflictingId: target.id,
        });
      }
    }

    const alias = state.aliases.find(
      (item) =>
        item.departmentId === mapping.departmentId &&
        item.zoneType === mapping.zoneType &&
        item.aliasType === 'cd_zas' &&
        item.aliasValue === mapping.oldCodeSandre,
    );
    if (
      alias &&
      alias.zoneAlerteId !== mapping.oldZoneId &&
      alias.zoneAlerteId !== mapping.newZoneId
    ) {
      collisions.push({
        type: 'ALIAS',
        oldZoneId: mapping.oldZoneId,
        newZoneId: mapping.newZoneId,
        conflictingId: mapping.oldCodeSandre,
      });
    }
  }

  const targetIds = new Set<number>();
  for (const mapping of mappings) {
    if (
      targetIds.has(mapping.newZoneId) ||
      mappingByOld.has(mapping.newZoneId)
    ) {
      throw new Error('Reconciliation mappings contain a chain or merge');
    }
    targetIds.add(mapping.newZoneId);
  }

  return collisions.sort((left, right) =>
    `${left.type}:${left.oldZoneId}:${left.conflictingId}`.localeCompare(
      `${right.type}:${right.oldZoneId}:${right.conflictingId}`,
    ),
  );
}

export function transformDatabaseState(
  state: ReconciliationDatabaseState,
  mappings: ReconciliationMapping[],
): ReconciliationDatabaseState {
  const mappingByOld = new Map(
    mappings.map((mapping) => [mapping.oldZoneId, mapping]),
  );
  const mapZoneId = (zoneId: number) =>
    mappingByOld.get(zoneId)?.newZoneId ?? zoneId;

  const aliasesByIdentity = new Map<string, DatabaseAliasState>();
  state.aliases.forEach((alias) => {
    const remappedAlias = {
      ...alias,
      zoneAlerteId: mapZoneId(alias.zoneAlerteId),
    };
    aliasesByIdentity.set(aliasIdentity(remappedAlias), remappedAlias);
  });
  mappings.forEach((mapping) => {
    const canonicalAlias: DatabaseAliasState = {
      departmentId: mapping.departmentId,
      zoneAlerteId: mapping.newZoneId,
      zoneType: mapping.zoneType,
      aliasType: 'cd_zas',
      aliasValue: mapping.oldCodeSandre,
      source: 'manual_reconciliation',
    };
    const identity = aliasIdentity(canonicalAlias);
    if (!aliasesByIdentity.has(identity)) {
      aliasesByIdentity.set(identity, canonicalAlias);
    }
  });

  return normalizeDatabaseState({
    zones: state.zones,
    arreteCadreLinks: deduplicate(
      state.arreteCadreLinks.map((link) => ({
        ...link,
        zoneAlerteId: mapZoneId(link.zoneAlerteId),
      })),
      (link) => `${link.arreteCadreId}:${link.zoneAlerteId}`,
    ),
    restrictions: state.restrictions.map((restriction) => ({
      ...restriction,
      zoneAlerteId: mapZoneId(restriction.zoneAlerteId),
    })),
    customizations: state.customizations.map((customization) => ({
      ...customization,
      zoneAlerteId: mapZoneId(customization.zoneAlerteId),
    })),
    aliases: [...aliasesByIdentity.values()],
  });
}

function aliasIdentity(alias: DatabaseAliasState): string {
  return `${alias.departmentId}:${alias.zoneType}:${alias.aliasType}:${alias.aliasValue}`;
}

export function earliestMappedRestrictionDate(
  state: ReconciliationDatabaseState,
  mappings: ReconciliationMapping[],
): string | null {
  const oldZoneIds = new Set(mappings.map((mapping) => mapping.oldZoneId));
  const dates = state.restrictions
    .filter((restriction) => oldZoneIds.has(restriction.zoneAlerteId))
    .map((restriction) => restriction.arreteRestrictionDateDebut)
    .filter((date): date is string => Boolean(date))
    .sort();
  return dates[0] ?? null;
}

export function normalizeDatabaseState(
  state: ReconciliationDatabaseState,
): ReconciliationDatabaseState {
  return {
    zones: [...state.zones].sort((a, b) => a.id - b.id),
    arreteCadreLinks: [...state.arreteCadreLinks].sort((a, b) =>
      `${a.arreteCadreId}:${a.zoneAlerteId}`.localeCompare(
        `${b.arreteCadreId}:${b.zoneAlerteId}`,
      ),
    ),
    restrictions: [...state.restrictions].sort((a, b) => a.id - b.id),
    customizations: state.customizations
      .map((customization) => ({
        ...customization,
        communeIds: [...customization.communeIds].sort((a, b) => a - b),
      }))
      .sort((a, b) => a.id - b.id),
    aliases: [...state.aliases].sort((a, b) =>
      `${a.departmentId}:${a.zoneType}:${a.aliasType}:${a.aliasValue}`.localeCompare(
        `${b.departmentId}:${b.zoneType}:${b.aliasType}:${b.aliasValue}`,
      ),
    ),
  };
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function reconciliationIdentity(
  results: ReconciliationResult[],
): unknown[] {
  return results.map((item) => ({
    status: item.status,
    reason: item.reason,
    departmentCode: item.departmentCode,
    oldZoneId: item.oldZoneId,
    oldCodeSandre: item.oldCodeSandre,
    newZoneId: item.newZoneId,
    newCodeSandre: item.newCodeSandre,
    genealogyPath: item.genealogyPath,
  }));
}

function createType2Graph(relations: SandreGenealogyRelation[]) {
  const edgeKeys = new Set<string>();
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();

  for (const relation of relations) {
    if (
      relation.modificationType !== '2' ||
      !relation.parentCode ||
      !relation.childCode
    ) {
      continue;
    }
    const edgeKey = `${relation.parentCode}\0${relation.childCode}`;
    if (edgeKeys.has(edgeKey)) {
      continue;
    }
    edgeKeys.add(edgeKey);
    addToSet(outgoing, relation.parentCode, relation.childCode);
    addToSet(incoming, relation.childCode, relation.parentCode);
    if (!outgoing.has(relation.childCode)) {
      outgoing.set(relation.childCode, new Set());
    }
    if (!incoming.has(relation.parentCode)) {
      incoming.set(relation.parentCode, new Set());
    }
  }

  return { outgoing, incoming };
}

function findTerminalSuccessor(
  sourceCode: string,
  graph: ReturnType<typeof createType2Graph>,
):
  | {
      status: 'SUCCESS';
      code: string;
      path: string[];
    }
  | {
      status: 'NONE' | 'AMBIGUOUS';
      reason: 'NO_TYPE_2_SUCCESSOR' | 'BRANCHED_GENEALOGY' | 'CYCLIC_GENEALOGY';
      path: string[];
    } {
  const directSuccessors = graph.outgoing.get(sourceCode);
  if (!directSuccessors || directSuccessors.size === 0) {
    return {
      status: 'NONE',
      reason: 'NO_TYPE_2_SUCCESSOR',
      path: [sourceCode],
    };
  }

  const component = collectComponent(sourceCode, graph);
  if (
    [...component].some(
      (code) =>
        (graph.outgoing.get(code)?.size ?? 0) > 1 ||
        (graph.incoming.get(code)?.size ?? 0) > 1,
    )
  ) {
    return {
      status: 'AMBIGUOUS',
      reason: 'BRANCHED_GENEALOGY',
      path: [sourceCode],
    };
  }

  const path: string[] = [];
  const visited = new Set<string>();
  let current = sourceCode;
  while (true) {
    if (visited.has(current)) {
      return {
        status: 'AMBIGUOUS',
        reason: 'CYCLIC_GENEALOGY',
        path: [...path, current],
      };
    }
    visited.add(current);
    path.push(current);
    const children = [...(graph.outgoing.get(current) ?? [])];
    if (children.length === 0) {
      return {
        status: 'SUCCESS',
        code: current,
        path,
      };
    }
    current = children[0];
  }
}

function collectComponent(
  sourceCode: string,
  graph: ReturnType<typeof createType2Graph>,
): Set<string> {
  const component = new Set<string>();
  const queue = [sourceCode];
  while (queue.length > 0) {
    const code = queue.shift();
    if (!code || component.has(code)) {
      continue;
    }
    component.add(code);
    queue.push(...(graph.outgoing.get(code) ?? []));
    queue.push(...(graph.incoming.get(code) ?? []));
  }
  return component;
}

function result(
  oldZone: LocalZoneRecord,
  references: ZoneReferenceCounts,
  status: ReconciliationStatus,
  reason: ReconciliationResult['reason'],
  oldCodeSandre: string | null = oldZone.codeSandre,
  newCodeSandre: string | null = null,
  genealogyPath: string[] = oldCodeSandre ? [oldCodeSandre] : [],
  newZoneId: number | null = null,
): ReconciliationResult {
  return {
    status,
    reason,
    departmentCode: oldZone.departmentCode,
    oldZoneId: oldZone.id,
    oldCodeSandre,
    newZoneId,
    newCodeSandre,
    genealogyPath,
    references,
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function collectOnlineResources(
  value: unknown,
  resources: Record<string, unknown>[],
): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectOnlineResources(item, resources));
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }
  const record = value as Record<string, unknown>;
  Object.entries(record).forEach(([key, item]) => {
    if (key.split(':').at(-1) === 'CI_OnlineResource') {
      const onlineResources = Array.isArray(item) ? item : [item];
      onlineResources.forEach((onlineResource) => {
        if (onlineResource && typeof onlineResource === 'object') {
          resources.push(onlineResource as Record<string, unknown>);
        }
      });
      return;
    }
    collectOnlineResources(item, resources);
  });
}

function nestedValue(value: Record<string, unknown>, path: string[]): unknown {
  return path.reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[key];
  }, value);
}

function xmlText(value: unknown): string | null {
  if (typeof value === 'string') {
    return nonEmptyString(value);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return nonEmptyString((value as Record<string, unknown>)['#text']);
  }
  return null;
}

function groupBy<T>(
  values: T[],
  key: (value: T) => string | null,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  values.forEach((value) => {
    const itemKey = key(value);
    if (itemKey === null) {
      return;
    }
    const items = grouped.get(itemKey) ?? [];
    items.push(value);
    grouped.set(itemKey, items);
  });
  return grouped;
}

function addToSet(
  values: Map<string, Set<string>>,
  key: string,
  value: string,
): void {
  const items = values.get(key) ?? new Set<string>();
  items.add(value);
  values.set(key, items);
}

function deduplicate<T>(values: T[], key: (value: T) => string): T[] {
  const deduplicated = new Map<string, T>();
  values.forEach((value) => deduplicated.set(key(value), value));
  return [...deduplicated.values()];
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sandreCode(value: unknown): string | null {
  const code = nonEmptyString(value);
  return code && code.toUpperCase() !== 'NULL' ? code : null;
}

function isSandreStatus(actual: string, expected: string): boolean {
  return (
    actual?.normalize('NFC').toLocaleLowerCase('fr') ===
    expected.normalize('NFC').toLocaleLowerCase('fr')
  );
}

function compareLocalZones(
  left: LocalZoneRecord,
  right: LocalZoneRecord,
): number {
  return (
    left.departmentCode.localeCompare(right.departmentCode) ||
    left.id - right.id
  );
}

function compareMappings(
  left: ReconciliationMapping,
  right: ReconciliationMapping,
): number {
  return (
    left.departmentCode.localeCompare(right.departmentCode) ||
    left.oldZoneId - right.oldZoneId
  );
}
