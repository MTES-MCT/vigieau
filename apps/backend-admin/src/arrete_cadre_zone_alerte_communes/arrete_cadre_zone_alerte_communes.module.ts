import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArreteCadreZoneAlerteCommunes } from '@shared/entities/arrete_cadre_zone_alerte_communes.entity';
import { ArreteCadreZoneAlerteCommunesService } from './arrete_cadre_zone_alerte_communes.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ArreteCadreZoneAlerteCommunes]),
  ],
  providers: [ArreteCadreZoneAlerteCommunesService],
  exports: [ArreteCadreZoneAlerteCommunesService],
})
export class ArreteCadreZoneAlerteCommunesModule {
}