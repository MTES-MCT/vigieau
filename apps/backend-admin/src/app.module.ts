import { Module } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { HealthModule } from './health/health.module';
import { ArreteCadreModule } from './arrete_cadre/arrete_cadre.module';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Session } from './core/entities/session.entity';
import { UserModule } from './user/user.module';
import { ZoneAlerteModule } from './zone_alerte/zone_alerte.module';
import { DataSource } from 'typeorm';
import { Region } from './core/entities/region.entity';
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


@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    TypeOrmModule.forRootAsync(<any> {
      useFactory: () => ({
        type: 'postgres',
        url: `postgres://${process.env.DATABASE_USER}:${
          process.env.DATABASE_PASSWORD
        }@${process.env.DATABASE_HOST}:${process.env.DATABASE_PORT}/${
          process.env.DATABASE_NAME
        }?${process.env.DATABASE_SSL_CERT ? 'sslmode=require' : ''}`,
        entities: [`${__dirname}/**/*.entity{.ts,.js}`],
        logging: ['error', 'schema'],
        migrations: [`${__dirname}/migrations/**/*{.ts,.js}`],
        cli: {
          migrationsDir: 'src/migrations',
        },
        synchronize: false,
        // maxQueryExecutionTime: 1000,
        ssl: process.env.NODE_ENV !== 'local',
        extra:
          process.env.NODE_ENV !== 'local'
            ? {
              ssl: {
                rejectUnauthorized: false,
              },
            }
            : {},
      }),
      dataSourceFactory: async (options) => {
        const dataSource = await new DataSource(options).initialize();
        await dataSource.synchronize();
        await dataSource.runMigrations();
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
    ScheduleModule.forRoot(),
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
    ConfigModule,
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
