import { Module } from '@nestjs/common';
import { FichierService } from './fichier.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Fichier } from '@shared/entities/fichier.entity';
import { SharedModule } from '../shared/shared.module';
import { HttpModule } from '@nestjs/axios';
import { AntivirusModule } from '../antivirus/antivirus.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Fichier]),
    SharedModule,
    HttpModule,
    AntivirusModule,
  ],
  controllers: [],
  providers: [FichierService],
  exports: [FichierService],
})
export class FichierModule {}
