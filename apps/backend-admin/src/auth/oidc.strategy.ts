import { UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import {
  Strategy,
  Client,
  UserinfoResponse,
  TokenSet,
  Issuer,
  generators,
} from 'openid-client';
import { UserService } from '../user/user.service';
import random = generators.random;
import { RegleauLogger } from '../logger/regleau.logger';
import { CommuneService } from '../commune/commune.service';
import { Commune } from '../commune/entities/commune.entity';

export const buildOpenIdClient = async () => {
  const TrustIssuer = await Issuer.discover(
    `${process.env.OAUTH2_CLIENT_PROVIDER_OIDC_ISSUER}/.well-known/openid-configuration`,
  );
  const client = new TrustIssuer.Client({
    client_id: process.env.OAUTH2_CLIENT_REGISTRATION_LOGIN_CLIENT_ID,
    client_secret: process.env.OAUTH2_CLIENT_REGISTRATION_LOGIN_CLIENT_SECRET,
    acr_values: TrustIssuer.acr_values_supported,
    response_type: 'code',
    userinfo_signed_response_alg: 'HS256',
    id_token_signed_response_alg: 'HS256',
  });
  return client;
};

export class OidcStrategy extends PassportStrategy(Strategy, 'oidc') {
  private readonly _logger = new RegleauLogger('OidcStrategy');

  client: Client;

  constructor(
    private readonly userService: UserService,
    private readonly communeService: CommuneService,
    client: Client,
  ) {
    super({
      client: client,
      params: {
        redirect_uri: process.env.OAUTH2_CLIENT_REGISTRATION_LOGIN_REDIRECT_URI,
        scope: process.env.OAUTH2_CLIENT_REGISTRATION_LOGIN_SCOPE,
        acr_values: client.acr_values,
      },
      usePKCE: false,
    });

    this.client = client;
  }

  async authenticate(req, options: any = {}) {
    options.nonce = random();
    super.authenticate(req, options);
  }

  async validate(tokenset: TokenSet): Promise<any> {
    const userinfo: UserinfoResponse = await this.client.userinfo(tokenset);
    let userInDb = await this.userService.findOne(<string> userinfo?.email);

    /**
     * Si l'utilisateur n'existe pas en BDD, on vérifie son numéro SIREN associé afin d'associer sa commune
     * Si il y a une commune associée à un numéro SIREN, on crée l'utilisateur automatiquement
     */
    if (!userInDb && userinfo.siret) {
      const commune: Commune = await this.communeService.findBySiren((<string>userinfo.siret).substring(0, 9));
      if (commune) {
        const userToCreate = {
          email: userinfo.email.toLowerCase(),
          role: 'commune',
          role_communes: [commune.code],
        };
        // @ts-ignore
        userInDb = await this.userService.create({ role: 'mte' }, userToCreate);
      }
    }
    if (!userInDb) {
      this._logger.error('ERROR LOGIN VALIDATE - USER NOT IN DB -', JSON.stringify(userinfo));
      throw new UnauthorizedException();
    }

    await this.userService.updateName(
      <string> userinfo.email,
      <string>userinfo.given_name,
      <string>userinfo.usual_name,
    );

    try {
      const id_token = tokenset.id_token;
      const access_token = tokenset.access_token;
      const refresh_token = tokenset.refresh_token;
      const user = {
        id_token,
        access_token,
        refresh_token,
        userinfo,
      };
      return user;
    } catch (err) {
      throw new UnauthorizedException();
    }
  }
}
