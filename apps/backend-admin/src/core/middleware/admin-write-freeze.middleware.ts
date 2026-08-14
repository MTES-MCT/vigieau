import { NextFunction, Request, Response } from 'express';

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const OPERATOR_WRITE_PATHS = new Set(['/api/zone-publication/rollback']);

export function areAdminWritesDisabled(
  method: string,
  value = process.env.ADMIN_WRITES_DISABLED,
  path = '',
): boolean {
  return (
    value?.trim().toLowerCase() === 'true' &&
    !READ_ONLY_METHODS.has(method.toUpperCase()) &&
    !OPERATOR_WRITE_PATHS.has(path)
  );
}

export function adminWriteFreezeMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (!areAdminWritesDisabled(request.method, undefined, request.path)) {
    next();
    return;
  }

  const retryAfter = Math.max(
    60,
    Number(process.env.ADMIN_WRITES_RETRY_AFTER_SECONDS || 3600) || 3600,
  );
  response.setHeader('Retry-After', String(retryAfter));
  response.status(503).json({
    statusCode: 503,
    code: 'ADMIN_WRITES_DISABLED',
    message: 'Les écritures administratives sont temporairement suspendues.',
  });
}
