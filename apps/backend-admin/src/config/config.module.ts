import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Config } from '@shared/entities/config.entity';
import { ConfigService } from './config.service';

@Module({
  imports: [TypeOrmModule.forFeature([Config])],
  providers: [ConfigService],
  exports: [ConfigService],
  controllers: [],
})
export class ConfigModule {}