import { AuditService } from './audit.service';
import { systemAuditContext } from './audit-context';

describe('audit availability policy', () => {
  beforeEach(() => {
    process.env.AUDIT_ENABLED = 'true';
  });
  afterEach(() => {
    delete process.env.AUDIT_ENABLED;
    jest.useRealTimers();
  });

  it('bounds pool waits and never starts a delayed write after its deadline', async () => {
    jest.useFakeTimers();
    let connect: () => void;
    const runner = {
      connect: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            connect = resolve;
          }),
      ),
      startTransaction: jest.fn(),
      query: jest.fn(),
      commitTransaction: jest.fn(),
      release: jest.fn(async () => undefined),
      isTransactionActive: false,
    };
    const service = new AuditService({
      createQueryRunner: () => runner,
    } as any);
    jest.spyOn(service, 'reportFailure').mockImplementation(() => undefined);
    const result = service.recordBestEffort(
      'read',
      {},
      systemAuditContext('audit.list'),
    );
    await jest.advanceTimersByTimeAsync(2001);
    expect(await result).toBeNull();
    connect();
    await Promise.resolve();
    await Promise.resolve();
    expect(runner.query).not.toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalled();
    expect(service.reportFailure).toHaveBeenCalledTimes(1);
  });

  it('does not grant journal access based on an obsolete MTE session role', async () => {
    const service = new AuditService({
      query: jest.fn(async () => [{ role: 'departement' }]),
    } as any);
    await expect(
      service.requireMte({ email: 'former-admin@example.test', role: 'mte' }),
    ).rejects.toThrow('Accès réservé');
  });
});
