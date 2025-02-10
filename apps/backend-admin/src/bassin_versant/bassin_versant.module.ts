import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BassinVersant } from './entities/bassin_versant.entity';
import { BassinVersantService } from './bassin_versant.service';

@Module({
  imports: [TypeOrmModule.forFeature([BassinVersant])],
  providers: [BassinVersantService],
  exports: [BassinVersantService],
  controllers: [],
})
export class BassinVersantModule {}
