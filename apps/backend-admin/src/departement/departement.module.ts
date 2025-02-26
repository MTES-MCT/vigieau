import { Module } from '@nestjs/common';
import { DepartementService } from './departement.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Departement } from '@shared/entities/departement.entity';
import { HttpModule } from '@nestjs/axios';
import { DepartementController } from './departement.controller';
import { AbonnementMailModule } from '../abonnement_mail/abonnement_mail.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Departement]),
    HttpModule,
    AbonnementMailModule
  ],
  providers: [DepartementService],
  exports: [DepartementService],
  controllers: [DepartementController],
})
export class DepartementModule {}
