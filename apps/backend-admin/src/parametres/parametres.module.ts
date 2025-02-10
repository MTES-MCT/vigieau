import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Parametres } from './entities/parametres.entity';
import { ParametresController } from './parametres.controller';
import { ParametresService } from './parametres.service';
import { DepartementModule } from '../departement/departement.module';

@Module({
  imports: [TypeOrmModule.forFeature([Parametres]), DepartementModule],
  providers: [ParametresService],
  exports: [],
  controllers: [ParametresController],
})
export class ParametresModule {
}
