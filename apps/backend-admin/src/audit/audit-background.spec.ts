import { executeAuditedJob } from './audit-background';
import { getAuditContext } from './audit-context';

describe('background audit attribution', () => {
  const previous = process.env.AUDIT_ENABLED;
  beforeEach(() => {
    process.env.AUDIT_ENABLED = 'true';
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.AUDIT_ENABLED;
    else process.env.AUDIT_ENABLED = previous;
  });
  it('records all causal references and runs the job as system, not as the last user', async () => {
    const audit = {
      recordEvent: jest.fn().mockResolvedValue('event-id'),
      link: jest.fn(),
      recordBestEffort: jest.fn(),
    };
    const refs = [
      { kind: 'current-zone-revision', reference: '1:42' },
      { kind: 'current-zone-revision', reference: '2:43' },
    ];
    const work = jest.fn(async () => {
      expect(getAuditContext().source).toBe('system');
      expect(getAuditContext().actor.email).toBeNull();
      return 'completed';
    });
    await expect(
      executeAuditedJob(audit as any, 'current_zone.recompute', refs, work),
    ).resolves.toBe('completed');
    expect(audit.link).toHaveBeenCalledWith(
      'event-id',
      'current-zone-revision',
      '1:42',
    );
    expect(audit.link).toHaveBeenCalledWith(
      'event-id',
      'current-zone-revision',
      '2:43',
    );
    expect(audit.recordEvent).toHaveBeenLastCalledWith(
      'succeeded',
      expect.objectContaining({ jobResult: 'completed' }),
      expect.any(Object),
    );
    expect(getAuditContext()).toBeUndefined();
  });
  it('does not start work if the initial audit cannot be persisted', async () => {
    const work = jest.fn();
    const audit = {
      recordEvent: jest.fn().mockRejectedValue(new Error('audit unavailable')),
    };
    await expect(
      executeAuditedJob(audit as any, 'job', [], work),
    ).rejects.toThrow('audit unavailable');
    expect(work).not.toHaveBeenCalled();
  });
  it('does not turn a lost lease into proof of failure or success', async () => {
    const audit = {
      recordEvent: jest.fn().mockResolvedValue('event-id'),
      link: jest.fn(),
      recordBestEffort: jest.fn(),
    };
    await executeAuditedJob(audit as any, 'job', [], async () => 'lease-lost');
    expect(audit.recordEvent).toHaveBeenLastCalledWith(
      'unknown',
      expect.objectContaining({ jobResult: 'lease-lost' }),
      expect.any(Object),
    );
  });
  it('keeps a completed job completed when its final audit write fails', async () => {
    const audit = {
      recordEvent: jest
        .fn()
        .mockResolvedValueOnce('event-id')
        .mockRejectedValueOnce(new Error('audit unavailable')),
      recordBestEffort: jest.fn(),
      reportFailure: jest.fn(),
    };
    await expect(
      executeAuditedJob(audit as any, 'job', [], async () => 'completed'),
    ).resolves.toBe('completed');
    expect(audit.reportFailure).toHaveBeenCalledTimes(1);
    expect(audit.recordBestEffort).not.toHaveBeenCalled();
  });
});
