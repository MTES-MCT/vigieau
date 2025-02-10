import { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export class DevGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  /**
   * Route uniquement accessible pour les environnements hors production
   * @param context
   */
  canActivate(context: ExecutionContext): boolean {
    return ['dev', 'review', 'local'].includes(process.env.NODE_ENV);
  }
}
