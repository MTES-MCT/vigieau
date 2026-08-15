import { fingerprint } from './sandre-zone-reconciliation';

export interface SandreSyncApprovalQueryExecutor {
  query(query: string, parameters?: any[]): Promise<any[]>;
}

export interface SandreApprovedRestrictionEvidence {
  restrictionId: number;
  arreteRestrictionId: number;
  parentStatus: string;
  parentDateDebut: string | null;
  payloadFingerprint: string;
  computedIds: number[];
  historicIds: number[];
}

export interface SandreApprovedReferenceEvidence {
  sourceZoneId: number;
  lifecycle: 'pre_apply' | 'post_apply' | 'empty';
  sourceOperationalEmpty: boolean;
  arreteCadreLinks: Array<{ arreteCadreId: number; parentStatus: string }>;
  restrictions: SandreApprovedRestrictionEvidence[];
  customizationCount: number;
  aliasCount: number;
  targetCollisionFingerprint: string;
  targetStateFingerprint: string;
  targetState: SandreApprovedTargetOperationalState[];
  fingerprint: string;
}

interface RestrictionPayloadRow extends SandreApprovedRestrictionEvidence {
  zoneAlerteId: number;
  payload: Record<string, unknown>;
  communeIds: number[];
  usagePayloads: Record<string, unknown>[];
}

export async function lockSandreApprovedSyncReferences(
  executor: SandreSyncApprovalQueryExecutor,
  sourceZoneIds: number[],
  targetZoneIds: number[],
): Promise<void> {
  const zoneIds = [...new Set([...sourceZoneIds, ...targetZoneIds])].sort(
    (left, right) => left - right,
  );
  await executor.query(
    `
      SELECT id
      FROM zone_alerte
      WHERE id = ANY($1::integer[])
      ORDER BY id
      FOR UPDATE
    `,
    [zoneIds],
  );
  await executor.query(
    `
      SELECT parent.id
      FROM arrete_cadre parent
      WHERE parent.id IN (
        SELECT link."arreteCadreId"
        FROM arrete_cadre_zone_alerte link
        WHERE link."zoneAlerteId" = ANY($1::integer[])
        UNION
        SELECT link."arreteCadreId"
        FROM arrete_cadre_zone_alerte_communes link
        WHERE link."zoneAlerteId" = ANY($1::integer[])
      )
      ORDER BY parent.id
      FOR SHARE OF parent
    `,
    [zoneIds],
  );
  await executor.query(
    `
      SELECT parent.id
      FROM arrete_restriction parent
      WHERE parent.id IN (
        SELECT restriction."arreteRestrictionId"
        FROM restriction
        WHERE restriction."zoneAlerteId" = ANY($1::integer[])
      )
      ORDER BY parent.id
      FOR SHARE OF parent
    `,
    [zoneIds],
  );
  for (const { table, orderBy, where } of [
    {
      table: 'arrete_cadre_zone_alerte',
      orderBy: '"arreteCadreId", "zoneAlerteId"',
      where: '"zoneAlerteId" = ANY($1::integer[])',
    },
    {
      table: 'restriction',
      orderBy: 'id',
      where: '"zoneAlerteId" = ANY($1::integer[])',
    },
    {
      table: 'arrete_cadre_zone_alerte_communes',
      orderBy: 'id',
      where: '"zoneAlerteId" = ANY($1::integer[])',
    },
    {
      table: 'sandre_zone_alias',
      orderBy: 'id',
      where: '"zoneAlerteId" = ANY($1::integer[])',
    },
  ]) {
    await executor.query(
      `SELECT * FROM ${table} WHERE ${where} ORDER BY ${orderBy} FOR UPDATE`,
      [zoneIds],
    );
  }
  await executor.query(
    `
      SELECT usage.*
      FROM usage
      JOIN restriction ON restriction.id = usage."restrictionId"
      WHERE restriction."zoneAlerteId" = ANY($1::integer[])
      ORDER BY usage.id
      FOR UPDATE OF usage
    `,
    [zoneIds],
  );
  await executor.query(
    `
      SELECT link.*
      FROM restriction_commune link
      JOIN restriction ON restriction.id = link."restrictionId"
      WHERE restriction."zoneAlerteId" = ANY($1::integer[])
      ORDER BY link."restrictionId", link."communeId"
      FOR UPDATE OF link
    `,
    [zoneIds],
  );
  for (const table of [
    'zone_alerte_computed',
    'zone_alerte_computed_historic',
  ]) {
    await executor.query(
      `
        SELECT computed.*
        FROM ${table} computed
        JOIN restriction ON restriction.id = computed."restrictionId"
        WHERE restriction."zoneAlerteId" = ANY($1::integer[])
        ORDER BY computed.id
        FOR SHARE OF computed
      `,
      [zoneIds],
    );
  }
}

export async function loadSandreApprovedReferenceEvidence(
  executor: SandreSyncApprovalQueryExecutor,
  sourceZoneId: number,
  targetZoneIds: number[],
  lineage?: SandreApprovedReferenceEvidence,
): Promise<SandreApprovedReferenceEvidence> {
  if (lineage && lineage.sourceZoneId !== sourceZoneId) {
    throw new Error('Approved Sandre reference lineage source changed');
  }
  const currentArreteCadreLinks = (
    await executor.query(
      `
        SELECT
          link."arreteCadreId",
          parent.statut AS "parentStatus"
        FROM arrete_cadre_zone_alerte link
        JOIN arrete_cadre parent ON parent.id = link."arreteCadreId"
        WHERE link."zoneAlerteId" = $1
          AND parent.statut IN ('a_venir', 'publie')
        ORDER BY link."arreteCadreId"
      `,
      [sourceZoneId],
    )
  ).map((row) => ({
    arreteCadreId: Number(row.arreteCadreId),
    parentStatus: String(row.parentStatus),
  }));
  const currentRestrictions = await loadRestrictionPayloadRows(executor, [
    sourceZoneId,
  ]);
  const [{ customizationCount = 0, aliasCount = 0 } = {}] =
    await executor.query(
      `
        SELECT
          (SELECT count(*)::integer
           FROM arrete_cadre_zone_alerte_communes customization
           JOIN arrete_cadre parent
             ON parent.id = customization."arreteCadreId"
           WHERE customization."zoneAlerteId" = $1
             AND parent.statut IN ('a_venir', 'publie'))
            AS "customizationCount",
          (SELECT count(*)::integer
           FROM sandre_zone_alias
           WHERE "zoneAlerteId" = $1) AS "aliasCount"
      `,
      [sourceZoneId],
    );
  const parentIds = currentRestrictions.map((row) => row.arreteRestrictionId);
  const targetCollisions = (
    await loadRestrictionPayloadRows(executor, targetZoneIds)
  )
    .filter((row) => parentIds.includes(row.arreteRestrictionId))
    .map((row) => ({
      zoneAlerteId: row.zoneAlerteId,
      arreteRestrictionId: row.arreteRestrictionId,
      payloadFingerprint: row.payloadFingerprint,
    }))
    .sort(compareTargetRestriction);
  const targetState = await loadTargetOperationalState(executor, targetZoneIds);
  const sourceHasReferences =
    currentArreteCadreLinks.length > 0 ||
    currentRestrictions.length > 0 ||
    Number(customizationCount) > 0 ||
    Number(aliasCount) > 0;
  const targetHasReferences = targetState.some(
    (target) =>
      target.arreteCadreIds.length > 0 ||
      target.restrictions.length > 0 ||
      target.customizationCount > 0 ||
      target.aliasCount > 0,
  );
  if (lineage?.lifecycle === 'post_apply' && sourceHasReferences) {
    throw new Error('Approved Sandre source regained operational references');
  }
  if (!sourceHasReferences && targetHasReferences && !lineage) {
    throw new Error('Approved Sandre post-apply state has no lineage');
  }
  const lifecycle: SandreApprovedReferenceEvidence['lifecycle'] =
    sourceHasReferences ? 'pre_apply' : lineage ? 'post_apply' : 'empty';
  const arreteCadreLinks = sourceHasReferences
    ? currentArreteCadreLinks
    : (lineage?.arreteCadreLinks ?? []);
  const restrictions = sourceHasReferences
    ? currentRestrictions.map(restrictionEvidence)
    : (lineage?.restrictions ?? []);
  if (lifecycle === 'post_apply') {
    await assertPostApplyLineage(executor, lineage!, targetZoneIds);
  }
  const evidenceWithoutFingerprint = {
    sourceZoneId,
    lifecycle,
    sourceOperationalEmpty: !sourceHasReferences,
    arreteCadreLinks,
    restrictions,
    customizationCount: Number(customizationCount),
    aliasCount: Number(aliasCount),
    targetCollisionFingerprint: fingerprint(targetCollisions),
    targetStateFingerprint: fingerprint(targetState),
    targetState,
  };
  return {
    ...evidenceWithoutFingerprint,
    fingerprint: fingerprint(evidenceWithoutFingerprint),
  };
}

export function parseSandreApprovedReferenceEvidence(
  value: unknown,
): SandreApprovedReferenceEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid audited Sandre reference evidence');
  }
  const evidence = value as SandreApprovedReferenceEvidence;
  if (
    !Number.isInteger(evidence.sourceZoneId) ||
    evidence.sourceZoneId <= 0 ||
    !['pre_apply', 'post_apply', 'empty'].includes(evidence.lifecycle) ||
    typeof evidence.sourceOperationalEmpty !== 'boolean' ||
    evidence.sourceOperationalEmpty !== (evidence.lifecycle !== 'pre_apply') ||
    !Array.isArray(evidence.arreteCadreLinks) ||
    !Array.isArray(evidence.restrictions) ||
    !Number.isInteger(evidence.customizationCount) ||
    !Number.isInteger(evidence.aliasCount) ||
    !/^[a-f0-9]{64}$/.test(evidence.targetCollisionFingerprint) ||
    !/^[a-f0-9]{64}$/.test(evidence.targetStateFingerprint) ||
    !Array.isArray(evidence.targetState) ||
    !/^[a-f0-9]{64}$/.test(evidence.fingerprint) ||
    evidence.arreteCadreLinks.some(
      (link) =>
        !Number.isInteger(link.arreteCadreId) ||
        typeof link.parentStatus !== 'string',
    ) ||
    evidence.restrictions.some(
      (restriction) =>
        !Number.isInteger(restriction.restrictionId) ||
        !Number.isInteger(restriction.arreteRestrictionId) ||
        typeof restriction.parentStatus !== 'string' ||
        (restriction.parentDateDebut !== null &&
          typeof restriction.parentDateDebut !== 'string') ||
        !/^[a-f0-9]{64}$/.test(restriction.payloadFingerprint) ||
        !Array.isArray(restriction.computedIds) ||
        !Array.isArray(restriction.historicIds),
    ) ||
    evidence.targetState.some(
      (target) =>
        !Number.isInteger(target.targetIndex) ||
        target.targetIndex < 0 ||
        !Array.isArray(target.arreteCadreIds) ||
        !Array.isArray(target.restrictions) ||
        !Number.isInteger(target.customizationCount) ||
        !Number.isInteger(target.aliasCount),
    ) ||
    fingerprint(evidence.targetState) !== evidence.targetStateFingerprint
  ) {
    throw new Error('Invalid audited Sandre reference evidence');
  }
  const unsigned = {
    sourceZoneId: evidence.sourceZoneId,
    lifecycle: evidence.lifecycle,
    sourceOperationalEmpty: evidence.sourceOperationalEmpty,
    arreteCadreLinks: evidence.arreteCadreLinks,
    restrictions: evidence.restrictions,
    customizationCount: evidence.customizationCount,
    aliasCount: evidence.aliasCount,
    targetCollisionFingerprint: evidence.targetCollisionFingerprint,
    targetStateFingerprint: evidence.targetStateFingerprint,
    targetState: evidence.targetState,
  };
  if (fingerprint(unsigned) !== evidence.fingerprint) {
    throw new Error('Audited Sandre reference evidence fingerprint changed');
  }
  return evidence;
}

export async function assertSandreApprovedOneToOneApplied(
  executor: SandreSyncApprovalQueryExecutor,
  expected: SandreApprovedReferenceEvidence,
  targetZoneId: number,
): Promise<void> {
  if (expected.customizationCount !== 0 || expected.aliasCount !== 0) {
    throw new Error(
      `Approved Sandre 1:1 ${expected.sourceZoneId} has unsupported customizations or aliases`,
    );
  }
  const source = await loadSandreApprovedReferenceEvidence(
    executor,
    expected.sourceZoneId,
    [targetZoneId],
    expected,
  );
  if (!source.sourceOperationalEmpty) {
    throw new Error('Approved Sandre 1:1 source still has references');
  }
  const targetLinks = (
    await executor.query(
      `
        SELECT link."arreteCadreId"
        FROM arrete_cadre_zone_alerte link
        JOIN arrete_cadre parent ON parent.id = link."arreteCadreId"
        WHERE link."zoneAlerteId" = $1
          AND parent.statut IN ('a_venir', 'publie')
        ORDER BY link."arreteCadreId"
      `,
      [targetZoneId],
    )
  ).map((row) => Number(row.arreteCadreId));
  if (
    fingerprint(targetLinks) !==
    fingerprint(expected.arreteCadreLinks.map((link) => link.arreteCadreId))
  ) {
    throw new Error(
      'Approved Sandre 1:1 target framework links are incomplete',
    );
  }
  const targetRestrictions = await loadRestrictionPayloadRows(executor, [
    targetZoneId,
  ]);
  if (targetRestrictions.length !== expected.restrictions.length) {
    throw new Error('Approved Sandre 1:1 target restrictions changed');
  }
  for (const restriction of expected.restrictions) {
    const matches = targetRestrictions.filter(
      (row) => row.arreteRestrictionId === restriction.arreteRestrictionId,
    );
    if (
      matches.length !== 1 ||
      matches[0].restrictionId !== restriction.restrictionId ||
      matches[0].payloadFingerprint !== restriction.payloadFingerprint ||
      fingerprint(matches[0].computedIds) !==
        fingerprint(restriction.computedIds) ||
      fingerprint(matches[0].historicIds) !==
        fingerprint(restriction.historicIds)
    ) {
      throw new Error('Approved Sandre 1:1 target restriction is incomplete');
    }
  }
  const [targetState] = await loadTargetOperationalState(executor, [
    targetZoneId,
  ]);
  if (!targetState || targetState.customizationCount !== 0) {
    throw new Error('Approved Sandre 1:1 target customizations changed');
  }
}

export async function applySandreApprovedPartitionReferences(
  executor: SandreSyncApprovalQueryExecutor,
  expected: SandreApprovedReferenceEvidence,
  targets: Array<{ codeSandre: string; zoneAlerteId: number }>,
  historicalRecomputeFrom: string,
): Promise<{ applied: boolean }> {
  if (targets.length < 2) {
    throw new Error('Approved Sandre partition requires at least two targets');
  }
  const sortedTargets = [...targets].sort((left, right) =>
    left.codeSandre.localeCompare(right.codeSandre),
  );
  if (expected.customizationCount !== 0 || expected.aliasCount !== 0) {
    throw new Error(
      `Approved Sandre partition ${expected.sourceZoneId} has unsupported customizations or aliases`,
    );
  }
  const current = await loadSandreApprovedReferenceEvidence(
    executor,
    expected.sourceZoneId,
    sortedTargets.map((target) => target.zoneAlerteId),
    expected,
  );
  if (current.lifecycle === 'post_apply') {
    if (
      expected.lifecycle === 'post_apply' &&
      current.fingerprint !== expected.fingerprint
    ) {
      throw new Error(
        `Approved Sandre partition post-apply state changed for zone ${expected.sourceZoneId}`,
      );
    }
    return { applied: false };
  }
  if (current.fingerprint === expected.fingerprint) {
    if (expected.lifecycle !== 'pre_apply') {
      return { applied: false };
    }
  }
  if (current.fingerprint !== expected.fingerprint) {
    if (expected.lifecycle !== 'pre_apply') {
      throw new Error(
        `Approved Sandre partition post-apply state changed for zone ${expected.sourceZoneId}`,
      );
    }
    throw new Error(
      `Approved Sandre partition references changed for zone ${expected.sourceZoneId}`,
    );
  }

  await markSandreApprovedHistoricalRecomputeDebt(
    executor,
    historicalRecomputeFrom,
  );
  await assertExactTargetRestrictionCollisions(
    executor,
    expected,
    sortedTargets,
  );
  await executor.query(
    `
      INSERT INTO arrete_cadre_zone_alerte (
        "arreteCadreId", "zoneAlerteId"
      )
      SELECT source."arreteCadreId", target.id
      FROM arrete_cadre_zone_alerte source
      JOIN arrete_cadre parent ON parent.id = source."arreteCadreId"
      CROSS JOIN unnest($2::integer[]) AS target(id)
      WHERE source."zoneAlerteId" = $1
        AND parent.statut IN ('a_venir', 'publie')
      ON CONFLICT DO NOTHING
    `,
    [expected.sourceZoneId, sortedTargets.map((target) => target.zoneAlerteId)],
  );

  const sourceRows = await loadRestrictionPayloadRows(executor, [
    expected.sourceZoneId,
  ]);
  const primaryTarget = sortedTargets[0];
  for (const source of sourceRows) {
    for (const target of sortedTargets.slice(1)) {
      const existing = await loadRestrictionPayloadRows(executor, [
        target.zoneAlerteId,
      ]);
      const collisions = existing.filter(
        (row) => row.arreteRestrictionId === source.arreteRestrictionId,
      );
      if (collisions.length === 1) {
        if (collisions[0].payloadFingerprint !== source.payloadFingerprint) {
          throw new Error(
            `Approved Sandre partition restriction collision differs on target ${target.codeSandre}`,
          );
        }
        continue;
      }
      if (collisions.length > 1) {
        throw new Error(
          `Approved Sandre partition has duplicate restriction collisions on target ${target.codeSandre}`,
        );
      }
      await cloneRestriction(
        executor,
        source.restrictionId,
        target.zoneAlerteId,
      );
    }
    const primaryCollision = (
      await loadRestrictionPayloadRows(executor, [primaryTarget.zoneAlerteId])
    ).filter((row) => row.arreteRestrictionId === source.arreteRestrictionId);
    if (primaryCollision.length > 0) {
      throw new Error(
        `Approved Sandre partition cannot preserve restriction ${source.restrictionId} on primary target`,
      );
    }
    await executor.query(
      `UPDATE restriction SET "zoneAlerteId" = $2 WHERE id = $1`,
      [source.restrictionId, primaryTarget.zoneAlerteId],
    );
  }
  await executor.query(
    `
      DELETE FROM arrete_cadre_zone_alerte link
      USING arrete_cadre parent
      WHERE link."arreteCadreId" = parent.id
        AND link."zoneAlerteId" = $1
        AND parent.statut IN ('a_venir', 'publie')
    `,
    [expected.sourceZoneId],
  );

  await assertSandreApprovedPartitionApplied(executor, expected, sortedTargets);
  return { applied: true };
}

export async function markSandreApprovedHistoricalRecomputeDebt(
  executor: SandreSyncApprovalQueryExecutor,
  date: string | null,
): Promise<void> {
  if (!date) {
    return;
  }
  const [lock] = await executor.query(
    `SELECT pg_try_advisory_xact_lock(hashtext('vigieau'), hashtext('zone-compute-historic')) AS locked`,
  );
  if (lock?.locked !== true) {
    throw new Error('Historic zone compute is running during Sandre split');
  }
  const [result] = await executor.query(
    `
      WITH changed AS (
        UPDATE config
        SET
          "computeMapDate" = CASE
            WHEN "computeMapDate" IS NULL OR "computeMapDate" > $1::date
            THEN $1::date ELSE "computeMapDate" END,
          "computeStatsDate" = CASE
            WHEN "computeStatsDate" IS NULL OR "computeStatsDate" > $1::date
            THEN $1::date ELSE "computeStatsDate" END,
          "computeMapGeneration" = "computeMapGeneration" + CASE
            WHEN "computeMapDate" IS NULL OR "computeMapDate" > $1::date
            THEN 1 ELSE 0 END,
          "computeStatsGeneration" = "computeStatsGeneration" + CASE
            WHEN "computeStatsDate" IS NULL OR "computeStatsDate" > $1::date
            THEN 1 ELSE 0 END,
          "historicComputeEpoch" = "historicComputeEpoch" + 1
        WHERE id = 1
          AND (
            "computeMapDate" IS NULL OR "computeMapDate" > $1::date
            OR "computeStatsDate" IS NULL OR "computeStatsDate" > $1::date
          )
        RETURNING id
      )
      SELECT count(*)::integer AS count FROM changed
    `,
    [date],
  );
  if (!result || ![0, 1].includes(Number(result.count))) {
    throw new Error('Invalid historic cursor state');
  }
}

export async function assertSandreApprovedPartitionApplied(
  executor: SandreSyncApprovalQueryExecutor,
  expected: SandreApprovedReferenceEvidence,
  targets: Array<{ codeSandre: string; zoneAlerteId: number }>,
): Promise<void> {
  const [primary, ...clones] = targets;
  const source = await loadSandreApprovedReferenceEvidence(
    executor,
    expected.sourceZoneId,
    targets.map((target) => target.zoneAlerteId),
    expected,
  );
  if (!source.sourceOperationalEmpty) {
    throw new Error('Approved Sandre partition source still has references');
  }
  for (const target of targets) {
    const [state] = await loadTargetOperationalState(executor, [
      target.zoneAlerteId,
    ]);
    const links = state?.arreteCadreIds ?? [];
    if (
      !state ||
      state.customizationCount !== 0 ||
      state.aliasCount !== 0 ||
      fingerprint(links) !==
        fingerprint(expected.arreteCadreLinks.map((link) => link.arreteCadreId))
    ) {
      throw new Error(
        `Approved Sandre partition framework links are incomplete on ${target.codeSandre}`,
      );
    }
  }
  const primaryRows = await loadRestrictionPayloadRows(executor, [
    primary.zoneAlerteId,
  ]);
  if (primaryRows.length !== expected.restrictions.length) {
    throw new Error('Approved Sandre partition primary restrictions changed');
  }
  for (const restriction of expected.restrictions) {
    const primaryMatches = primaryRows.filter(
      (row) => row.arreteRestrictionId === restriction.arreteRestrictionId,
    );
    if (
      primaryMatches.length !== 1 ||
      primaryMatches[0].restrictionId !== restriction.restrictionId ||
      primaryMatches[0].payloadFingerprint !== restriction.payloadFingerprint ||
      fingerprint(primaryMatches[0].computedIds) !==
        fingerprint(restriction.computedIds) ||
      fingerprint(primaryMatches[0].historicIds) !==
        fingerprint(restriction.historicIds)
    ) {
      throw new Error(
        `Approved Sandre partition primary restriction ${restriction.restrictionId} is incomplete`,
      );
    }
    for (const target of clones) {
      const cloneRows = await loadRestrictionPayloadRows(executor, [
        target.zoneAlerteId,
      ]);
      if (cloneRows.length !== expected.restrictions.length) {
        throw new Error(
          `Approved Sandre partition clone restrictions changed on ${target.codeSandre}`,
        );
      }
      const matches = cloneRows.filter(
        (row) => row.arreteRestrictionId === restriction.arreteRestrictionId,
      );
      if (
        matches.length !== 1 ||
        matches[0].parentStatus !== restriction.parentStatus ||
        matches[0].payloadFingerprint !== restriction.payloadFingerprint ||
        matches[0].computedIds.length !== 0 ||
        matches[0].historicIds.length !== 0
      ) {
        throw new Error(
          `Approved Sandre partition clone is incomplete on ${target.codeSandre}`,
        );
      }
    }
  }
}

async function assertExactTargetRestrictionCollisions(
  executor: SandreSyncApprovalQueryExecutor,
  expected: SandreApprovedReferenceEvidence,
  targets: Array<{ codeSandre: string; zoneAlerteId: number }>,
): Promise<void> {
  const expectedByParent = new Map(
    expected.restrictions.map((restriction) => [
      restriction.arreteRestrictionId,
      restriction,
    ]),
  );
  const targetRows = await loadRestrictionPayloadRows(
    executor,
    targets.map((target) => target.zoneAlerteId),
  );
  for (const target of targetRows) {
    const source = expectedByParent.get(target.arreteRestrictionId);
    if (
      source &&
      (source.parentStatus !== target.parentStatus ||
        source.payloadFingerprint !== target.payloadFingerprint ||
        target.computedIds.length !== 0 ||
        target.historicIds.length !== 0)
    ) {
      throw new Error(
        `Approved Sandre partition target restriction differs for parent ${target.arreteRestrictionId}`,
      );
    }
  }
}

async function cloneRestriction(
  executor: SandreSyncApprovalQueryExecutor,
  sourceRestrictionId: number,
  targetZoneId: number,
): Promise<void> {
  const inserted = await executor.query(
    `
      INSERT INTO restriction
      SELECT (
        jsonb_populate_record(
          NULL::restriction,
          (to_jsonb(source) - ARRAY['id', 'zoneAlerteId']::text[])
          || jsonb_build_object(
            'id', nextval(pg_get_serial_sequence('restriction', 'id')),
            'zoneAlerteId', $2::integer
          )
        )
      ).*
      FROM restriction source
      WHERE source.id = $1
      RETURNING id
    `,
    [sourceRestrictionId, targetZoneId],
  );
  if (inserted.length !== 1) {
    throw new Error(
      `Approved Sandre restriction ${sourceRestrictionId} vanished`,
    );
  }
  const cloneId = Number(inserted[0].id);
  await executor.query(
    `
      INSERT INTO restriction_commune ("restrictionId", "communeId")
      SELECT $2, "communeId"
      FROM restriction_commune
      WHERE "restrictionId" = $1
      ORDER BY "communeId"
    `,
    [sourceRestrictionId, cloneId],
  );
  await executor.query(
    `
      INSERT INTO usage
      SELECT (
        jsonb_populate_record(
          NULL::usage,
          (to_jsonb(source) - ARRAY['id', 'restrictionId']::text[])
          || jsonb_build_object(
            'id', nextval(pg_get_serial_sequence('usage', 'id')),
            'restrictionId', $2::integer
          )
        )
      ).*
      FROM usage source
      WHERE source."restrictionId" = $1
      ORDER BY source.id
    `,
    [sourceRestrictionId, cloneId],
  );
}

export interface SandreApprovedTargetOperationalState {
  targetIndex: number;
  arreteCadreIds: number[];
  restrictions: SandreApprovedRestrictionEvidence[];
  customizationCount: number;
  aliasCount: number;
}

async function loadTargetOperationalState(
  executor: SandreSyncApprovalQueryExecutor,
  targetZoneIds: number[],
): Promise<SandreApprovedTargetOperationalState[]> {
  const restrictionRows = await loadRestrictionPayloadRows(
    executor,
    targetZoneIds,
  );
  const links = await executor.query(
    `
      SELECT
        target.id AS "zoneAlerteId",
        COALESCE(array_agg(link."arreteCadreId" ORDER BY link."arreteCadreId")
          FILTER (WHERE parent.id IS NOT NULL), '{}') AS "arreteCadreIds",
        (SELECT count(*)::integer
         FROM arrete_cadre_zone_alerte_communes customization
         JOIN arrete_cadre parent
           ON parent.id = customization."arreteCadreId"
         WHERE customization."zoneAlerteId" = target.id
           AND parent.statut IN ('a_venir', 'publie')) AS "customizationCount",
        (SELECT count(*)::integer
         FROM sandre_zone_alias alias
         WHERE alias."zoneAlerteId" = target.id) AS "aliasCount"
      FROM unnest($1::integer[]) WITH ORDINALITY target(id, position)
      LEFT JOIN arrete_cadre_zone_alerte link
        ON link."zoneAlerteId" = target.id
      LEFT JOIN arrete_cadre parent
        ON parent.id = link."arreteCadreId"
        AND parent.statut IN ('a_venir', 'publie')
      GROUP BY target.id, target.position
      ORDER BY target.position
    `,
    [targetZoneIds],
  );
  return links.map((row, targetIndex) => ({
    targetIndex,
    arreteCadreIds: (row.arreteCadreIds ?? []).map(Number),
    restrictions: restrictionRows
      .filter(
        (restriction) => restriction.zoneAlerteId === Number(row.zoneAlerteId),
      )
      .map(restrictionEvidence),
    customizationCount: Number(row.customizationCount),
    aliasCount: Number(row.aliasCount),
  }));
}

async function assertPostApplyLineage(
  executor: SandreSyncApprovalQueryExecutor,
  lineage: SandreApprovedReferenceEvidence,
  targetZoneIds: number[],
): Promise<void> {
  if (targetZoneIds.length === 0) {
    throw new Error('Approved Sandre post-apply state has no target');
  }
  const allRestrictions = await loadRestrictionPayloadRows(
    executor,
    targetZoneIds,
    false,
  );
  const allLinks = await executor.query(
    `
      SELECT "zoneAlerteId", "arreteCadreId"
      FROM arrete_cadre_zone_alerte
      WHERE "zoneAlerteId" = ANY($1::integer[])
      ORDER BY "zoneAlerteId", "arreteCadreId"
    `,
    [targetZoneIds],
  );
  for (const [targetIndex, targetZoneId] of targetZoneIds.entries()) {
    const requiredState =
      lineage.lifecycle === 'post_apply'
        ? lineage.targetState.find(
            (target) => target.targetIndex === targetIndex,
          )
        : null;
    const requiredLinks = requiredState
      ? requiredState.arreteCadreIds
      : lineage.arreteCadreLinks.map((link) => link.arreteCadreId);
    const actualLinks = new Set(
      allLinks
        .filter((link) => Number(link.zoneAlerteId) === targetZoneId)
        .map((link) => Number(link.arreteCadreId)),
    );
    if (requiredLinks.some((id) => !actualLinks.has(id))) {
      throw new Error('Approved Sandre framework lineage is incomplete');
    }
    const requiredRestrictions = requiredState
      ? requiredState.restrictions
      : lineage.restrictions;
    for (const required of requiredRestrictions) {
      const parentRows = allRestrictions.filter(
        (row) =>
          row.zoneAlerteId === targetZoneId &&
          row.arreteRestrictionId === required.arreteRestrictionId,
      );
      const matches = parentRows.filter(
        (row) =>
          (requiredState
            ? row.restrictionId === required.restrictionId
            : targetIndex === 0
              ? row.restrictionId === required.restrictionId
              : row.arreteRestrictionId === required.arreteRestrictionId) &&
          row.payloadFingerprint === required.payloadFingerprint,
      );
      if (parentRows.length !== 1 || matches.length !== 1) {
        throw new Error('Approved Sandre restriction lineage is incomplete');
      }
    }
  }
}

async function loadRestrictionPayloadRows(
  executor: SandreSyncApprovalQueryExecutor,
  zoneIds: number[],
  operationalOnly = true,
): Promise<RestrictionPayloadRow[]> {
  if (zoneIds.length === 0) {
    return [];
  }
  const rows = await executor.query(
    `
      SELECT
        restriction.id AS "restrictionId",
        restriction."zoneAlerteId",
        restriction."arreteRestrictionId",
        parent.statut AS "parentStatus",
        parent."dateDebut"::text AS "parentDateDebut",
        to_jsonb(restriction) - ARRAY['id', 'zoneAlerteId']::text[] AS payload,
        ARRAY(
          SELECT link."communeId"
          FROM restriction_commune link
          WHERE link."restrictionId" = restriction.id
          ORDER BY link."communeId"
        ) AS "communeIds",
        COALESCE((
          SELECT jsonb_agg(
            to_jsonb(usage) - ARRAY['id', 'restrictionId']::text[]
            ORDER BY usage.id
          )
          FROM usage
          WHERE usage."restrictionId" = restriction.id
        ), '[]'::jsonb) AS "usagePayloads",
        ARRAY(
          SELECT computed.id
          FROM zone_alerte_computed computed
          WHERE computed."restrictionId" = restriction.id
          ORDER BY computed.id
        ) AS "computedIds",
        ARRAY(
          SELECT historic.id
          FROM zone_alerte_computed_historic historic
          WHERE historic."restrictionId" = restriction.id
          ORDER BY historic.id
        ) AS "historicIds"
      FROM restriction
      JOIN arrete_restriction parent
        ON parent.id = restriction."arreteRestrictionId"
      WHERE restriction."zoneAlerteId" = ANY($1::integer[])
        AND ($2::boolean = false OR parent.statut IN ('a_venir', 'publie'))
      ORDER BY restriction."zoneAlerteId", restriction.id
    `,
    [[...zoneIds].sort((left, right) => left - right), operationalOnly],
  );
  return rows.map((row) => {
    const payload = row.payload as Record<string, unknown>;
    const communeIds = (row.communeIds ?? []).map(Number);
    const usagePayloads = (row.usagePayloads ?? []) as Record<
      string,
      unknown
    >[];
    return {
      restrictionId: Number(row.restrictionId),
      zoneAlerteId: Number(row.zoneAlerteId),
      arreteRestrictionId: Number(row.arreteRestrictionId),
      parentStatus: String(row.parentStatus),
      parentDateDebut: row.parentDateDebut ?? null,
      payload,
      communeIds,
      usagePayloads,
      payloadFingerprint: fingerprint({ payload, communeIds, usagePayloads }),
      computedIds: (row.computedIds ?? []).map(Number),
      historicIds: (row.historicIds ?? []).map(Number),
    };
  });
}

function restrictionEvidence(
  row: RestrictionPayloadRow,
): SandreApprovedRestrictionEvidence {
  return {
    restrictionId: row.restrictionId,
    arreteRestrictionId: row.arreteRestrictionId,
    parentStatus: row.parentStatus,
    parentDateDebut: row.parentDateDebut,
    payloadFingerprint: row.payloadFingerprint,
    computedIds: row.computedIds,
    historicIds: row.historicIds,
  };
}

function compareTargetRestriction(
  left: {
    zoneAlerteId: number;
    arreteRestrictionId: number;
    payloadFingerprint: string;
  },
  right: {
    zoneAlerteId: number;
    arreteRestrictionId: number;
    payloadFingerprint: string;
  },
): number {
  return `${left.zoneAlerteId}:${left.arreteRestrictionId}:${left.payloadFingerprint}`.localeCompare(
    `${right.zoneAlerteId}:${right.arreteRestrictionId}:${right.payloadFingerprint}`,
  );
}
