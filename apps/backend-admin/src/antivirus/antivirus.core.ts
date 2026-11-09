import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable, Transform, pipeline } from 'node:stream';

export interface ScanOptions {
  executable?: string;
  configFile?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxDatabaseAgeMs?: number;
  signal?: AbortSignal;
}

export interface ScannerMetadata {
  engineVersion: string;
  signatureVersion: string;
  signatureUpdatedAt: string;
}

export interface ScanResult extends Partial<ScannerMetadata> {
  status: 'clean' | 'infected' | 'unscannable' | 'error';
  bytes: number;
  sha256?: string;
  signature?: string;
  reason?: string;
}

export type ScannerHealth =
  | ({ status: 'ready' } & ScannerMetadata)
  | { status: 'unavailable'; reason: string };

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_DATABASE_AGE_MS = 72 * 60 * 60 * 1000;
const OUTPUT_LIMIT = 64 * 1024;

interface CommandResult {
  code: number | null;
  output: string;
  reason?: string;
  bytes: number;
  sha256?: string;
}

/** The official client talks to the existing daemon; it never loads signatures. */
function runClient(
  args: string[],
  options: ScanOptions,
  timeoutMs: number,
  input?: Readable,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let finished = false;
    let output = '';
    let bytes = 0;
    let sha256: string | undefined;
    let inputComplete = !input;
    const hash = createHash('sha256');
    const child = spawn(
      options.executable ?? 'clamdscan',
      [
        `--config-file=${options.configFile ?? '/app/clamav/conf/clamd.conf'}`,
        ...args,
      ],
      {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, LC_ALL: 'C' },
      },
    );
    const finish = (code: number | null, reason?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (reason) child.kill('SIGKILL');
      if (!inputComplete) input?.destroy();
      child.stdin.destroy();
      resolve({ code, output, reason, bytes, sha256 });
    };
    const abort = () => finish(null, 'aborted');
    const collect = (chunk: Buffer) => {
      if (Buffer.byteLength(output) + chunk.length > OUTPUT_LIMIT) {
        finish(null, 'invalid_response');
        return;
      }
      output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', () => finish(null, 'scanner_unavailable'));
    // Keep an error listener even when the daemon closes its input early.
    child.stdin.on('error', () => undefined);
    child.on('close', (code) => {
      finish(code, inputComplete ? undefined : 'incomplete_stream');
    });
    const timer = setTimeout(
      () => finish(null, 'timeout'),
      Math.max(1, timeoutMs),
    );
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) {
      abort();
      return;
    }
    if (!input) {
      child.stdin.end();
      return;
    }
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > (options.maxBytes ?? DEFAULT_MAX_BYTES)) {
          finish(null, 'size_limit');
          callback(new Error('Document exceeds scan limit'));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
      flush(callback) {
        sha256 = hash.digest('hex');
        inputComplete = true;
        callback();
      },
    });
    pipeline(input, meter, child.stdin, (error) => {
      if (error && !finished) finish(null, 'stream_error');
    });
  });
}

/** A version without database fields is the client's fallback, NOT daemon health. */
export function parseScannerVersion(output: string): ScannerMetadata | null {
  const match = output.match(/^ClamAV ([^/\r\n]+)\/(\d+)\/([^\r\n]+)$/m);
  if (!match) return null;
  const timestamp = Date.parse(match[3]);
  if (!Number.isFinite(timestamp)) return null;
  return {
    engineVersion: match[1],
    signatureVersion: match[2],
    signatureUpdatedAt: new Date(timestamp).toISOString(),
  };
}

export async function getScannerHealth(
  options: ScanOptions = {},
): Promise<ScannerHealth> {
  const started = Date.now();
  const budget = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ping = await runClient(['--ping=1'], options, Math.min(3000, budget));
  if (ping.reason || ping.code !== 0) {
    return {
      status: 'unavailable',
      reason: ping.reason ?? 'scanner_unavailable',
    };
  }
  const remaining = budget - (Date.now() - started);
  if (remaining <= 0) return { status: 'unavailable', reason: 'timeout' };
  const version = await runClient(
    ['--version'],
    options,
    Math.min(3000, remaining),
  );
  const metadata = parseScannerVersion(version.output);
  if (version.reason || version.code !== 0 || !metadata) {
    return {
      status: 'unavailable',
      reason: version.reason ?? 'invalid_version',
    };
  }
  const age = Date.now() - Date.parse(metadata.signatureUpdatedAt);
  if (
    age < -5 * 60 * 1000 ||
    age > (options.maxDatabaseAgeMs ?? DEFAULT_DATABASE_AGE_MS)
  ) {
    return { status: 'unavailable', reason: 'stale_signatures' };
  }
  return { status: 'ready', ...metadata };
}

/** Streams and hashes bytes once. No filenames, shell, temporary PDFs or deletion. */
export async function scanDocumentStream(
  stream: Readable,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const started = Date.now();
  // An incoming S3/HTTP stream can fail while the daemon health is being checked.
  let sourceFailed = false;
  const onSourceError = () => {
    sourceFailed = true;
  };
  stream.on('error', onSourceError);
  try {
    const health = await getScannerHealth(options);
    if (health.status !== 'ready') {
      stream.destroy();
      return { status: 'error', bytes: 0, reason: health.reason };
    }
    const metadata: ScannerMetadata = {
      engineVersion: health.engineVersion,
      signatureVersion: health.signatureVersion,
      signatureUpdatedAt: health.signatureUpdatedAt,
    };
    const remaining =
      (options.timeoutMs ?? DEFAULT_TIMEOUT_MS) - (Date.now() - started);
    if (remaining <= 0 || sourceFailed) {
      stream.destroy();
      return {
        status: 'error',
        bytes: 0,
        ...metadata,
        reason: sourceFailed ? 'stream_error' : 'timeout',
      };
    }
    const response = await runClient(
      ['--stream', '--no-summary', '-'],
      options,
      remaining,
      stream,
    );
    const base = {
      bytes: response.bytes,
      sha256: response.sha256,
      ...metadata,
    };
    if (response.reason) {
      return {
        ...base,
        status: response.reason === 'size_limit' ? 'unscannable' : 'error',
        reason: response.reason,
      };
    }
    const signature = response.output.match(/^[^\r\n]+: (.+) FOUND\s*$/m)?.[1];
    if (response.code === 1 && signature) {
      const incomplete = /^Heuristics\.(?:Encrypted|Limits\.Exceeded)/i.test(
        signature,
      );
      return {
        ...base,
        status: incomplete ? 'unscannable' : 'infected',
        signature,
        ...(incomplete
          ? {
              reason: /^Heuristics\.Encrypted/i.test(signature)
                ? 'encrypted'
                : 'scan_limit',
            }
          : {}),
      };
    }
    if (
      response.code === 0 &&
      /^[^\r\n]+: OK\s*$/m.test(response.output) &&
      !/\b(?:ERROR|FOUND)\b/.test(response.output) &&
      response.sha256
    ) {
      return { ...base, status: 'clean' };
    }
    const limit =
      /size limit|INSTREAM.*limit|Heuristics\.Limits\.Exceeded/i.test(
        response.output,
      );
    return {
      ...base,
      status: limit ? 'unscannable' : 'error',
      reason: limit ? 'scan_limit' : 'scanner_error',
    };
  } finally {
    stream.removeListener('error', onSourceError);
  }
}
