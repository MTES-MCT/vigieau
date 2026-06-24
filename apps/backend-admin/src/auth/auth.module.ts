// src/auth/auth.module.ts
import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { OidcStrategy, buildOpenIdClient } from './oidc.strategy';
import { SessionSerializer } from './session.serializer';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UserService } from '../user/user.service';
import { UserModule } from '../user/user.module';
import { LocalStrategy } from './local.strategy';
import { CommuneModule } from '../commune/commune.module';
import { CommuneService } from '../commune/commune.service';
import { ConfigService } from '@nestjs/config';

const isAbsoluteUrl = (value?: string): boolean => {
  if (!value) {
    return false;
  }

  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
};

const OidcStrategyFactory = {
  inject: [UserService, CommuneService, ConfigService],
  provide: 'OidcStrategy',
  useFactory: async (
    userService: UserService,
    communeService: CommuneService,
    configService: ConfigService,
  ) => {
    const nodeEnv = configService.get<string>('NODE_ENV');
    const issuer = configService.get<string>(
      'OAUTH2_CLIENT_PROVIDER_OIDC_ISSUER',
    );

    if (!isAbsoluteUrl(issuer)) {
      if (nodeEnv === 'local') {
        console.warn(
          '[AuthModule] OIDC désactivé en local : OAUTH2_CLIENT_PROVIDER_OIDC_ISSUER est vide ou invalide.',
        );

        return null;
      }

      throw new Error(
        'OAUTH2_CLIENT_PROVIDER_OIDC_ISSUER doit être une URL absolue, par exemple https://example.com',
      );
    }

    const client = await buildOpenIdClient(configService);

    return new OidcStrategy(userService, communeService, configService, client);
  },
};

@Module({
  imports: [
    PassportModule.register({
      session: null,
      defaultStrategy: null,
      property: null,
    }),
    UserModule,
    CommuneModule,
  ],
  controllers: [AuthController],
  providers: [
    OidcStrategyFactory,
    SessionSerializer,
    AuthService,
    LocalStrategy,
  ],
})
export class AuthModule {}
