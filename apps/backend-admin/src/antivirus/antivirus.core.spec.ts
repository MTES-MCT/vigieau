import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  getScannerHealth,
  parseScannerVersion,
  scanDocumentStream,
} from './antivirus.core';

jest.mock('node:child_process', () => ({ spawn: jest.fn() }));

function scanner(
  options: {
    output?: string;
    code?: number;
    date?: string;
    hang?: boolean;
    version?: string;
  } = {},
) {
  const children: any[] = [];
  const inputs: Buffer[] = [];
  (spawn as jest.Mock).mockImplementation((_executable, args) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: jest.fn(),
    });
    children.push(child);
    child.stdin.on('data', (chunk) => inputs.push(chunk));
    const end = (text: string, code = 0) => {
      child.stdout.end(text);
      child.emit('close', code);
    };
    if (args.includes('--version')) {
      queueMicrotask(() =>
        end(
          options.version ??
            `ClamAV 1.4.6/28000/${options.date ?? new Date().toUTCString()}\n`,
        ),
      );
    } else if (args.includes('--ping=1')) {
      queueMicrotask(() => end(''));
    } else if (!options.hang) {
      child.stdin.on('finish', () =>
        setImmediate(() =>
          end(options.output ?? 'stream: OK\n', options.code ?? 0),
        ),
      );
    }
    return child;
  });
  return { children, inputs };
}

describe('official clamdscan stream client', () => {
  beforeEach(() => jest.clearAllMocks());

  it('streams unchanged bytes without a shell and returns a complete SHA-256 plus daemon metadata', async () => {
    const { inputs } = scanner();
    const bytes = Buffer.from('%PDF-1.7\nexample');
    const result = await scanDocumentStream(
      Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]),
    );
    expect(result).toMatchObject({
      status: 'clean',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      engineVersion: '1.4.6',
      signatureVersion: '28000',
    });
    expect(Buffer.concat(inputs)).toEqual(bytes);
    expect(spawn).toHaveBeenLastCalledWith(
      'clamdscan',
      [
        '--config-file=/app/clamav/conf/clamd.conf',
        '--stream',
        '--no-summary',
        '-',
      ],
      expect.objectContaining({ shell: false }),
    );
  });

  it.each([
    ['stream: Win.Test.EICAR_HDB-1 FOUND\n', 1, 'infected', undefined],
    ['stream: Heuristics.Encrypted.PDF FOUND\n', 1, 'unscannable', 'encrypted'],
    [
      'stream: Heuristics.Limits.Exceeded.MaxScanSize FOUND\n',
      1,
      'unscannable',
      'scan_limit',
    ],
    [
      'stream: INSTREAM size limit exceeded. ERROR\n',
      2,
      'unscannable',
      'scan_limit',
    ],
    ['ERROR: Could not connect to clamd\n', 2, 'error', 'scanner_error'],
    ['', 0, 'error', 'scanner_error'],
    ['stream: OK\nERROR: incomplete\n', 0, 'error', 'scanner_error'],
  ])(
    'interprets %s without accepting incomplete scans',
    async (output, code, status, reason) => {
      scanner({ output, code });
      expect(
        await scanDocumentStream(Readable.from([Buffer.from('pdf')])),
      ).toMatchObject({ status, ...(reason ? { reason } : {}) });
    },
  );

  it('rejects stale signatures before consuming any file bytes', async () => {
    const { inputs } = scanner({
      date: new Date(Date.now() - 96 * 3600_000).toUTCString(),
    });
    expect(await scanDocumentStream(Readable.from(['pdf']))).toMatchObject({
      status: 'error',
      reason: 'stale_signatures',
      bytes: 0,
    });
    expect(inputs).toEqual([]);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('rejects the version-only fallback even though clamdscan exits successfully', async () => {
    scanner({ version: 'ClamAV 1.4.6\n' });
    expect(await getScannerHealth()).toEqual({
      status: 'unavailable',
      reason: 'invalid_version',
    });
    expect(parseScannerVersion('ClamAV 1.4.6/28000/invalid')).toBeNull();
  });

  it('kills a timed-out client and never reports it clean', async () => {
    const { children } = scanner({ hang: true });
    expect(
      await scanDocumentStream(Readable.from(['pdf']), { timeoutMs: 30 }),
    ).toMatchObject({ status: 'error', reason: 'timeout' });
    expect(children[2].kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('aborts oversized streams without a misleading full-file hash', async () => {
    scanner({ hang: true });
    const result = await scanDocumentStream(Readable.from([Buffer.alloc(8)]), {
      maxBytes: 4,
    });
    expect(result).toMatchObject({
      status: 'unscannable',
      reason: 'size_limit',
    });
    expect(result.sha256).toBeUndefined();
  });

  it('handles a missing executable as unavailable', async () => {
    const children = scanner().children;
    (spawn as jest.Mock).mockImplementationOnce(() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: jest.fn(),
      });
      children.push(child);
      queueMicrotask(() => child.emit('error', new Error('ENOENT')));
      return child;
    });
    expect(await scanDocumentStream(Readable.from(['pdf']))).toMatchObject({
      status: 'error',
      reason: 'scanner_unavailable',
    });
  });
});
