import { Module } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { HealthModule } from './health/health.module';
import { ArreteCadreModule } from './arrete_cadre/arrete_cadre.module';
import { AuthModule } from './auth/auth.module';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Session } from '@shared/entities/session.entity';
import { UserModule } from './user/user.module';
import { ZoneAlerteModule } from './zone_alerte/zone_alerte.module';
import { DataSource, QueryRunner } from 'typeorm';
import { Region } from '@shared/entities/region.entity';
import { ScheduleModule } from '@nestjs/schedule';
import { DepartementModule } from './departement/departement.module';
import { UsageModule } from './usage/usage.module';
import { ThematiqueModule } from './thematique/thematique.module';
import { ArreteRestrictionModule } from './arrete_restriction/arrete_restriction.module';
import { AppController } from './app.controller';
import { LoggerModule } from './logger/logger.module';
import { LoggerInterceptor } from './core/interceptor/logger.interceptor';
import { SharedModule } from './shared/shared.module';
import { CommuneModule } from './commune/commune.module';
import { RestrictionModule } from './restriction/restriction.module';
import { BassinVersantModule } from './bassin_versant/bassin_versant.module';
import { DatagouvModule } from './datagouv/datagouv.module';
import { StatisticCommuneModule } from './statistic_commune/statistic_commune.module';
import { StatisticDepartementModule } from './statistic_departement/statistic_departement.module';
import { FichierModule } from './fichier/fichier.module';
import { ParametresModule } from './parametres/parametres.module';
import { ZoneAlerteComputedModule } from './zone_alerte_computed/zone_alerte_computed.module';
import { UsageFeedbackModule } from './usage_feedback/usage_feedback.module';
import { StatisticModule } from './statistic/statistic.module';
import { ArreteMunicipalModule } from './arrete_municipal/arrete_municipal.module';
import { AbonnementMailModule } from './abonnement_mail/abonnement_mail.module';
import * as path from 'path';
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup';

const isSentryEnabled = () => Boolean(process.env.SENTRY_DSN?.trim());
const scheduledJobsEnabled =
  process.env.DISABLE_SCHEDULED_JOBS?.trim() !== 'true';
const SCHEMA_BOOTSTRAP_LOCK_TIMEOUT_MS = 10 * 60 * 1000;

async function acquireSchemaBootstrapLock(
  dataSource: DataSource,
): Promise<QueryRunner> {
  const deadline = Date.now() + SCHEMA_BOOTSTRAP_LOCK_TIMEOUT_MS;
  while (true) {
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      const [lockResult] = await queryRunner.query(
        "SELECT pg_try_advisory_lock(hashtext('vigieau'), hashtext('schema-bootstrap')) AS locked",
      );
      if (lockResult?.locked === true) {
        return queryRunner;
      }
    } catch (error) {
      await queryRunner.release();
      throw error;
    }
    await queryRunner.release();
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the schema bootstrap lock');
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

@Module({
  imports: [
    ...(isSentryEnabled() ? [SentryModule.forRoot()] : []),
    ConfigModule.forRoot({
      envFilePath: path.resolve(__dirname, '../../../../.env'),
      isGlobal: true,
    }),
    TypeOrmModule.forRootAsync(<any>{
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
      dataSourceFactory: async (options) => {
        const dataSource = await new DataSource(options).initialize();
        if (process.env.SKIP_SCHEMA_BOOTSTRAP?.trim() !== 'true') {
          const queryRunner = await acquireSchemaBootstrapLock(dataSource);
          try {
            await dataSource.synchronize();
            await dataSource.runMigrations();
          } finally {
            try {
              const [unlockResult] = await queryRunner.query(
                "SELECT pg_advisory_unlock(hashtext('vigieau'), hashtext('schema-bootstrap'))",
              );
              if (unlockResult?.pg_advisory_unlock !== true) {
                throw new Error('Unable to release the schema bootstrap lock');
              }
            } finally {
              await queryRunner.release();
            }
          }
        }
        return dataSource;
      },
    }),
    TypeOrmModule.forFeature([Session, Region]),
    // Rate limit, 300 requêtes maximum toutes les 15min par IP
    ThrottlerModule.forRoot([
      {
        ttl: 60 * 15,
        limit: 300,
      },
    ]),
    HealthModule,
    ArreteCadreModule,
    AuthModule,
    UserModule,
    ZoneAlerteModule,
    ...(scheduledJobsEnabled ? [ScheduleModule.forRoot()] : []),
    DepartementModule,
    UsageModule,
    ThematiqueModule,
    ArreteRestrictionModule,
    LoggerModule,
    SharedModule,
    CommuneModule,
    RestrictionModule,
    BassinVersantModule,
    DatagouvModule,
    StatisticCommuneModule,
    StatisticDepartementModule,
    FichierModule,
    ParametresModule,
    ZoneAlerteComputedModule,
    UsageFeedbackModule,
    StatisticModule,
    ArreteMunicipalModule,
    AbonnementMailModule,
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
