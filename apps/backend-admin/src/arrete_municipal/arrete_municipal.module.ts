import { Module } from '@nestjs/common';
import { ArreteMunicipalService } from './arrete_municipal.service';
import { ArreteMunicipalController } from './arrete_municipal.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArreteMunicipal } from '@shared/entities/arrete_municipal.entity';
import { FichierModule } from '../fichier/fichier.module';
import { CommuneModule } from '../commune/commune.module';
import { SharedModule } from '../shared/shared.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ArreteMunicipal]),
    FichierModule,
    CommuneModule,
    SharedModule
  ],
  controllers: [ArreteMunicipalController],
  providers: [ArreteMunicipalService],
})
export class ArreteMunicipalModule {}
