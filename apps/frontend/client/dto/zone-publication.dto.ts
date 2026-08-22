export interface ZonePublication {
  id: string;
  revision: string;
  sourceRevision?: string;
  historicComputeEpoch?: string;
  pmtilesUrl: string;
  pmtilesChecksum: string;
}
