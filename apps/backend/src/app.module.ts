import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { LoggerModule } from './logger/logger.module';
import {ConfigModule, ConfigService} from '@nestjs/config';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerInterceptor } from './core/interceptor/logger.interceptor';
import { DataSource } from 'typeorm';
import { TypeOrmModule, TypeOrmModuleAsyncOptions } from '@nestjs/typeorm';
import { ZonesModule } from './zones/zones.module';
import { DepartementsModule } from './departements/departements.module';
import { ScheduleModule } from '@nestjs/schedule';
import { StatisticsModule } from './statistics/statistics.module';
import { CronModule } from './cron/cron.module';
import { UsageModule } from './usage/usage.module';
import AuthModule from './auth/auth.module';
import { ArretesRestrictionsModule } from './arretes_restrictions/arretes_restrictions.module';
import { DataModule } from './data/data.module';
import path from "path";

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: path.resolve(__dirname, '../../../../.env'),
      isGlobal: true,
    }),
    TypeOrmModule.forRootAsync(<TypeOrmModuleAsyncOptions> {
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const user = configService.get<string>('DATABASE_USER');
        const password = configService.get<string>('DATABASE_PASSWORD');
        const host = configService.get<string>('DATABASE_HOST');
        const port = configService.get<string>('DATABASE_PORT');
        const dbName = configService.get<string>('DATABASE_NAME');
        const sslCert = configService.get('DATABASE_SSL_CERT'); // Peut être undefined
        const queryParam = sslCert ? 'sslmode=require' : '';
        const url = `postgres://${user}:${password}@${host}:${port}/${dbName}${queryParam ? '?' + queryParam : ''}`;

        return {
          type: 'postgres',
          url,
          entities: [`${__dirname}/../../../**/*.entity{.ts,.js}`],
          logging: ['error', 'schema'],
          migrations: [`${__dirname}/migrations/**/*{.ts,.js}`],
          cli: {
            migrationsDir: 'src/migrations',
          },
          synchronize: false,
          maxQueryExecutionTime: 1000,
          ssl: configService.get('NODE_ENV') !== 'local',
          extra:
              configService.get('NODE_ENV') !== 'local'
                  ? {
                    ssl: {
                      rejectUnauthorized: false,
                    },
                  }
                  : {},
        };
      },
      dataSourceFactory: (options) => {
        return new DataSource(options).initialize();
      },
    }),
    // Rate limit, 300 requêtes maximum toutes les 15min par IP
    ThrottlerModule.forRoot([
      {
        ttl: 60 * 15,
        limit: 300,
      },
    ]),
    LoggerModule,
    SubscriptionsModule,
    ZonesModule,
    DepartementsModule,
    ScheduleModule.forRoot(),
    AuthModule,
    StatisticsModule,
    CronModule,
    UsageModule,
    ArretesRestrictionsModule,
    DataModule,
  ],
  controllers: [AppController],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggerInterceptor,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {
}
