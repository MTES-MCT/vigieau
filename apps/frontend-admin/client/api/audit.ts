import { useCustomFetch } from '~/composables/useCustomFetch';
import { type AuditFilters, auditFiltersQuery } from '~/utils/audit';

export class AuditApi {
  list(filters: AuditFilters, cursor: string | null = null) {
    return useCustomFetch(`/audit-events?${auditFiltersQuery(filters, cursor)}`, { baseURL: '/api', retry: 0 }, 10000, false);
  }

  detail(operationId: string, resourceCursor?: string | null) {
    const query = resourceCursor ? `?${new URLSearchParams({ resourceCursor })}` : '';
    return useCustomFetch(`/audit-events/${encodeURIComponent(operationId)}${query}`, { baseURL: '/api', retry: 0 }, 10000, false);
  }
}
