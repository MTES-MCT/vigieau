// Version 4 publishes harmonized computed severity in map artifacts.
export const ZONE_PUBLICATION_MATERIALIZATION_VERSION = 4;
export const ZONE_PUBLICATION_STABLE_PROMOTION_LOCK =
  'vigieau:zone-publication-stable-promotion';
export const ZONE_PUBLICATION_DATAGOUV_PROMOTION_LOCK =
  'vigieau:zone-publication-datagouv-promotion';
export const PUBLIC_SOURCE_REVISION_ENABLED_ENV =
  'PUBLIC_SOURCE_REVISION_ENABLED';

export function zoneGeojsonContentDisposition(fileName: string): string {
  return `attachment; filename="${fileName}"`;
}

export function isZonePublicationEnabled(): boolean {
  return process.env.ZONE_PUBLICATION_ENABLED?.trim().toLowerCase() === 'true';
}

export function isPublicSourceRevisionEnabled(): boolean {
  const value =
    process.env[PUBLIC_SOURCE_REVISION_ENABLED_ENV]?.trim().toLowerCase() ||
    'false';
  if (value !== 'true' && value !== 'false') {
    throw new Error(
      `Unsupported ${PUBLIC_SOURCE_REVISION_ENABLED_ENV}: ${value}`,
    );
  }
  return value === 'true';
}

export function sourceRevisionColumn(alias?: string): string {
  const prefix = alias ? `${alias}.` : '';
  const column = isPublicSourceRevisionEnabled()
    ? 'publicRevision'
    : 'revision';
  return `${prefix}\"${column}\"`;
}
