import { forwardRef, Module } from '@nestjs/common';
import { DatagouvService } from './datagouv.service';
import { ArreteRestrictionModule } from '../arrete_restriction/arrete_restriction.module';
import { HttpModule } from '@nestjs/axios';
import { ZoneAlerteComputedModule } from '../zone_alerte_computed/zone_alerte_computed.module';
import { SharedModule } from '../shared/shared.module';
import { ArreteCadreModule } from '../arrete_cadre/arrete_cadre.module';
import { DepartementModule } from '../departement/departement.module';
import { StatisticCommuneModule } from '../statistic_commune/statistic_commune.module';
import { DatagouvSchedulerService } from './datagouv-scheduler.service';
import { ExternalPublicationRegistryService } from './external-publication-registry.service';
import { ZonePublicationModule } from '../zone_publication/zone_publication.module';

@Module({
  imports: [
    forwardRef(() => ArreteRestrictionModule),
    forwardRef(() => ArreteCadreModule),
    HttpModule,
    forwardRef(() => ZoneAlerteComputedModule),
    SharedModule,
    DepartementModule,
    StatisticCommuneModule,
    ZonePublicationModule,
  ],
  controllers: [],
  providers: [
    DatagouvService,
    DatagouvSchedulerService,
    ExternalPublicationRegistryService,
  ],
  exports: [DatagouvService, ExternalPublicationRegistryService],
})
export class DatagouvModule {}
