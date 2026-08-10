export const ADDRESS_SEARCH_LOADING_STATUS = 'Recherche d’adresses en cours.';

export function getAddressSuggestionStatus(optionCount: number): string {
  if (optionCount === 0) {
    return 'Aucune adresse trouvée.';
  }

  const suggestionLabel = optionCount === 1
    ? 'suggestion d’adresse disponible'
    : 'suggestions d’adresses disponibles';

  return `${optionCount} ${suggestionLabel}. Utilisez les flèches haut et bas pour parcourir la liste.`;
}

export function moveActiveOption(
  currentIndex: number,
  optionCount: number,
  direction: 'next' | 'previous',
): number {
  if (optionCount <= 0) {
    return -1;
  }

  if (direction === 'previous') {
    return currentIndex <= 0 ? optionCount - 1 : currentIndex - 1;
  }

  return currentIndex < 0 || currentIndex >= optionCount - 1
    ? 0
    : currentIndex + 1;
}

export interface LatestRequestGuard {
  cancel: () => number;
  isCurrent: (requestId: number) => boolean;
  next: () => number;
}

export function createLatestRequestGuard(): LatestRequestGuard {
  let latestRequestId = 0;

  return {
    cancel: () => ++latestRequestId,
    isCurrent: (requestId: number) => requestId === latestRequestId,
    next: () => ++latestRequestId,
  };
}
