export type StatisticDataStatusValue =
  | 'ready'
  | 'degraded'
  | 'unavailable';

export interface StatisticDataStatus {
  status: StatisticDataStatusValue;
  usable: boolean;
  fresh: boolean;
  currentFresh: boolean;
  latestDate: string | null;
  currentPublishedDate: string | null;
  loadedAt?: string | null;
  asOf?: string | null;
  sourceRevision?: string | null;
}
