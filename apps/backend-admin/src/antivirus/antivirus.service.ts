import {
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  getScannerHealth,
  ScanOptions,
  scanDocumentStream,
} from './antivirus.core';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class AntivirusService {
  private scanning = false;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  private isEnabled(): boolean {
    const enabled = this.config.get<string>('ANTIVIRUS_ENABLED');
    const deployed = [
      this.config.get<string>('NODE_ENV'),
      this.config.get<string>('SENTRY_ENV'),
    ].some((value) =>
      ['prod', 'production', 'preprod', 'preproduction', 'staging'].includes(
        value,
      ),
    );
    if (enabled === 'true') return true;
    if (enabled === 'false' && !deployed) return false;
    throw new ServiceUnavailableException(
      "L'analyse antivirus est indisponible. Réessayez plus tard.",
    );
  }

  private options(): ScanOptions {
    const timeout = Number(
      this.config.get<string>('ANTIVIRUS_TIMEOUT_MS') ?? 15_000,
    );
    const age = Number(
      this.config.get<string>('ANTIVIRUS_MAX_DATABASE_AGE_HOURS') ?? 72,
    );
    if (
      !Number.isInteger(timeout) ||
      timeout < 1000 ||
      timeout > 15_000 ||
      !Number.isFinite(age) ||
      age <= 0 ||
      age > 72
    ) {
      throw new ServiceUnavailableException(
        "L'analyse antivirus est indisponible. Réessayez plus tard.",
      );
    }
    return {
      executable: this.config.get<string>('CLAMDSCAN_PATH') || 'clamdscan',
      configFile:
        this.config.get<string>('CLAMD_CONFIG_FILE') ||
        '/app/clamav/conf/clamd.conf',
      timeoutMs: timeout,
      maxBytes: 10_000_000,
      maxDatabaseAgeMs: age * 60 * 60 * 1000,
    };
  }

  async scanOrThrow(file: Express.Multer.File): Promise<void> {
    if (!this.isEnabled()) return;
    if (!file?.buffer?.length || file.buffer.length > 10_000_000) {
      throw new UnprocessableEntityException(
        'Le document est vide ou dépasse la limite de 10 Mo.',
      );
    }
    const hash = createHash('sha256').update(file.buffer).digest('hex');
    if (this.scanning) {
      throw new ServiceUnavailableException(
        "L'antivirus analyse déjà un document. Réessayez dans quelques instants.",
      );
    }
    this.scanning = true;
    try {
      const result = await scanDocumentStream(
        Readable.from([file.buffer]),
        this.options(),
      );
      await this.audit?.recordEvent(
        result.status === 'clean' ? 'accepted' : 'failed',
        {
          stage: 'document.scan',
          verdict: result.status,
          sha256: hash,
          size: file.buffer.length,
          mimeType: file.mimetype,
          engineVersion: result.engineVersion,
          signatureVersion: result.signatureVersion,
        },
      );
      if (result.status === 'infected') {
        throw new UnprocessableEntityException(
          'Le document a été refusé car une menace a été détectée.',
        );
      }
      if (result.status === 'unscannable') {
        throw new UnprocessableEntityException(
          'Le document ne peut pas être analysé intégralement (chiffrement ou limites dépassées). Fournissez un PDF non protégé.',
        );
      }
      if (result.status !== 'clean' || result.sha256 !== hash) {
        throw new ServiceUnavailableException(
          "L'analyse antivirus n'a pas pu aboutir. Le document n'a pas été enregistré. Réessayez plus tard.",
        );
      }
    } finally {
      this.scanning = false;
    }
  }

  async health() {
    if (!this.isEnabled()) return { status: 'disabled' };
    const health = await getScannerHealth({
      ...this.options(),
      timeoutMs: 5000,
    });
    if (health.status !== 'ready')
      throw new ServiceUnavailableException({ status: 'unavailable' });
    return health;
  }
}
