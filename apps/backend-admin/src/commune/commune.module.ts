import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';
import { Commune } from '@shared/entities/commune.entity';
import { DepartementModule } from '../departement/departement.module';
import { CommuneService } from './commune.service';
import { CommuneController } from './commune.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Commune]), HttpModule, DepartementModule],
  providers: [CommuneService],
  exports: [CommuneService],
  controllers: [CommuneController],
})
export class CommuneModule {}
