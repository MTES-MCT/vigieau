import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { LoggerModule } from './logger/logger.module';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerInterceptor } from './core/interceptor/logger.interceptor';
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
import path from 'path';
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup';
import { HealthModule } from './health/health.module';
import {
  createDatabaseDataSource,
  createDatabaseOptions,
} from './database-options';

const isSentryEnabled = () => Boolean(process.env.SENTRY_DSN?.trim());

@Module({
  imports: [
    ...(isSentryEnabled() ? [SentryModule.forRoot()] : []),
    ConfigModule.forRoot({
      envFilePath: path.resolve(__dirname, '../../../../.env'),
      isGlobal: true,
    }),
    TypeOrmModule.forRootAsync(<TypeOrmModuleAsyncOptions>{
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: createDatabaseOptions,
      dataSourceFactory: createDatabaseDataSource,
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
    HealthModule,
  ],
  controllers: [AppController],
  providers: [
    ...(isSentryEnabled()
      ? [
          {
            provide: APP_FILTER,
            useClass: SentryGlobalFilter,
          },
        ]
      : []),
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
export class AppModule {}
