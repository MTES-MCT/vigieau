import { Module } from '@nestjs/common';
import { User } from './user/entities/user.entity';
import { Thematique } from './thematique/entities/thematique.entity';
import { Usage } from './usage/entities/usage.entity';
import { ZoneAlerte } from './zone_alerte/entities/zone_alerte.entity';
import { Departement } from './departement/entities/departement.entity';
import { BassinVersant } from './bassin_versant/entities/bassin_versant.entity';
import { Region } from './core/entities/region.entity';

/**
 * Désactivé pour l'instant car au final pas utilisé
 * Pour le réactiver il suffit de réimporter AdminModule dans AppModule
 */

const DEFAULT_ADMIN = {
  email: process.env.ADMINJS_USER,
  password: process.env.ADMINJS_PASSWORD,
};

const authenticate = async (email: string, password: string) => {
  if (email === DEFAULT_ADMIN.email && password === DEFAULT_ADMIN.password) {
    return Promise.resolve(DEFAULT_ADMIN);
  }
  return null;
};

@Module({
  imports: [
    // AdminJS version 7 is ESM-only. In order to import it, you have to use dynamic imports.
    // @ts-ignore
    import('@adminjs/nestjs').then(async ({ AdminModule }) => {
      const { AdminJS } = await import('adminjs');
      const { Database, Resource } = await import('@adminjs/typeorm');
      AdminJS.registerAdapter({ Database, Resource });

      return AdminModule.createAdminAsync({
        useFactory: () => ({
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
            authenticate,
            cookieName: 'adminjs',
            cookiePassword: 'secret',
          },
          sessionOptions: {
            resave: true,
            saveUninitialized: true,
            secret: 'secret',
          },
        }),
      });
    }),
  ],
  controllers: [],
  providers: [],
  exports: [],
})
export class AdminModule {}
