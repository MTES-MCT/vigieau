import {CanActivate, ExecutionContext, Inject} from '@nestjs/common';
import {Reflector} from '@nestjs/core';
import {ConfigService} from "@nestjs/config";

export class DevGuard implements CanActivate {
    constructor(private readonly reflector: Reflector,
                @Inject(ConfigService) private readonly configService: ConfigService,) {
    }

    /**
     * Route uniquement accessible pour les environnements hors production
     * @param context
     */
    canActivate(context: ExecutionContext): boolean {
        const nodeEnv = this.configService.get<string>('NODE_ENV');
        return ['dev', 'review', 'local'].includes(nodeEnv);
    }
}
