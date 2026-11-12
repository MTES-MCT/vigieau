import { EventEmitter } from 'node:events';
import { AuditMiddleware } from './audit.middleware';
import { getAuditContext, setAuditActor } from './audit-context';
import { sanitizeAuditMetadata } from './audit.service';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const actor = {
  audit_id: '6a26308e-ef0d-44de-a9b0-3de6b8db9791',
  email: 'agent@example.test',
  role: 'mte',
  id_token: 'must-never-leak',
};

function harness() {
  const audit = {
    recordEvent: jest.fn(async () => 'event'),
    recordBestEffort: jest.fn(async () => 'event'),
    reportFailure: jest.fn(),
  };
  const dataSource = { query: jest.fn(async () => [actor]) };
  const res: any = new EventEmitter();
  res.statusCode = 200;
  res.end = jest.fn(function () {
    this.writableEnded = true;
    return this;
  });
  res.status = (status: number) => {
    res.statusCode = status;
    return res;
  };
  res.json = function (body: unknown) {
    this.payload = body;
    this.end();
    return this;
  };
  return {
    audit,
    dataSource,
    res,
    middleware: new AuditMiddleware(audit as any, dataSource as any),
  };
}

describe('audit request lifecycle', () => {
  beforeEach(() => {
    process.env.AUDIT_ENABLED = 'true';
  });
  afterEach(() => {
    delete process.env.AUDIT_ENABLED;
  });

  it('blocks a mutation before the controller when the initial durable trace fails', async () => {
    const h = harness();
    h.audit.recordEvent.mockRejectedValueOnce(new Error('contains-secret'));
    const next = jest.fn();
    await h.middleware.use(
      {
        method: 'PATCH',
        path: '/api/user/target@example.test',
        session: { user: actor },
      },
      h.res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(h.res.statusCode).toBe(503);
    expect(JSON.stringify(h.res.payload)).not.toContain('contains-secret');
  });

  it('refuses reads when current permissions cannot be verified instead of trusting a stale MTE session', async () => {
    const h = harness();
    h.dataSource.query.mockRejectedValueOnce(new Error('database down'));
    const next = jest.fn();
    await h.middleware.use(
      { method: 'GET', path: '/api/arrete-cadre/42', session: { user: actor } },
      h.res,
      next,
    );
    await flush();
    expect(next).not.toHaveBeenCalled();
    expect(h.res.statusCode).toBe(503);
    expect(h.res.payload.code).toBe('AUTHORIZATION_UNAVAILABLE');
  });

  it('keeps an authorized read available when only writing the journal fails', async () => {
    const h = harness();
    h.audit.recordBestEffort.mockImplementationOnce(async () => {
      h.audit.reportFailure();
      return null;
    });
    await h.middleware.use(
      { method: 'GET', path: '/api/arrete-cadre/42', session: { user: actor } },
      h.res,
      () => h.res.json({ id: 42 }),
    );
    await flush();
    expect(h.res.statusCode).toBe(200);
    expect(h.res.writableEnded).toBe(true);
    expect(h.audit.reportFailure).toHaveBeenCalled();
  });

  it('records a guard refusal before the controller and excludes session credentials', async () => {
    const h = harness();
    await h.middleware.use(
      {
        method: 'DELETE',
        path: '/api/user/target@example.test',
        session: { user: actor },
      },
      h.res,
      () => {
        expect(getAuditContext()?.actor.email).toBe(actor.email);
        h.res.status(403).json({ message: 'denied' });
      },
    );
    await flush();
    expect(h.audit.recordBestEffort).toHaveBeenCalledWith(
      'denied',
      expect.objectContaining({ httpStatus: 403 }),
      expect.objectContaining({
        actor: expect.objectContaining({ email: actor.email }),
      }),
    );
    expect(JSON.stringify(h.audit.recordEvent.mock.calls)).not.toContain(
      'must-never-leak',
    );
    expect(getAuditContext()).toBeUndefined();
  });

  it('captures trusted callback identity after authentication and avoids duplicate finalization', async () => {
    const h = harness();
    await h.middleware.use(
      { method: 'GET', path: '/api/auth/callback', query: { code: 'secret' } },
      h.res,
      () => {
        setAuditActor(actor);
        h.res.statusCode = 302;
        h.res.end();
      },
    );
    await flush();
    h.res.emit('close');
    expect(h.audit.recordBestEffort).toHaveBeenCalledTimes(1);
    expect(h.audit.recordBestEffort).toHaveBeenCalledWith(
      'succeeded',
      expect.anything(),
      expect.anything(),
    );
    expect(JSON.stringify(h.audit.recordBestEffort.mock.calls)).not.toContain(
      'secret',
    );
  });

  it('stores bounded metadata without payloads, signed links, errors or tokens', () => {
    expect(
      sanitizeAuditMetadata({
        token: 'secret',
        url: 'https://bucket/?signature=secret',
        message: 'sensitive',
        body: { confidential: true },
        sha256: 'a'.repeat(64),
        size: 12,
        stage: 'antivirus',
        verdict: 'infected',
      }),
    ).toEqual({
      sha256: 'a'.repeat(64),
      size: 12,
      stage: 'antivirus',
      verdict: 'infected',
    });
  });

  it('identifies operator previews even when the optional apply flag is omitted', async () => {
    const h = harness();
    await h.middleware.use(
      {
        method: 'POST',
        path: '/api/zone-publication/rollback',
        body: {},
        session: { user: actor },
      },
      h.res,
      () => {
        expect(getAuditContext()?.metadata?.simulation).toBe(true);
        h.res.json({ ready: true });
      },
    );
    await flush();
  });
});
