import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { RegleauLogger } from '../../logger/regleau.logger';
import { randomUUID } from 'node:crypto';
import { getAuditContext } from '../../audit/audit-context';

@Injectable()
export class LoggerInterceptor implements NestInterceptor {
  private readonly _logger = new RegleauLogger('LoggerInterceptor');

  /**
   * Mise en forme des Logs de l'application
   * @param context
   * @param next
   */
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const id = getAuditContext()?.requestId ?? randomUUID();
    const req = context.getArgByIndex(0);
    this._logger.log(
      `REQUEST - ${id} - ${req.method} - ${req.route?.path ?? 'unmatched'}`,
    );

    return next.handle().pipe(
      tap(() => {
        this._logger.log(`RESPONSE - ${id}`);
      }),
    );
  }
}
