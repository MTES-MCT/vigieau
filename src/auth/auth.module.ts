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

const OidcStrategyFactory = {
  provide: 'OidcStrategy',
  useFactory: async (userService: UserService, communeService: CommuneService) => {
    const client = await buildOpenIdClient(); // secret sauce! build the dynamic client before injecting it into the strategy for use in the constructor super call.
    const strategy = new OidcStrategy(userService, communeService, client);
    return strategy;
  },
  inject: [UserService, CommuneService],
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
