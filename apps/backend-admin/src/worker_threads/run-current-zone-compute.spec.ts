import { EventEmitter } from 'node:events';
import { waitForCurrentZoneComputeWorker } from './run-current-zone-compute';

describe('waitForCurrentZoneComputeWorker', () => {
  it('resolves only after a successful worker exit', async () => {
    const worker = new EventEmitter();
    const result = waitForCurrentZoneComputeWorker(worker as any);

    worker.emit('message', { success: true });
    worker.emit('exit', 0);

    await expect(result).resolves.toEqual({ success: true });
  });

  it('rejects a non-zero exit even if a result was sent', async () => {
    const worker = new EventEmitter();
    const result = waitForCurrentZoneComputeWorker(worker as any);

    worker.emit('message', { success: true });
    worker.emit('exit', 1);

    await expect(result).rejects.toThrow(
      'Zone compute worker stopped with exit code 1',
    );
  });

  it('rejects a worker that exits without a result', async () => {
    const worker = new EventEmitter();
    const result = waitForCurrentZoneComputeWorker(worker as any);

    worker.emit('exit', 0);

    await expect(result).rejects.toThrow(
      'Zone compute worker exited without a result',
    );
  });

  it('keeps the reported primary error when a failed worker exits non-zero', async () => {
    const worker = new EventEmitter();
    const result = waitForCurrentZoneComputeWorker(worker as any);

    worker.emit('message', {
      success: false,
      error: 'Original computation failed',
    });
    worker.emit('exit', 1);

    await expect(result).rejects.toThrow(
      'Zone compute worker stopped with exit code 1: Original computation failed',
    );
  });

  it.each([
    { success: true, error: 'Do not trust this error' },
    { success: false, error: { message: 'Not a string' } },
  ])(
    'does not add an invalid failure diagnostic to non-zero exits',
    async (message) => {
      const worker = new EventEmitter();
      const result = waitForCurrentZoneComputeWorker(worker as any);
      worker.emit('message', message);
      worker.emit('exit', 1);
      await expect(result).rejects.toThrow(
        /^Zone compute worker stopped with exit code 1$/,
      );
    },
  );

  it('terminates and rejects a worker that exceeds its deadline', async () => {
    const worker = Object.assign(new EventEmitter(), {
      terminate: jest.fn().mockResolvedValue(1),
    });
    const result = waitForCurrentZoneComputeWorker(worker as any, 1);

    await expect(result).rejects.toThrow('Zone compute worker timed out');
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
