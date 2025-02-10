export interface PaginatedResult<T> {
  data: T[];
  meta: {
    itemsPerPage: number;
    totalItems: number;
    currentPage: number;
    totalPages: number;
    dsfrPages: {
      label: string;
      title: string;
    }[];
  };
  links: {
    first: string;
    previous: string;
    current: string;
    next: string;
    last: string;
  };
}
