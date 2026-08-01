export const ZONE_PUBLICATION_MATERIALIZATION_VERSION = 1;
export const ZONE_PUBLICATION_STABLE_PROMOTION_LOCK =
  'vigieau:zone-publication-stable-promotion';
export const ZONE_PUBLICATION_DATAGOUV_PROMOTION_LOCK =
  'vigieau:zone-publication-datagouv-promotion';

export function isZonePublicationEnabled(): boolean {
  return process.env.ZONE_PUBLICATION_ENABLED?.trim().toLowerCase() === 'true';
}
