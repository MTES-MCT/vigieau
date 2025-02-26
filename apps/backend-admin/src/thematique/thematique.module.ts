import { Module } from '@nestjs/common';
import { ThematiqueService } from './thematique.service';
import { ThematiqueController } from './thematique.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Thematique } from '@shared/entities/thematique.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Thematique])],
  controllers: [ThematiqueController],
  providers: [ThematiqueService],
})
export class ThematiqueModule {}
