import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AntivirusController } from './antivirus.controller';
import { AntivirusService } from './antivirus.service';

@Module({
  imports: [ConfigModule],
  controllers: [AntivirusController],
  providers: [AntivirusService],
  exports: [AntivirusService],
})
export class AntivirusModule {}
