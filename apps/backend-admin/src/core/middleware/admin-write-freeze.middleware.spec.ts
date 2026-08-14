import {
  adminWriteFreezeMiddleware,
  areAdminWritesDisabled,
} from './admin-write-freeze.middleware';

describe('adminWriteFreezeMiddleware', () => {
  it('keeps reads available during the freeze', () => {
    expect(areAdminWritesDisabled('GET', 'true')).toBe(false);
    expect(areAdminWritesDisabled('HEAD', 'true')).toBe(false);
    expect(areAdminWritesDisabled('OPTIONS', 'true')).toBe(false);
  });

  it('blocks mutations only when explicitly enabled', () => {
    expect(areAdminWritesDisabled('POST', 'true')).toBe(true);
    expect(areAdminWritesDisabled('PATCH', 'TRUE')).toBe(true);
    expect(areAdminWritesDisabled('DELETE', 'false')).toBe(false);
    expect(areAdminWritesDisabled('PUT', undefined)).toBe(false);
    expect(
      areAdminWritesDisabled('POST', 'true', '/api/zone-publication/rollback'),
    ).toBe(false);
  });

  it('returns a retryable 503 without calling the next handler', () => {
    const previous = process.env.ADMIN_WRITES_DISABLED;
    process.env.ADMIN_WRITES_DISABLED = 'true';
    const next = jest.fn();
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const setHeader = jest.fn();

    try {
      adminWriteFreezeMiddleware(
        { method: 'POST', path: '/api/arrete-cadre' } as never,
        { setHeader, status } as never,
        next,
      );
    } finally {
      if (previous === undefined) {
        delete process.env.ADMIN_WRITES_DISABLED;
      } else {
        process.env.ADMIN_WRITES_DISABLED = previous;
      }
    }

    expect(next).not.toHaveBeenCalled();
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '3600');
    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ADMIN_WRITES_DISABLED' }),
    );
  });
});
