import { createHash } from 'crypto';
import { XMLParser } from 'fast-xml-parser';

export const SANDRE_PAGE_SIZE = 1000;
export const SANDRE_MAX_PAGES_PER_DEPARTMENT = 100;

export interface SandreZoneFeature {
  gid: number;
  codeSandre: string;
  alternateCodes: string[];
  preferredAlternateCode: string | null;
  departmentCode: string;
  name: string;
  type: 'SOU' | 'SUP';
  status: 'Gelé' | 'Validé';
  sourceUpdatedAt: string;
  version: number | null;
  basinCode: number;
  influencedResource: boolean;
  geometry: any;
  payloadHash: string;
}

export interface SandreZoneSnapshot {
  features: SandreZoneFeature[];
  featureCount: number;
  sourceUpdatedAt: string | null;
  snapshotHash: string;
}

export interface SandreSnapshotTransport {
  getJson(url: string): Promise<unknown>;
  getText(url: string): Promise<string>;
}

export async function fetchSandreZoneSnapshot(
  apiBaseUrl: string,
  departmentCode: string,
  transport: SandreSnapshotTransport,
  updatedAfter?: string,
  includeUpdateDate = false,
): Promise<SandreZoneSnapshot> {
  const firstSnapshot = await readSandreZoneSnapshot(
    apiBaseUrl,
    departmentCode,
    transport,
    updatedAfter,
    includeUpdateDate,
  );
  if (firstSnapshot.featureCount <= SANDRE_PAGE_SIZE) {
    return firstSnapshot;
  }

  const verificationSnapshot = await readSandreZoneSnapshot(
    apiBaseUrl,
    departmentCode,
    transport,
    updatedAfter,
    includeUpdateDate,
  );
  if (verificationSnapshot.snapshotHash !== firstSnapshot.snapshotHash) {
    throw new Error(
      `Sandre snapshot changed while reading department ${departmentCode}`,
    );
  }
  return verificationSnapshot;
}

export function buildSandreZonesUrl(
  apiBaseUrl: string,
  departmentCode: string,
  startIndex: number,
  count: number,
  updatedAfter?: string,
  includeUpdateDate = false,
): string {
  const url = new URL(`${apiBaseUrl.replace(/\/$/, '')}/geo/zas`);
  url.search = new URLSearchParams({
    SERVICE: 'WFS',
    VERSION: '2.0.0',
    REQUEST: 'GetFeature',
    typename: 'ZAS',
    SRSNAME: 'EPSG:4326',
    OUTPUTFORMAT: 'GeoJSON',
    COUNT: String(count),
    STARTINDEX: String(startIndex),
    SORTBY: 'CdZAS',
    Filter: buildSandreFilter(departmentCode, updatedAfter, includeUpdateDate),
  }).toString();
  return url.toString();
}

export function buildSandreFeatureCountUrl(
  apiBaseUrl: string,
  departmentCode: string,
  updatedAfter?: string,
  includeUpdateDate = false,
): string {
  const url = new URL(`${apiBaseUrl.replace(/\/$/, '')}/geo/zas`);
  url.search = new URLSearchParams({
    SERVICE: 'WFS',
    VERSION: '2.0.0',
    REQUEST: 'GetFeature',
    typename: 'ZAS',
    RESULTTYPE: 'hits',
    Filter: buildSandreFilter(departmentCode, updatedAfter, includeUpdateDate),
  }).toString();
  return url.toString();
}

export function parseSandreFeatureCount(xml: string): number {
  if (typeof xml !== 'string' || !xml.trim()) {
    throw new Error('Invalid Sandre count response');
  }

  const parsed = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
  }).parse(xml);
  const count = Number(parsed?.FeatureCollection?.['@_numberMatched']);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error('Invalid Sandre count response');
  }
  return count;
}

export function parseSandreZoneFeature(
  rawFeature: any,
  departmentCode: string,
): SandreZoneFeature {
  const properties = rawFeature?.properties;
  if (!properties || properties.CdDepartement !== departmentCode) {
    throw new Error(
      `Invalid Sandre department: expected ${departmentCode}, received ${properties?.CdDepartement ?? 'missing'}`,
    );
  }

  const gid = positiveInteger(properties.gid);
  const codeSandre = toNonEmptyString(properties.CdZAS);
  const name = toNonEmptyString(properties.LbZAS);
  const type = properties.TypeZAS;
  const status = toNonEmptyString(properties.StZAS);
  const sourceUpdatedAt = normalizeDate(properties.DateMajZAS);
  const basinCode = positiveInteger(properties.NumCircAdminBassin);
  if (
    gid === null ||
    !codeSandre ||
    !name ||
    !['SOU', 'SUP'].includes(type) ||
    !['Gelé', 'Validé'].includes(status) ||
    !sourceUpdatedAt ||
    basinCode === null
  ) {
    throw new Error(
      `Invalid Sandre zone payload for department ${departmentCode}`,
    );
  }

  const explicitAlternateCode = toNonEmptyString(properties.CdAltZAS);
  const alternateCodes = [
    ...new Set([
      ...(explicitAlternateCode ? [explicitAlternateCode] : []),
      ...extractSandreAlternateCodes(properties.CodesAlternatifs),
    ]),
  ].sort();
  const preferredAlternateCode =
    explicitAlternateCode ??
    extractPreferredAlternateCode(properties.CodesAlternatifs);
  const versionValue = optionalNonNegativeInteger(properties.NumeroVersionZAS);
  const influencedResource = binaryIndicator(properties.RessInfluenceeZAS);
  if (influencedResource === null) {
    throw new Error(
      `Invalid Sandre influenced resource for zone ${codeSandre}`,
    );
  }
  const feature: Omit<SandreZoneFeature, 'payloadHash'> = {
    gid,
    codeSandre,
    alternateCodes,
    preferredAlternateCode,
    departmentCode,
    name,
    type,
    status: status as SandreZoneFeature['status'],
    sourceUpdatedAt,
    version: versionValue,
    basinCode,
    influencedResource,
    geometry: rawFeature.geometry,
  };

  if (status === 'Validé' && !isUsablePolygonGeometry(feature.geometry)) {
    throw new Error(`Invalid Sandre geometry for zone ${codeSandre}`);
  }

  return {
    ...feature,
    payloadHash: hashValue(feature),
  };
}

export function createSandreZoneSnapshot(
  rawFeatures: any[],
  numberMatched: unknown,
  departmentCode: string,
): SandreZoneSnapshot {
  const expectedCount = Number(numberMatched);
  if (!Number.isInteger(expectedCount) || expectedCount < 0) {
    throw new Error(
      `Invalid Sandre feature count for department ${departmentCode}`,
    );
  }
  if (rawFeatures.length !== expectedCount) {
    throw new Error(
      `Incomplete Sandre snapshot for department ${departmentCode}: expected ${expectedCount}, received ${rawFeatures.length}`,
    );
  }

  const features = rawFeatures.map((feature) =>
    parseSandreZoneFeature(feature, departmentCode),
  );
  const codes = new Set<string>();
  const gids = new Set<number>();
  for (const feature of features) {
    if (codes.has(feature.codeSandre)) {
      throw new Error(
        `Duplicate Sandre code ${feature.codeSandre} for department ${departmentCode}`,
      );
    }
    if (gids.has(feature.gid)) {
      throw new Error(
        `Duplicate Sandre gid ${feature.gid} for department ${departmentCode}`,
      );
    }
    codes.add(feature.codeSandre);
    gids.add(feature.gid);
  }

  const sourceDates = features
    .map((feature) => feature.sourceUpdatedAt)
    .filter((date): date is string => Boolean(date))
    .sort();
  return {
    features,
    featureCount: features.length,
    sourceUpdatedAt: sourceDates.at(-1) ?? null,
    snapshotHash: hashSandreZoneFeatures(features),
  };
}

export function hashSandreZoneFeatures(features: SandreZoneFeature[]): string {
  const sortedHashes = features
    .map((feature) => `${feature.codeSandre}:${feature.payloadHash}`)
    .sort();
  return hashValue(sortedHashes);
}

export function extractSandreAlternateCodes(value: any): string[] {
  const codes = new Set<string>();
  collectAlternateCodes(value, codes);
  return [...codes].sort();
}

function extractPreferredAlternateCode(value: unknown): string | null {
  if (!value) {
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const code = extractPreferredAlternateCode(item);
      if (code) {
        return code;
      }
    }
    return null;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return (
      toNonEmptyString(record.code) ??
      extractPreferredAlternateCode(Object.values(record))
    );
  }
  if (typeof value !== 'string') {
    return null;
  }

  const normalizedValue = value.replace(/\\"/g, '"');
  const directCode = toNonEmptyString(
    normalizedValue.match(/"code"\s*:\s*"([^"]+)"/)?.[1],
  );
  if (directCode) {
    return directCode;
  }
  try {
    return extractPreferredAlternateCode(JSON.parse(value));
  } catch {
    return null;
  }
}

async function readSandreZoneSnapshot(
  apiBaseUrl: string,
  departmentCode: string,
  transport: SandreSnapshotTransport,
  updatedAfter?: string,
  includeUpdateDate = false,
): Promise<SandreZoneSnapshot> {
  const countUrl = buildSandreFeatureCountUrl(
    apiBaseUrl,
    departmentCode,
    updatedAfter,
    includeUpdateDate,
  );
  const expectedCount = parseSandreFeatureCount(
    await transport.getText(countUrl),
  );
  const rawFeatures: any[] = [];
  let startIndex = 0;
  let pageCount = 0;

  while (rawFeatures.length < expectedCount) {
    pageCount++;
    if (pageCount > SANDRE_MAX_PAGES_PER_DEPARTMENT) {
      throw new Error(
        `Sandre snapshot exceeds ${SANDRE_MAX_PAGES_PER_DEPARTMENT} pages for department ${departmentCode}`,
      );
    }

    const page = (await transport.getJson(
      buildSandreZonesUrl(
        apiBaseUrl,
        departmentCode,
        startIndex,
        SANDRE_PAGE_SIZE,
        updatedAfter,
        includeUpdateDate,
      ),
    )) as { features?: unknown };
    if (!page || !Array.isArray(page.features)) {
      throw new Error(
        `Invalid Sandre response for department ${departmentCode}`,
      );
    }
    if (page.features.length === 0) {
      throw new Error(
        `Incomplete Sandre snapshot for department ${departmentCode}`,
      );
    }

    rawFeatures.push(...page.features);
    startIndex += page.features.length;
    if (rawFeatures.length > expectedCount) {
      throw new Error(
        `Invalid Sandre pagination for department ${departmentCode}`,
      );
    }
  }

  const endingCount = parseSandreFeatureCount(
    await transport.getText(countUrl),
  );
  if (endingCount !== expectedCount) {
    throw new Error(
      `Sandre snapshot changed while reading department ${departmentCode}`,
    );
  }

  return createSandreZoneSnapshot(rawFeatures, expectedCount, departmentCode);
}

function collectAlternateCodes(value: any, codes: Set<string>): void {
  if (!value) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectAlternateCodes(item, codes));
    return;
  }
  if (typeof value === 'object') {
    const directCode = toNonEmptyString(value.code);
    if (directCode) {
      codes.add(directCode);
    }
    Object.values(value).forEach((item) => collectAlternateCodes(item, codes));
    return;
  }
  if (typeof value !== 'string') {
    return;
  }

  const normalizedValue = value.replace(/\\"/g, '"');
  for (const match of normalizedValue.matchAll(/"code"\s*:\s*"([^"]+)"/g)) {
    const code = toNonEmptyString(match[1]);
    if (code) {
      codes.add(code);
    }
  }
  try {
    collectAlternateCodes(JSON.parse(value), codes);
  } catch {
    // Some Sandre values use a PostgreSQL-array-like serialized format.
  }
}

function normalizeDate(value: any): string | null {
  const date = toNonEmptyString(value);
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function positiveInteger(value: unknown): number | null {
  if (
    !(
      (typeof value === 'number' && Number.isInteger(value)) ||
      (typeof value === 'string' && /^\d+$/.test(value))
    )
  ) {
    return null;
  }
  const parsed = Number(value);
  return parsed > 0 ? parsed : null;
}

function optionalNonNegativeInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (
    !(
      (typeof value === 'number' && Number.isInteger(value)) ||
      (typeof value === 'string' && /^\d+$/.test(value))
    )
  ) {
    return null;
  }
  const parsed = Number(value);
  return parsed >= 0 ? parsed : null;
}

function binaryIndicator(value: unknown): boolean | null {
  if (value === 0 || value === '0') {
    return false;
  }
  if (value === 1 || value === '1') {
    return true;
  }
  return null;
}

function isUsablePolygonGeometry(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const geometry = value as { type?: unknown; coordinates?: unknown };
  if (geometry.type === 'Polygon') {
    return isUsablePolygonCoordinates(geometry.coordinates);
  }
  if (geometry.type === 'MultiPolygon') {
    return (
      Array.isArray(geometry.coordinates) &&
      geometry.coordinates.length > 0 &&
      geometry.coordinates.every(isUsablePolygonCoordinates)
    );
  }
  return false;
}

function isUsablePolygonCoordinates(value: unknown): boolean {
  return (
    Array.isArray(value) && value.length > 0 && value.every(isUsableLinearRing)
  );
}

function isUsableLinearRing(value: unknown): boolean {
  if (!Array.isArray(value) || value.length < 4) {
    return false;
  }
  const coordinates = value as unknown[];
  if (!coordinates.every(isUsablePosition)) {
    return false;
  }
  const first = coordinates[0] as number[];
  const last = coordinates.at(-1) as number[];
  return first[0] === last[0] && first[1] === last[1];
}

function isUsablePosition(value: unknown): boolean {
  if (!Array.isArray(value) || value.length < 2) {
    return false;
  }
  const [longitude, latitude] = value;
  return (
    typeof longitude === 'number' &&
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180 &&
    typeof latitude === 'number' &&
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90
  );
}

function toNonEmptyString(value: any): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function hashValue(value: any): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function buildSandreFilter(
  departmentCode: string,
  updatedAfter?: string,
  includeUpdateDate = false,
): string {
  const clauses = [
    `<PropertyIsEqualTo><PropertyName>CdDepartement</PropertyName><Literal>${escapeXml(departmentCode)}</Literal></PropertyIsEqualTo>`,
  ];
  if (updatedAfter) {
    const operator = includeUpdateDate
      ? 'PropertyIsGreaterThanOrEqualTo'
      : 'PropertyIsGreaterThan';
    clauses.push(
      `<${operator}><PropertyName>DateMajZAS</PropertyName><Literal>${escapeXml(updatedAfter)}</Literal></${operator}>`,
    );
  }

  return clauses.length === 1
    ? `<Filter>${clauses[0]}</Filter>`
    : `<Filter><And>${clauses.join('')}</And></Filter>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
