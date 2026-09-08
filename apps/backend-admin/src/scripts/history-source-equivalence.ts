import { createHash } from 'node:crypto';

export const EQUIVALENCE_FROM = '2026-07-11';
export const EQUIVALENCE_THROUGH = '2026-08-31';
export const EQUIVALENCE_SOURCE_POLICY =
  'statistic-inputs-clipped-intervals-ewkb-v1';

// Only statistical inputs are compared. An abrogation after the certified
// interval has no effect on its daily membership; resource priority does.
export const HISTORY_SOURCE_EQUIVALENCE_SQL = `
WITH orders AS MATERIALIZED (
  SELECT ar.*, d.code AS department,
    greatest(ar."dateDebut", DATE '${EQUIVALENCE_FROM}') AS effective_from,
    least(coalesce(ar."dateFin", DATE '${EQUIVALENCE_THROUGH}'), DATE '${EQUIVALENCE_THROUGH}') AS effective_through
  FROM arrete_restriction ar JOIN departement d ON d.id=ar."departementId"
  WHERE ar.statut IN ('publie','abroge') AND ar."dateDebut"<=DATE '${EQUIVALENCE_THROUGH}'
    AND (ar."dateFin" IS NULL OR ar."dateFin">=DATE '${EQUIVALENCE_FROM}')
), restrictions AS MATERIALIZED (
  SELECT r.* FROM restriction r JOIN orders ar ON ar.id=r."arreteRestrictionId"
), zones AS MATERIALIZED (
  SELECT DISTINCT "zoneAlerteId" AS id FROM restrictions WHERE "zoneAlerteId" IS NOT NULL
)
SELECT jsonb_build_object('section','orders','key',ar.id::text,'department',ar.department,
  'payload',jsonb_build_object('from',ar.effective_from::text,'through',ar.effective_through::text,
    'dateDebut',ar."dateDebut",'dateSignature',ar."dateSignature",'niveauGraviteSpecifiqueEap',ar."niveauGraviteSpecifiqueEap",
    'ressourceEapCommunique',ar."ressourceEapCommunique",'restrictions',coalesce((
      SELECT jsonb_agg(jsonb_build_object('id',r.id,'zoneAlerteId',r."zoneAlerteId",
        'arreteCadreId',r."arreteCadreId",'niveauGravite',r."niveauGravite",
        'nomGroupementAep',r."nomGroupementAep",'communes',coalesce((
          SELECT jsonb_agg(rc."communeId" ORDER BY rc."communeId") FROM restriction_commune rc
          WHERE rc."restrictionId"=r.id),'[]'::jsonb)) ORDER BY r.id)
      FROM restrictions r WHERE r."arreteRestrictionId"=ar.id),'[]'::jsonb))) AS value
FROM orders ar
UNION ALL
SELECT jsonb_build_object('section','zones','key',z.id::text,'department',d.code,
  'payload',jsonb_build_object('type',z.type,'nom',z.nom,'code',z.code,'disabled',z.disabled,
    'geom',encode(sha256(ST_AsEWKB(z.geom)),'hex'),'srid',ST_SRID(z.geom),
    'idSandre',z."idSandre",'ressourceInfluencee',z."ressourceInfluencee"))
FROM zone_alerte z JOIN zones ids ON ids.id=z.id JOIN departement d ON d.id=z."departementId"
UNION ALL
SELECT jsonb_build_object('section','frameworkZoneCommunes','key',link.id::text,'department',d.code,
  'payload',jsonb_build_object('zoneAlerteId',link."zoneAlerteId",'arreteCadreId',link."arreteCadreId",
    'communes',coalesce((SELECT jsonb_agg(ac."communeId" ORDER BY ac."communeId") FROM ac_za_communes ac
      WHERE ac."arreteCadreZoneAlerteCommunesId"=link.id),'[]'::jsonb)))
FROM arrete_cadre_zone_alerte_communes link JOIN zones ids ON ids.id=link."zoneAlerteId"
JOIN zone_alerte z ON z.id=link."zoneAlerteId" JOIN departement d ON d.id=z."departementId"
WHERE EXISTS (SELECT 1 FROM restrictions r WHERE r."zoneAlerteId"=link."zoneAlerteId"
  AND (r."arreteCadreId" IS NULL OR r."arreteCadreId"=link."arreteCadreId"))
UNION ALL
SELECT jsonb_build_object('section','communes','key',c.id::text,'department',d.code,
  'payload',jsonb_build_object('code',c.code,'population',c.population,'disabled',c.disabled,
    'geom',encode(sha256(ST_AsEWKB(c.geom)),'hex'),'srid',ST_SRID(c.geom)))
FROM commune c JOIN departement d ON d.id=c."departementId"
UNION ALL
SELECT jsonb_build_object('section','departments','key',d.id::text,'department',d.code,
  'payload',jsonb_build_object('code',d.code,'nom',d.nom,'regionId',d."regionId",
    'basins',coalesce((SELECT jsonb_agg(bd."bassinVersantId" ORDER BY bd."bassinVersantId")
      FROM bassin_versant_departement bd WHERE bd."departementId"=d.id),'[]'::jsonb),
    'geom',encode(sha256(ST_AsEWKB(d.geom)),'hex'),'srid',ST_SRID(d.geom))) FROM departement d
UNION ALL
SELECT jsonb_build_object('section','regions','key',r.id::text,'department',NULL,
  'payload',jsonb_build_object('code',r.code,'nom',r.nom,'domOn',r."domOn")) FROM region r
UNION ALL
SELECT jsonb_build_object('section','basins','key',b.id::text,'department',NULL,
  'payload',jsonb_build_object('code',b.code,'nom',b.nom)) FROM bassin_versant b
UNION ALL
SELECT jsonb_build_object('section','parameters','key',p.id::text,'department',d.code,
  'payload',jsonb_build_object('superpositionCommune',p."superpositionCommune",'disabled',p.disabled,
    'from',greatest(p."dateDebut",DATE '${EQUIVALENCE_FROM}'),
    'through',least(coalesce(p."dateFin",DATE '${EQUIVALENCE_THROUGH}'),DATE '${EQUIVALENCE_THROUGH}')))
FROM parametres p JOIN departement d ON d.id=p."departementId"
WHERE p."dateDebut"<=DATE '${EQUIVALENCE_THROUGH}'
  AND (p."dateFin" IS NULL OR p."dateFin">=DATE '${EQUIVALENCE_FROM}')
`;

export interface EquivalenceInput {
  section: string;
  key: string;
  department: string | null;
  payload: Record<string, unknown>;
}

export function canonicalEquivalenceJson(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => [key, canonical(child)]),
      );
    }
    return input;
  };
  return JSON.stringify(canonical(value));
}

export function equivalenceDigest(value: unknown): string {
  return createHash('sha256')
    .update(canonicalEquivalenceJson(value))
    .digest('hex');
}

export function sourceEquivalenceEvidence(rows: EquivalenceInput[]) {
  const sections: Record<string, { count: number; digest: string }> = {};
  const allowed = [
    'orders',
    'zones',
    'frameworkZoneCommunes',
    'communes',
    'departments',
    'regions',
    'basins',
    'parameters',
  ];
  const identities = new Set<string>();
  for (const row of rows) {
    if (
      !allowed.includes(row.section) ||
      !/^\d+$/.test(row.key) ||
      !row.payload ||
      typeof row.payload !== 'object'
    ) {
      throw new Error('Invalid source equivalence row');
    }
    const identity = `${row.section}/${row.key}`;
    if (identities.has(identity))
      throw new Error('Duplicate source equivalence row');
    identities.add(identity);
  }
  for (const section of allowed) {
    const values = rows
      .filter((row) => row.section === section)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    if (!values.length && section !== 'frameworkZoneCommunes')
      throw new Error(`Missing source section ${section}`);
    sections[section] = {
      count: values.length,
      digest: equivalenceDigest(values),
    };
  }
  if (sections.communes.count !== 34943 || sections.departments.count !== 101) {
    throw new Error('Incomplete national source coverage');
  }
  return {
    policy: EQUIVALENCE_SOURCE_POLICY,
    sections,
    digest: equivalenceDigest(sections),
  };
}
