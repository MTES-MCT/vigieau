import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';

import { LoginGuard } from './login.guard';
import { Issuer } from 'openid-client';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserService } from '../user/user.service';
import { AuthGuard } from '@nestjs/passport';
import { DevGuard } from '../core/guards/dev.guard';

@Controller('auth')
@ApiTags('Authentification')
export class AuthController {
  constructor(
    private readonly configService: ConfigService,
    private readonly userService: UserService,
  ) {}

  @UseGuards(LoginGuard)
  @Get('/login')
  @ApiOperation({ summary: 'OAuth - Login' })
  login() {}

  @Get('/login/dev/:email')
  @UseGuards(DevGuard)
  @UseGuards(AuthGuard('local'))
  @ApiOperation({ summary: 'Bypass Login pour le développement' })
  async loginDev(@Req() req, @Res() res: Response) {
    // Ajout de l'utilisateur avec ses droits dans la session
    req.session.user = req.user;
    res.redirect(this.configService.get('WEBSITE_URL'));
  }

  @UseGuards(LoginGuard)
  @Get('/callback')
  @ApiOperation({ summary: 'OAuth - Callback' })
  async loginCallback(@Req() req, @Res() res: Response) {
    // Ajout de l'utilisateur avec ses droits dans la session
    req.session.user = await this.userService.findOne(req.user.userinfo.email);
    req.session.user.id_token = req.user.id_token;
    res.redirect(this.configService.get('WEBSITE_URL'));
  }

  @Get('/logout')
  @ApiOperation({ summary: 'OAuth - Logout' })
  async logout(@Req() req, @Res() res: Response, next) {
    const id_token = req.session.user ? req.session.user.id_token : undefined;
    res.clearCookie('regleau_session');
    req.logout((err) => {
      if (err) {
        return next(err);
      }
      req.session.destroy(async () => {
        const TrustIssuer = await Issuer.discover(
          `${this.configService.get(
            'OAUTH2_CLIENT_PROVIDER_OIDC_ISSUER',
          )}/.well-known/openid-configuration`,
        );
        const end_session_endpoint = TrustIssuer.metadata.end_session_endpoint;
        if (end_session_endpoint && id_token) {
          res.redirect(
            end_session_endpoint +
              '?post_logout_redirect_uri=' +
              this.configService.get('WEBSITE_URL') +
              '&id_token_hint=' +
              id_token,
          );
        } else {
          res.redirect(this.configService.get('WEBSITE_URL'));
        }
      });
    });
  }
}
