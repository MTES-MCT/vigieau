export type PmtilesRequestKind = 'tilejson' | 'tile';

export type ZoneSourceLoadAction =
  | 'ignore'
  | 'validate'
  | 'restore-and-retry'
  | 'restore'
  | 'keep';

interface ZoneSourceLoadEvent {
  failed: boolean;
  requestKind: PmtilesRequestKind;
  isPendingCandidate: boolean;
  candidateValidated: boolean;
  retryCount: number;
  retryLimit: number;
}

export const getPmtilesRequestKind = (
  requestType?: string,
): PmtilesRequestKind => (requestType === 'json' ? 'tilejson' : 'tile');

export const getZoneSourceLoadAction = ({
  failed,
  requestKind,
  isPendingCandidate,
  candidateValidated,
  retryCount,
  retryLimit,
}: ZoneSourceLoadEvent): ZoneSourceLoadAction => {
  if (!failed) {
    return isPendingCandidate && requestKind === 'tile' ? 'validate' : 'ignore';
  }

  if (!isPendingCandidate || candidateValidated) {
    return 'keep';
  }

  return retryCount < retryLimit ? 'restore-and-retry' : 'restore';
};

export const getZoneSourceKey = (
  pmtilesUrl: string,
  publicationId: string | null,
): string => JSON.stringify([pmtilesUrl, publicationId]);

export const shouldResetZoneSourceRetryCycle = (
  handledRefreshVersion: number,
  successfulRefreshVersion: number,
): boolean => successfulRefreshVersion > handledRefreshVersion;

export const canRetainDisplayedZoneSource = (
  displayedViewKey: string | null | undefined,
  requestedViewKey: string,
): boolean =>
  Boolean(displayedViewKey && displayedViewKey === requestedViewKey);

export type DisplayedZonePublicationPin =
  | { publicationId: string | null }
  | null
  | undefined;

export const selectResponsivePublicationPin = (
  desktopVisible: boolean,
  desktopPin: DisplayedZonePublicationPin,
  mobilePin: DisplayedZonePublicationPin,
): DisplayedZonePublicationPin => (desktopVisible ? desktopPin : mobilePin);

export const captureDisplayedZonePublicationPin = (
  publicationId: string | null | undefined,
): { publicationId: string | null } => ({
  publicationId: publicationId ?? null,
});
