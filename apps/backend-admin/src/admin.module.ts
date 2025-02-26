import { Module } from '@nestjs/common';
import { User } from '@shared/entities/user.entity';
import { Thematique } from '@shared/entities/thematique.entity';
import { Usage } from '@shared/entities/usage.entity';
import { ZoneAlerte } from '@shared/entities/zone_alerte.entity';
import { Departement } from '@shared/entities/departement.entity';
import { BassinVersant } from '@shared/entities/bassin_versant.entity';
import { Region } from '@shared/entities/region.entity';
import {ConfigModule, ConfigService} from "@nestjs/config";

/**
 * Désactivé pour l'instant car au final pas utilisé
 * Pour le réactiver il suffit de réimporter AdminModule dans AppModule
 */

/**
 * On définit ici une fonction qui retourne la configuration d'AdminJS
 * en utilisant le ConfigService pour récupérer les variables d'environnement.
 */
const buildAdminOptions = (configService: ConfigService) => {
  const adminUser = configService.get<string>('ADMINJS_USER');
  const adminPassword = configService.get<string>('ADMINJS_PASSWORD');

  return {
    adminJsOptions: {
      rootPath: '/admin',
      resources: [
        User,
        Thematique,
        Usage,
        ZoneAlerte,
        Departement,
        BassinVersant,
        Region,
      ],
    },
    auth: {
      authenticate: async (email: string, password: string) => {
        if (email === adminUser && password === adminPassword) {
          return Promise.resolve({ email, password });
        }
        return null;
      },
      cookieName: 'adminjs',
      cookiePassword: 'secret',
    },
    sessionOptions: {
      resave: true,
      saveUninitialized: true,
      secret: 'secret',
    },
  };
};

@Module({
  imports: [
    ConfigModule,
    // AdminJS version 7 is ESM-only. In order to import it, you have to use dynamic imports.
    // @ts-ignore
    import('@adminjs/nestjs').then(async ({ AdminModule }) => {
      const { AdminJS } = await import('adminjs');
      const { Database, Resource } = await import('@adminjs/typeorm');
      AdminJS.registerAdapter({ Database, Resource });

      return AdminModule.createAdminAsync({
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: async (configService: ConfigService) => buildAdminOptions(configService),
      });
    }),
  ],
  controllers: [],
  providers: [],
  exports: [],
})
export class AdminModule {}
