import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

export type MatomoSource = 'current' | 'legacy';
export type MatomoFailure =
  | 'configuration'
  | 'authentication'
  | 'http'
  | 'timeout'
  | 'network'
  | 'invalid-response';

export class MatomoReportError extends Error {
  constructor(
    readonly source: MatomoSource,
    readonly report: string,
    readonly kind: MatomoFailure,
    readonly status?: number,
    readonly host?: string,
  ) {
    super(
      `Matomo ${source} ${report}: ${kind}${status ? ` (HTTP ${status})` : ''}`,
    );
    this.name = 'MatomoReportError';
  }
}

@Injectable()
export class MatomoStatisticsClient {
  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  configurationFingerprint(): string {
    return createHash('sha256')
      .update(
        JSON.stringify(
          ['MATOMO', 'OLD_MATOMO'].map((prefix) =>
            ['URL', 'API_KEY', 'ID_SITE'].map((key) =>
              this.configService.get<string>(`${prefix}_${key}`)?.trim(),
            ),
          ),
        ),
      )
      .digest('hex');
  }

  async getReport(
    source: MatomoSource,
    method: string,
    date: string,
    idSubtable?: string,
  ): Promise<{ data: Record<string, any> }> {
    const prefix = source === 'current' ? 'MATOMO' : 'OLD_MATOMO';
    const token = this.configService.get<string>(`${prefix}_API_KEY`)?.trim();
    const site = this.configService.get<string>(`${prefix}_ID_SITE`)?.trim();
    let url: URL;
    try {
      url = new URL(this.configService.get<string>(`${prefix}_URL`) || '');
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password
      ) {
        throw new Error('Invalid Matomo URL');
      }
    } catch {
      throw new MatomoReportError(source, method, 'configuration');
    }
    if (!token || !site) {
      throw new MatomoReportError(
        source,
        method,
        'configuration',
        undefined,
        url.host,
      );
    }
    url.search = '';
    url.hash = '';
    const body = new URLSearchParams({
      module: 'API',
      format: 'JSON',
      idSite: site,
      period: 'day',
      date,
      method,
      token_auth: token,
    });
    if (idSubtable) body.set('idSubtable', idSubtable);

    let data: unknown;
    try {
      // POST-only Matomo tokens are rejected when sent in a GET query string.
      const response = await firstValueFrom(
        this.httpService.post(url.toString(), body.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10_000,
          maxRedirects: 0,
        }),
      );
      data = response.data;
    } catch (error) {
      const status = Number(error?.response?.status) || undefined;
      const kind: MatomoFailure =
        status === 401 || status === 403
          ? 'authentication'
          : status
            ? 'http'
            : ['ECONNABORTED', 'ETIMEDOUT'].includes(error?.code)
              ? 'timeout'
              : 'network';
      // Axios errors retain the request body, including token_auth.
      throw new MatomoReportError(source, method, kind, status, url.host);
    }
    if (!this.isValidReport(data, method, date)) {
      throw new MatomoReportError(
        source,
        method,
        'invalid-response',
        undefined,
        url.host,
      );
    }
    return { data };
  }

  private isValidReport(
    data: unknown,
    method: string,
    range: string,
  ): data is Record<string, any> {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    const [start, end] = range.split(',');
    const firstDay = Date.parse(start);
    const lastDay = Date.parse(end);
    if (
      !Number.isFinite(firstDay) ||
      !Number.isFinite(lastDay) ||
      firstDay > lastDay
    )
      return false;
    for (let day = firstDay; day <= lastDay; day += 24 * 60 * 60 * 1000) {
      if (
        !Object.prototype.hasOwnProperty.call(
          data,
          new Date(day).toISOString().slice(0, 10),
        )
      )
        return false;
    }
    return Object.entries(data).every(([date, value]) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
      if (method === 'VisitsSummary.getVisits') {
        return (
          typeof value === 'number' && Number.isFinite(value) && value >= 0
        );
      }
      return (
        Array.isArray(value) &&
        value.every(
          (row) =>
            row &&
            typeof row === 'object' &&
            !Array.isArray(row) &&
            typeof row.label === 'string' &&
            (typeof row.nb_events === 'number' ||
              (typeof row.nb_events === 'string' &&
                row.nb_events.trim() !== '')) &&
            Number.isFinite(Number(row.nb_events)) &&
            Number(row.nb_events) >= 0,
        )
      );
    });
  }
}
