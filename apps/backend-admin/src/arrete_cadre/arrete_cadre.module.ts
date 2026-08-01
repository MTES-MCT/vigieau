import { forwardRef, Module } from '@nestjs/common';
import { ArreteCadreService } from './arrete_cadre.service';
import { ArreteCadreController } from './arrete_cadre.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArreteCadre } from '@shared/entities/arrete_cadre.entity';
import { ArreteRestrictionModule } from '../arrete_restriction/arrete_restriction.module';
import { SharedModule } from '../shared/shared.module';
import { DepartementModule } from '../departement/departement.module';
import { ZoneAlerteModule } from '../zone_alerte/zone_alerte.module';
import { UserModule } from '../user/user.module';
import { FichierModule } from '../fichier/fichier.module';
import { RestrictionModule } from '../restriction/restriction.module';
import { UsageModule } from '../usage/usage.module';
import { ArreteCadreZoneAlerteCommunesModule } from '../arrete_cadre_zone_alerte_communes/arrete_cadre_zone_alerte_communes.module';
import { ExternalPublicationRegistryService } from '../datagouv/external-publication-registry.service';
import { ZonePublicationModule } from '../zone_publication/zone_publication.module';
import { ArreteCadreScheduler } from './arrete_cadre.scheduler';

@Module({
  imports: [
    TypeOrmModule.forFeature([ArreteCadre]),
    forwardRef(() => ArreteRestrictionModule),
    SharedModule,
    DepartementModule,
    forwardRef(() => ZoneAlerteModule),
    UserModule,
    FichierModule,
    RestrictionModule,
    UsageModule,
    ArreteCadreZoneAlerteCommunesModule,
    ZonePublicationModule,
  ],
  controllers: [ArreteCadreController],
  providers: [
    ArreteCadreService,
    ArreteCadreScheduler,
    ExternalPublicationRegistryService,
  ],
  exports: [ArreteCadreService],
})
export class ArreteCadreModule {}
