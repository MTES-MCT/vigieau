import { forwardRef, Module } from '@nestjs/common';
import { ZoneAlerteService } from './zone_alerte.service';
import { ZoneAlerteController } from './zone_alerte.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ZoneAlerte } from '@shared/entities/zone_alerte.entity';
import { ArreteCadreModule } from '../arrete_cadre/arrete_cadre.module';
import { HttpModule } from '@nestjs/axios';
import { DepartementModule } from '../departement/departement.module';
import { BassinVersantModule } from '../bassin_versant/bassin_versant.module';
import { SharedModule } from '../shared/shared.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ZoneAlerte]),
    forwardRef(() => ArreteCadreModule),
    HttpModule,
    DepartementModule,
    BassinVersantModule,
    SharedModule,
  ],
  controllers: [ZoneAlerteController],
  providers: [ZoneAlerteService],
  exports: [ZoneAlerteService],
})
export class ZoneAlerteModule {}
