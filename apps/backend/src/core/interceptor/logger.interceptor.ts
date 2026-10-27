import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  HttpException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { VigieauLogger } from '../../logger/vigieau.logger';
import { randomUUID } from 'crypto';
import * as Sentry from '@sentry/nestjs';

@Injectable()
export class LoggerInterceptor implements NestInterceptor {
  private readonly _logger = new VigieauLogger('LoggerInterceptor');

  /**
   * Intercepte les requêtes entrantes et leurs réponses pour les logger.
   *
   * @param context Le contexte d'exécution de la requête (NestJS).
   * @param next La chaîne de traitement suivante.
   * @returns Un Observable qui permet de continuer le traitement et de logger la réponse.
   */
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const response = context.switchToHttp().getResponse();
    const requestId = response.locals?.httpRequestId || randomUUID();
    const req = context.switchToHttp().getRequest();
    const { ip, method, originalUrl, body, headers, session } = req;

    // Formate les informations utilisateur et session
    const userEmail = session?.user?.email || 'Anonymous';
    const userAgent = headers['user-agent'] || 'Unknown';
    const hostname = headers.host || 'Unknown Host';

    // Log la requête entrante
    this._logger.log(
      `REQUEST - ID: ${requestId}, IP: ${ip}, User: ${userEmail}, Method: ${method}, URL: ${originalUrl}, Host: ${hostname}, UserAgent: ${userAgent}, Body: ${JSON.stringify(
        body || {},
      )}`,
    );

    // Intercepte et log la réponse
    return next.handle().pipe(
      tap({
        next: () => {
          this._logger.log(
            `RESPONSE - ID: ${requestId}, URL: ${originalUrl}, User: ${userEmail}`,
          );
        },
        error: (error: unknown) => {
          // The Nest Sentry filter skips HttpException, including explicit 5xx.
          // Health failures are already tracked by the production checks.
          if (!(error instanceof HttpException)) return;
          const status = error.getStatus();
          const route =
            typeof req.route?.path === 'string'
              ? req.route.path
              : '<unmatched>';
          if (
            status < 500 ||
            status > 599 ||
            /^\/api\/health(?:\/|$)/.test(route)
          ) {
            return;
          }
          const safeMethod = /^[A-Z]{1,16}$/.test(method) ? method : 'UNKNOWN';
          Sentry.withScope((scope) => {
            scope.setFingerprint([
              'http-server-error',
              safeMethod,
              route,
              String(status),
            ]);
            scope.setTags({
              component: 'http-server-error',
              route,
              method: safeMethod,
              status,
            });
            scope.setContext('httpFailure', { requestId, statusCode: status });
            scope.addEventProcessor((event) => {
              // Do not attach subscription addresses, credentials or request bodies.
              delete event.request;
              delete event.user;
              delete event.breadcrumbs;
              delete event.extra;
              return event;
            });
            Sentry.captureException(
              new Error(`HTTP ${status} ${safeMethod} ${route}`),
            );
          });
        },
      }),
    );
  }
}
