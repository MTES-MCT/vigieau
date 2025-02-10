import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { RegleauLogger } from '../logger/regleau.logger';

@Injectable()
export class LoginGuard extends AuthGuard('oidc') {
  private readonly _logger = new RegleauLogger('LoginGuard');

  constructor(private readonly configService: ConfigService) {
    super();
  }

  async canActivate(context: ExecutionContext) {
    try {
      const result = (await super.canActivate(context)) as boolean;
      const request = context.switchToHttp().getRequest();
      await super.logIn(request);
      return result;
    } catch (e) {
      this._logger.error('ERROR LOGIN', e);
      const response = context.switchToHttp().getResponse();
      response.redirect(
        this.configService.get('WEBSITE_URL') + '?error=unauthorized',
      );
    }
  }
}
