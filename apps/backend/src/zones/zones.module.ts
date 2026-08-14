import { Module } from '@nestjs/common';
import { ZonesService } from './zones.service';
import { ZonesController } from './zones.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Restriction } from '@shared/entities/restriction.entity';
import { Usage } from '@shared/entities/usage.entity';
import { Thematique } from '@shared/entities/thematique.entity';
import { ArreteCadre } from '@shared/entities/arrete_cadre.entity';
import { Fichier } from '@shared/entities/fichier.entity';
import { ZoneAlerteComputed } from '@shared/entities/zone_alerte_computed.entity';
import { DepartementsModule } from '../departements/departements.module';
import { DataModule } from '../data/data.module';
import { StatisticsModule } from '../statistics/statistics.module';
import { ArreteMunicipal } from '@shared/entities/arrete_municipal.entity';
import { CommunesModule } from '../communes/communes.module';
import { Config } from '@shared/entities/config.entity';
import { ZonePublication } from '@shared/entities/zone_publication.entity';
import { ZonePublicationZone } from '@shared/entities/zone_publication_zone.entity';
import { ZonePublicationCommune } from '@shared/entities/zone_publication_commune.entity';
import { ZonePublicationState } from '@shared/entities/zone_publication_state.entity';
import { ZonePublicationInstance } from '@shared/entities/zone_publication_instance.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ZoneAlerteComputed,
      Restriction,
      Usage,
      Thematique,
      ArreteCadre,
      Fichier,
      ArreteMunicipal,
      Config,
      ZonePublication,
      ZonePublicationZone,
      ZonePublicationCommune,
      ZonePublicationState,
      ZonePublicationInstance,
    ]),
    DepartementsModule,
    DataModule,
    StatisticsModule,
    CommunesModule,
  ],
  controllers: [ZonesController],
  providers: [ZonesService],
  exports: [ZonesService],
})
export class ZonesModule {}
