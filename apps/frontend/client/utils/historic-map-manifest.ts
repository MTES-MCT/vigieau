const CIVIL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const HISTORIC_MAP_MANIFEST_FILE = 'historic-backfill-manifest.json';

export interface HistoricMapManifestArtifact {
  validFrom: string;
  validThrough: string;
  geojsonUrl: string;
  geojsonChecksum: string;
  pmtilesUrl: string;
  pmtilesChecksum: string;
  featureCount: number;
}

export interface HistoricMapManifest {
  version: 1;
  runId: string;
  mapDateFrom: string;
  dateThrough: string;
  sourceRevision: string;
  historicComputeEpoch: string;
  artifacts: HistoricMapManifestArtifact[];
}

export interface HistoricMapPublicationContext {
  sourceRevision?: string | null;
  historicComputeEpoch?: string | null;
}

function isCivilDate(value: unknown): value is string {
  if (typeof value !== 'string' || !CIVIL_DATE_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function nextCivilDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function isImmutableArtifactUrl(
  value: unknown,
  runId: string,
  sourceRevision: string,
  historicComputeEpoch: string,
  validFrom: string,
  checksum: string,
  extension: '.geojson' | '.pmtiles',
): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    const url = new URL(value);
    const pathname = decodeURIComponent(url.pathname);
    const immutableSuffix =
      `/historic-backfill/${runId}/national/` +
      `revision-${sourceRevision}/epoch-${historicComputeEpoch}/` +
      `${validFrom}-${checksum}${extension}`;
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      pathname.endsWith(immutableSuffix)
    );
  } catch {
    return false;
  }
}

export function parseHistoricMapManifest(value: unknown): HistoricMapManifest {
  if (!value || typeof value !== 'object') {
    throw new Error('Historic map manifest is not an object');
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.runId !== 'string' ||
    !UUID_PATTERN.test(candidate.runId) ||
    !isCivilDate(candidate.mapDateFrom) ||
    !isCivilDate(candidate.dateThrough) ||
    candidate.dateThrough < candidate.mapDateFrom ||
    typeof candidate.sourceRevision !== 'string' ||
    !/^\d+$/.test(candidate.sourceRevision) ||
    typeof candidate.historicComputeEpoch !== 'string' ||
    !/^\d+$/.test(candidate.historicComputeEpoch) ||
    !Array.isArray(candidate.artifacts) ||
    candidate.artifacts.length === 0
  ) {
    throw new Error('Historic map manifest metadata is invalid');
  }

  let expectedFrom = candidate.mapDateFrom;
  const artifacts = candidate.artifacts.map((value, index) => {
    if (!value || typeof value !== 'object') {
      throw new Error(`Historic map artifact ${index} is invalid`);
    }
    const artifact = value as Record<string, unknown>;
    if (
      !isCivilDate(artifact.validFrom) ||
      !isCivilDate(artifact.validThrough) ||
      artifact.validFrom !== expectedFrom ||
      artifact.validThrough < artifact.validFrom ||
      typeof artifact.geojsonChecksum !== 'string' ||
      !SHA256_PATTERN.test(artifact.geojsonChecksum) ||
      typeof artifact.pmtilesChecksum !== 'string' ||
      !SHA256_PATTERN.test(artifact.pmtilesChecksum) ||
      !isImmutableArtifactUrl(
        artifact.geojsonUrl,
        candidate.runId as string,
        candidate.sourceRevision as string,
        candidate.historicComputeEpoch as string,
        artifact.validFrom,
        artifact.geojsonChecksum,
        '.geojson',
      ) ||
      !isImmutableArtifactUrl(
        artifact.pmtilesUrl,
        candidate.runId as string,
        candidate.sourceRevision as string,
        candidate.historicComputeEpoch as string,
        artifact.validFrom,
        artifact.pmtilesChecksum,
        '.pmtiles',
      ) ||
      typeof artifact.featureCount !== 'number' ||
      !Number.isSafeInteger(artifact.featureCount) ||
      artifact.featureCount < 0
    ) {
      throw new Error(`Historic map artifact ${index} is invalid`);
    }
    expectedFrom = nextCivilDate(artifact.validThrough);
    return artifact as unknown as HistoricMapManifestArtifact;
  });

  if (
    artifacts[0].validFrom !== candidate.mapDateFrom ||
    artifacts[artifacts.length - 1].validThrough !== candidate.dateThrough
  ) {
    throw new Error('Historic map manifest coverage is incomplete');
  }

  return {
    version: 1,
    runId: candidate.runId,
    mapDateFrom: candidate.mapDateFrom,
    dateThrough: candidate.dateThrough,
    sourceRevision: candidate.sourceRevision,
    historicComputeEpoch: candidate.historicComputeEpoch,
    artifacts,
  };
}

export async function loadHistoricMapManifest(
  manifestUrl: string,
  fetchManifest: typeof fetch = fetch,
): Promise<HistoricMapManifest | null> {
  const response = await fetchManifest(manifestUrl, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(
      `Historic map manifest request failed with ${response.status}`,
    );
  }
  return parseHistoricMapManifest(await response.json());
}

export function deriveHistoricMapManifestUrl(pmtilesUrl: string): string {
  const fragmentIndex = pmtilesUrl.search(/[?#]/);
  const cleanUrl =
    fragmentIndex === -1 ? pmtilesUrl : pmtilesUrl.slice(0, fragmentIndex);
  const lastSlash = cleanUrl.lastIndexOf('/');
  if (lastSlash < 0) {
    throw new Error('PMTiles URL must contain a directory');
  }
  return `${cleanUrl.slice(0, lastSlash + 1)}${HISTORIC_MAP_MANIFEST_FILE}`;
}

export function resolveHistoricMapPmtilesUrl(
  manifest: HistoricMapManifest,
  date: string,
): string | null {
  if (
    !isCivilDate(date) ||
    date < manifest.mapDateFrom ||
    date > manifest.dateThrough
  ) {
    return null;
  }
  return (
    manifest.artifacts.find(
      (artifact) => artifact.validFrom <= date && artifact.validThrough >= date,
    )?.pmtilesUrl ?? null
  );
}

export function resolveHistoricMapSourceUrl(
  manifest: HistoricMapManifest | null | undefined,
  date: string,
  legacyPmtilesBaseUrl: string,
  activePublication: HistoricMapPublicationContext,
): string | null {
  if (manifest === undefined) {
    return null;
  }
  if (
    manifest === null ||
    !activePublication.historicComputeEpoch ||
    manifest.historicComputeEpoch !== activePublication.historicComputeEpoch
  ) {
    return `${legacyPmtilesBaseUrl}_${date}.pmtiles`;
  }
  return (
    resolveHistoricMapPmtilesUrl(manifest, date) ??
    `${legacyPmtilesBaseUrl}_${date}.pmtiles`
  );
}
