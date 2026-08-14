export interface TablePaginationState {
  currentPage: number;
  endIndex: number;
  firstResult: number;
  lastResult: number;
  startIndex: number;
  totalPages: number;
}

const toPositiveInteger = (value: number, fallback: number): number => {
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

export const getTablePaginationState = (
  totalResults: number,
  resultsPerPage: number,
  requestedPage: number,
): TablePaginationState => {
  const safeTotal = Math.max(0, Math.floor(totalResults));
  const safeResultsPerPage = toPositiveInteger(resultsPerPage, 10);
  const totalPages = Math.max(1, Math.ceil(safeTotal / safeResultsPerPage));
  const currentPage = Math.min(
    toPositiveInteger(requestedPage, 1),
    totalPages,
  );
  const startIndex = (currentPage - 1) * safeResultsPerPage;
  const endIndex = Math.min(startIndex + safeResultsPerPage, safeTotal);

  return {
    currentPage,
    endIndex,
    firstResult: safeTotal === 0 ? 0 : startIndex + 1,
    lastResult: endIndex,
    startIndex,
    totalPages,
  };
};

export const paginateTableRows = <Row>(
  rows: Row[],
  resultsPerPage: number,
  requestedPage: number,
): Row[] => {
  const { startIndex, endIndex } = getTablePaginationState(
    rows.length,
    resultsPerPage,
    requestedPage,
  );

  return rows.slice(startIndex, endIndex);
};
