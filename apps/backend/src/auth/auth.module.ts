import {Module} from '@nestjs/common';
import {JwtModule} from '@nestjs/jwt';
import JwtStrategy from './jwt.strategy';
import {PassportModule} from '@nestjs/passport';
import {ConfigModule, ConfigService} from "@nestjs/config";

@Module({
    imports: [
        PassportModule.register({defaultStrategy: 'jwt'}),
        JwtModule.registerAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: async (configService: ConfigService) => ({
                global: true,
                secret: configService.get<string>('JWT_SECRET'),
                signOptions: {expiresIn: '2d'},
            }),
        }),
    ],
    providers: [JwtStrategy],
    controllers: [],
    exports: [JwtModule],
})
export default class AuthModule {
}