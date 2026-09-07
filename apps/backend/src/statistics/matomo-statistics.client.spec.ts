import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import {
  MatomoReportError,
  MatomoStatisticsClient,
} from './matomo-statistics.client';

describe('MatomoStatisticsClient', () => {
  const range = '2026-09-06,2026-09-07';
  const visits = { '2026-09-06': 12, '2026-09-07': 0 };
  let client: MatomoStatisticsClient;
  let post: jest.Mock;
  let configuration: Record<string, string>;

  beforeEach(() => {
    configuration = {
      MATOMO_URL: 'https://current.example.test/index.php',
      MATOMO_API_KEY: 'current-secret',
      MATOMO_ID_SITE: '70',
      OLD_MATOMO_URL: 'https://legacy.example.test/',
      OLD_MATOMO_API_KEY: 'legacy-secret',
      OLD_MATOMO_ID_SITE: '285',
    };
    post = jest.fn().mockReturnValue(of({ data: visits }));
    client = new MatomoStatisticsClient(
      { post } as unknown as HttpService,
      { get: (key: string) => configuration[key] } as ConfigService,
    );
  });

  it('sends credentials only in the POST body, with bounded timeout and no redirects', async () => {
    await expect(
      client.getReport('current', 'VisitsSummary.getVisits', range),
    ).resolves.toEqual({ data: visits });
    const [url, body, options] = post.mock.calls[0];
    expect(url).toBe('https://current.example.test/index.php');
    expect(url).not.toContain('secret');
    expect(new URLSearchParams(body).get('token_auth')).toBe('current-secret');
    expect(new URLSearchParams(body).get('idSite')).toBe('70');
    expect(options).toMatchObject({ timeout: 10_000, maxRedirects: 0 });
  });

  it.each([
    [401, undefined, 'authentication'],
    [403, undefined, 'authentication'],
    [500, undefined, 'http'],
    [undefined, 'ECONNABORTED', 'timeout'],
    [undefined, 'ETIMEDOUT', 'timeout'],
    [undefined, 'ECONNREFUSED', 'network'],
  ])(
    'classifies status %s/code %s without retaining Axios secrets',
    async (status, code, kind) => {
      post.mockReturnValue(
        throwError(() => ({
          response: { status },
          code,
          message: 'url?token_auth=legacy-secret',
          config: { data: 'token_auth=legacy-secret' },
        })),
      );
      const error = await client
        .getReport('legacy', 'VisitsSummary.getVisits', range)
        .catch((error) => error);
      expect(error).toBeInstanceOf(MatomoReportError);
      expect(error).toMatchObject({
        source: 'legacy',
        report: 'VisitsSummary.getVisits',
        kind,
        status,
        host: 'legacy.example.test',
      });
      expect(JSON.stringify(error)).not.toContain('legacy-secret');
      expect(error.cause).toBeUndefined();
      expect(post).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    null,
    [],
    'not JSON',
    {},
    { result: 'error', message: 'Authentication failed for token secret' },
    { '2026-09-06': 12 },
    { '2026-09-06': 12, '2026-09-07': 'invalid' },
  ])(
    'rejects an invalid or incomplete response %j instead of inventing zeroes',
    async (data) => {
      post.mockReturnValue(of({ data }));
      await expect(
        client.getReport('current', 'VisitsSummary.getVisits', range),
      ).rejects.toMatchObject({ kind: 'invalid-response' });
    },
  );

  it('accepts empty event arrays as actual zero measurements', async () => {
    const data = {
      '2026-09-06': [{ label: 'CODE INSEE', nb_events: 3 }],
      '2026-09-07': [],
    };
    post.mockReturnValue(of({ data }));
    await expect(
      client.getReport('legacy', 'Events.getActionFromCategoryId', range, '1'),
    ).resolves.toEqual({ data });
    expect(new URLSearchParams(post.mock.calls[0][1]).get('idSubtable')).toBe(
      '1',
    );
  });

  it.each([null, undefined, '', ' ', false, true, -1, 'invalid'])(
    'does not coerce an invalid event count %j into a measurement',
    async (count) => {
      post.mockReturnValue(
        of({
          data: {
            '2026-09-06': [{ label: 'CODE INSEE', nb_events: count }],
            '2026-09-07': [],
          },
        }),
      );
      await expect(
        client.getReport(
          'current',
          'Events.getActionFromCategoryId',
          range,
          '1',
        ),
      ).rejects.toMatchObject({ kind: 'invalid-response' });
    },
  );

  it('rejects missing legacy configuration before sending a request', async () => {
    delete configuration.OLD_MATOMO_API_KEY;
    await expect(
      client.getReport('legacy', 'VisitsSummary.getVisits', range),
    ).rejects.toMatchObject({ kind: 'configuration' });
    expect(post).not.toHaveBeenCalled();
  });

  it('changes its opaque fingerprint when credentials change', () => {
    const initial = client.configurationFingerprint();
    expect(initial).toMatch(/^[a-f0-9]{64}$/);
    expect(initial).not.toContain('secret');
    configuration.OLD_MATOMO_API_KEY = 'repaired-secret';
    expect(client.configurationFingerprint()).not.toBe(initial);
  });
});
