import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Request, RequestHandler } from 'express';
import { VigieauLogger } from '../../logger/vigieau.logger';

type FailureLogger = Pick<VigieauLogger, 'error' | 'warn'>;

const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizedRoute(request: Request): string {
  // Express supplies the registered template, never interpolate request params.
  // Parser/middleware failures may happen before a route has been selected.
  return typeof request.route?.path === 'string'
    ? request.route.path
    : '<unmatched>';
}

export function createHttpFailureLoggingMiddleware(
  logger: FailureLogger = new VigieauLogger('HttpFailureLogger'),
): RequestHandler {
  return (request, response, next) => {
    const startedAt = performance.now();
    const incomingRequestId = request.headers['x-request-id'];
    const requestId =
      typeof incomingRequestId === 'string' &&
      requestIdPattern.test(incomingRequestId)
        ? incomingRequestId
        : randomUUID();
    response.locals.httpRequestId = requestId;
    let recorded = false;

    const record = (event: string, statusCode: number | null) => ({
      event,
      requestId,
      method: /^[A-Z]{1,16}$/.test(request.method) ? request.method : 'UNKNOWN',
      route: normalizedRoute(request),
      statusCode,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    });

    const onFinish = () => {
      if (recorded) return;
      recorded = true;
      response.removeListener('close', onClose);
      if (response.statusCode >= 500 && response.statusCode <= 599) {
        logger.error(
          JSON.stringify(record('http_5xx', response.statusCode)),
          '',
        );
      }
    };

    const onClose = () => {
      if (recorded) return;
      if (response.writableFinished) {
        onFinish();
        return;
      }
      recorded = true;
      response.removeListener('finish', onFinish);
      logger.warn(
        JSON.stringify(
          record(
            'http_request_aborted',
            response.headersSent ? response.statusCode : null,
          ),
        ),
      );
    };

    response.once('finish', onFinish);
    response.once('close', onClose);
    next();
  };
}
